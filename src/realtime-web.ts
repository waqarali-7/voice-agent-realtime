/**
 * realtime-web.ts
 *
 * Browser-facing routes for the web voice demo. Registered as a Fastify plugin
 * so it stays isolated from the Twilio bridge and is easy to mount/unmount.
 *
 * Design intent:
 *   - The browser talks ONLY to our origin. It never sees the OpenAI API key
 *     and never calls api.openai.com directly — we proxy the WebRTC SDP
 *     handshake server-side. This keeps the OpenAI surface (endpoint, key,
 *     model, headers) out of client code entirely.
 *   - The same agent persona drives web and phone, so there is one source of
 *     truth for Ava's behaviour (agent.ts).
 *
 * Routes:
 *   GET  /                 → serves the demo page
 *   POST /rtc/connect      → accepts the browser's SDP offer, performs the
 *                            OpenAI handshake server-side, returns the SDP
 *                            answer. No token is ever exposed to the client.
 */

import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { activeAgent } from "./agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const OPENAI_BASE = "https://api.openai.com/v1/realtime";
const MODEL = process.env.REALTIME_MODEL ?? "gpt-realtime-2";

/** Build the session config once; it's derived from the active agent. */
function sessionConfig() {
  return {
    type: "realtime",
    model: MODEL,
    instructions: activeAgent.instructions,
    audio: {
      input: {
        // Enable input transcription so the UI can show the caller's words.
        transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: { type: "server_vad" },
      },
      output: { voice: activeAgent.voice },
    },
  };
}

export async function registerRealtimeWeb(app: FastifyInstance): Promise<void> {
  // Cache the page in memory; re-read only in dev for live editing.
  let cachedPage: string | null = null;
  const pagePath = join(__dirname, "demo.html");
  const isDev = process.env.NODE_ENV !== "production";

  app.get("/", async (_req, reply) => {
    try {
      if (!cachedPage || isDev) cachedPage = await readFile(pagePath, "utf8");
      return reply.header("Content-Type", "text/html").send(cachedPage);
    } catch {
      return reply.code(500).send("demo.html not found next to the server.");
    }
  });

  /**
   * Server-side SDP proxy. The browser sends its offer SDP as text/plain; we
   * forward it to OpenAI authenticated with our key, then return the answer
   * SDP. The key and OpenAI endpoint never reach the client.
   */
  app.post("/rtc/connect", async (req, reply) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      req.log.error("OPENAI_API_KEY not set");
      return reply.code(500).send({ error: "server_misconfigured" });
    }

    const offerSdp = typeof req.body === "string" ? req.body : "";
    if (!offerSdp.startsWith("v=")) {
      return reply.code(400).send({ error: "invalid_sdp_offer" });
    }

    // 12s ceiling so a stalled upstream doesn't hang the request.
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 12_000);

    try {
      // GA unified interface: POST a multipart form combining the browser's
      // SDP offer with the session config JSON. The model lives INSIDE the
      // session object, not in the query string (a ?model= param here causes
      // an empty 400). Do NOT set Content-Type — fetch sets the multipart
      // boundary automatically for FormData.
      const form = new FormData();
      form.set("sdp", offerSdp);
      form.set("session", JSON.stringify(sessionConfig()));

      const res = await fetch(`${OPENAI_BASE}/calls`, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
      });

      const answer = await res.text();
      if (!res.ok) {
        req.log.error({ status: res.status, answer }, "OpenAI SDP exchange failed");
        return reply.code(502).send({ error: "upstream_failed", status: res.status });
      }

      // GA returns the SDP answer as plain text (status 200 or 201).
      return reply.header("Content-Type", "application/sdp").send(answer);
    } catch (err: any) {
      const reason = err?.name === "AbortError" ? "upstream_timeout" : "proxy_error";
      req.log.error({ err }, reason);
      return reply.code(504).send({ error: reason });
    } finally {
      clearTimeout(timeout);
    }
  });
}

/**
 * Register raw text/plain body parsing for SDP. Call this once during server
 * setup BEFORE registerRealtimeWeb (Fastify parses JSON by default and would
 * reject the SDP body):
 *
 *   app.addContentTypeParser(
 *     "application/sdp",
 *     { parseAs: "string" },
 *     (_req, body, done) => done(null, body)
 *   );
 */
