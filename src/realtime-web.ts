/**
 * realtime-web.ts
 *
 * Browser-facing routes for the web voice demo, registered as a Fastify plugin
 * so it stays isolated from the Twilio bridge.
 *
 * Design intent:
 *   - The browser talks ONLY to our origin. It never holds the OpenAI key and
 *     never calls api.openai.com directly — we proxy the WebRTC SDP handshake
 *     server-side, so the key, endpoint, model, and session config stay server-
 *     side.
 *   - The same agent persona and the same tools drive web and phone, so there
 *     is one source of truth for Ava's behaviour and capabilities.
 *   - Tools execute on the server (so the message store stays server-side); the
 *     browser relays the model's tool call to /rtc/tool and feeds the result
 *     back into the data channel.
 *
 * Routes:
 *   GET  /             → serves the demo page
 *   POST /rtc/connect  → SDP offer in, SDP answer out (handshake proxy)
 *   POST /rtc/tool     → execute a tool the model called, return its output
 */

import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { activeAgent } from "./agent.js";
import { toolDefinitions, dispatchTool } from "./tools.js";
import type { MessageStore } from "./lib/messageStore.js";
import { log } from "./lib/logger.js";

const logger = log("web");
const __dirname = dirname(fileURLToPath(import.meta.url));

const OPENAI_BASE = "https://api.openai.com/v1/realtime";
const MODEL = process.env.REALTIME_MODEL ?? "gpt-realtime-2";

/** Session config derived from the active agent — includes tools. */
function sessionConfig() {
  return {
    type: "realtime",
    model: MODEL,
    instructions: activeAgent.instructions,
    audio: {
      input: {
        transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: { type: "server_vad" },
      },
      output: { voice: activeAgent.voice },
    },
    tools: toolDefinitions(),
    tool_choice: "auto",
  };
}

export async function registerRealtimeWeb(
  app: FastifyInstance,
  store: MessageStore
): Promise<void> {
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

  /** SDP handshake proxy. Browser posts its offer; we return OpenAI's answer. */
  app.post("/rtc/connect", async (req, reply) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.error("OPENAI_API_KEY not set");
      return reply.code(500).send({ error: "server_misconfigured" });
    }

    const offerSdp = typeof req.body === "string" ? req.body : "";
    if (!offerSdp.startsWith("v=")) {
      return reply.code(400).send({ error: "invalid_sdp_offer" });
    }

    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 12_000);
    try {
      // GA unified interface: multipart form of {sdp, session}. Model lives in
      // the session object, not the query string. No Content-Type header —
      // fetch sets the multipart boundary for FormData.
      const form = new FormData();
      form.set("sdp", offerSdp);
      form.set("session", JSON.stringify(sessionConfig()));

      const res = await fetch(`${OPENAI_BASE}/calls`, {
        method: "POST",
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });

      const answer = await res.text();
      if (!res.ok) {
        logger.error("openai sdp exchange failed", { status: res.status, answer });
        return reply.code(502).send({ error: "upstream_failed", status: res.status });
      }
      return reply.header("Content-Type", "application/sdp").send(answer);
    } catch (err: any) {
      const reason = err?.name === "AbortError" ? "upstream_timeout" : "proxy_error";
      logger.error(reason, { err: String(err) });
      return reply.code(504).send({ error: reason });
    } finally {
      clearTimeout(timeout);
    }
  });

  /**
   * Execute a tool the model called in the browser session. The browser sends
   * { name, call_id, arguments }; we run it (writing to the shared store) and
   * return the output the browser feeds back into the data channel.
   */
  app.post("/rtc/tool", async (req, reply) => {
    const body = (req.body ?? {}) as {
      name?: string;
      arguments?: Record<string, any>;
    };
    if (!body.name) return reply.code(400).send({ error: "missing_tool_name" });

    const result = await dispatchTool(body.name, body.arguments ?? {}, {
      store,
      channel: "web",
    });
    logger.info("web tool executed", { name: body.name });
    return reply.send(result);
  });
}
