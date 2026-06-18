import "dotenv/config";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { activeAgent } from "./agent.js";
import { RealtimeBridge } from "./bridge.js";
import { registerRealtimeWeb } from "./realtime-web.js";
import { JsonlMessageStore } from "./lib/messageStore.js";
import { resolveHost, incomingCallTwiml } from "./twiml.js";
import { log } from "./lib/logger.js";

const logger = log("server");
const PORT = Number(process.env.PORT ?? 5050);
const DATA_FILE = process.env.MESSAGE_STORE_PATH ?? "./data/messages.jsonl";

const store = new JsonlMessageStore(DATA_FILE);

const app = Fastify();
await app.register(websocket);

// Accept the raw SDP offer body the browser posts (defaults to JSON otherwise).
app.addContentTypeParser(
  "application/sdp",
  { parseAs: "string" },
  (_req, body, done) => done(null, body)
);

// Browser web-demo routes (page + WebRTC SDP proxy), sharing the message store.
await registerRealtimeWeb(app, store);

/** Twilio voice webhook: returns TwiML that opens a Media Stream to /media. */
app.all("/incoming-call", async (request, reply) => {
  const host = resolveHost(request.headers as Record<string, unknown>);
  reply.header("Content-Type", "text/xml").send(incomingCallTwiml(host));
});

/** Liveness + a peek at the active agent. */
app.get("/health", async () => ({ status: "ok", agent: activeAgent.name }));

/** Inspect messages the agent has taken (handy for the demo and for ops). */
app.get("/messages", async () => {
  const messages = await store.list();
  return { count: messages.length, messages };
});

/**
 * Twilio Media Stream WebSocket — one connection per call. Spin up a
 * RealtimeBridge and relay frames between Twilio and OpenAI.
 */
app.register(async (instance) => {
  instance.get("/media", { websocket: true }, (socket) => {
    logger.info("call connected");

    const bridge = new RealtimeBridge(
      activeAgent,
      (msg) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      },
      { store, channel: "phone" },
      () => socket.close() // end_call tool → hang up the Twilio socket
    );

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
          bridge.setStreamSid(data.start.streamSid);
          logger.info("stream started", { streamSid: data.start.streamSid });
          break;
        case "media":
          bridge.appendCallerAudio(data.media.payload);
          break;
        case "stop":
          logger.info("stream stopped");
          bridge.close();
          break;
      }
    });

    socket.on("close", () => {
      logger.info("call disconnected");
      bridge.close();
    });
  });
});

// --- start + graceful shutdown ---------------------------------------------

try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info("listening", { port: PORT, agent: activeAgent.name });
} catch (err) {
  logger.error("failed to start", { err: String(err) });
  process.exit(1);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    logger.info("shutting down", { signal });
    await app.close();
    process.exit(0);
  });
}
