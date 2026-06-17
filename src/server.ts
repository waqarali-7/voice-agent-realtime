import "dotenv/config";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { activeAgent } from "./agent.js";
import { RealtimeBridge } from "./bridge.js";

const PORT = Number(process.env.PORT ?? 5050);

const app = Fastify();
await app.register(websocket);

/**
 * Twilio hits this when a call comes in. We return TwiML that tells Twilio to
 * open a Media Stream to our /media WebSocket. `{{HOST}}` is replaced with the
 * public host (your ngrok/Render URL) so Twilio knows where to connect.
 */
app.all("/incoming-call", async (request, reply) => {
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you now.</Say>
  <Connect>
    <Stream url="wss://${host}/media" />
  </Connect>
</Response>`;
  reply.header("Content-Type", "text/xml").send(twiml);
});

app.get("/health", async () => ({ status: "ok", agent: activeAgent.name }));

/**
 * Twilio Media Stream WebSocket. One connection per call. We spin up a
 * RealtimeBridge for the call and relay frames between Twilio and OpenAI.
 */
app.register(async (instance) => {
  instance.get("/media", { websocket: true }, (socket) => {
    console.log("[Twilio] call connected");

    const bridge = new RealtimeBridge(activeAgent, (msg) => {
      // Send a message back down the Twilio socket.
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    });

    bridge.connect();

    socket.on("message", (raw: Buffer) => {
      let data: any;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (data.event) {
        case "start":
          // Twilio tells us the streamSid we must tag outgoing audio with.
          bridge.setStreamSid(data.start.streamSid);
          console.log("[Twilio] stream started:", data.start.streamSid);
          break;

        case "media":
          // A frame of caller audio (base64 μ-law).
          bridge.appendCallerAudio(data.media.payload);
          break;

        case "stop":
          console.log("[Twilio] stream stopped");
          bridge.close();
          break;
      }
    });

    socket.on("close", () => {
      console.log("[Twilio] call disconnected");
      bridge.close();
    });
  });
});

try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Voice agent listening on :${PORT}`);
  console.log(`Agent persona: ${activeAgent.name}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
