# Real-Time Voice Agent — Twilio · WebRTC · OpenAI Realtime

[![CI](https://github.com/waqarali-7/voice-agent-realtime/actions/workflows/ci.yml/badge.svg)](https://github.com/waqarali-7/voice-agent-realtime/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

An AI voice agent that **answers calls and holds a natural spoken conversation** in real time — over the **phone** (Twilio Media Streams) or in the **browser** (WebRTC) — and actually *does things*: it takes messages and hangs up on its own, using function-calling.

Built with **Node.js, TypeScript, and Fastify**. One agent persona, two transports, a shared toolset, and a real persistence layer.

<!-- ▸ Add a 20-30s screen recording here. For a voice demo, audible call audio is everything. -->
![Voice agent demo](docs/demo.gif)

---

## What it does

Call the Twilio number — or open the web demo and click **Call Ava** — and you're talking to an AI receptionist. She greets you, answers questions, and responds conversationally. Interrupt her mid-sentence and she stops and listens (barge-in). Ask her to pass a message along and she collects your name, number, and message, **saves it**, and confirms. Say goodbye and she **ends the call** herself.

```
 Phone:   Caller ─phone─► Twilio ─Media Stream (μ-law)─► server ─► OpenAI Realtime
 Web:     Browser ─WebRTC──────────────────────────────► server ─► OpenAI Realtime
                                  │
                            tools (take_message, end_call) ──► message store (JSONL)
```

The phone and web paths share the **same agent persona** (`src/agent.ts`) and the **same tools** (`src/tools.ts`), so behaviour is defined once.

---

## Highlights

- **Two transports, one brain.** Twilio Media Streams over WebSocket for phone; WebRTC for the browser. Both drive the same persona and tools.
- **Function-calling that does real work.** `take_message` writes caller messages to a persistence layer; `end_call` lets the agent hang up when the conversation is genuinely over.
- **Barge-in.** When the caller talks over the agent, queued audio is cleared and the in-flight response is cancelled — natural turn-taking, not walkie-talkie.
- **Key never touches the browser.** The web client talks only to this server; the WebRTC SDP handshake is proxied server-side, so the OpenAI key, endpoint, and session config stay server-side.
- **GA Realtime interface.** Targets the current GA API (nested `session.audio`, `response.output_audio.delta`, multipart `/realtime/calls` handshake) — not the removed beta shape.
- **Tested + CI.** Pure logic (TwiML, host normalization, the message store, tool dispatch) is unit-tested; GitHub Actions runs typecheck + tests on every push.

---

## Architecture

| File | Responsibility |
|---|---|
| `src/server.ts` | Fastify wiring: Twilio voice webhook, `/media` WebSocket per call, `/health`, `/messages`, graceful shutdown |
| `src/bridge.ts` | One `RealtimeBridge` per phone call — opens the OpenAI socket, relays μ-law audio both ways, handles barge-in and tool calls |
| `src/realtime-web.ts` | Browser routes: serves the demo page, proxies the WebRTC SDP handshake, executes tools server-side |
| `src/agent.ts` | The agent's voice, personality, greeting, instructions — the swappable part |
| `src/tools.ts` | Tool definitions + handlers (`take_message`, `end_call`); shared by phone and web |
| `src/twiml.ts` | Pure TwiML + host-normalization helpers (unit-tested) |
| `src/lib/messageStore.ts` | Append-only JSONL message store behind a `MessageStore` interface |
| `src/lib/logger.ts` | Zero-dependency structured (JSON) logger |
| `src/demo.html` | Single-file browser client: mic capture, WebRTC, live transcript, tool relay |

Audio never needs resampling on the phone path: Twilio and the Realtime API both speak 8 kHz μ-law, so frames pass straight through.

---

## Design decisions

A few choices worth calling out, and the reasoning behind them:

- **Transport is decoupled from persona and tools.** `bridge.ts` (phone) and `realtime-web.ts` (browser) are pure transport; `agent.ts` and `tools.ts` are shared. Adding a tool or changing the persona is one edit that lands on both channels — no duplicated behaviour to drift out of sync.
- **The browser never holds the API key.** It would be simpler to mint an ephemeral token and let the browser POST its SDP straight to OpenAI, but that puts the OpenAI surface in client code. Proxying the handshake through `/rtc/connect` keeps the key, endpoint, model, and session config server-side at the cost of one extra hop — the right trade for anything beyond a toy.
- **Tools execute server-side, even for the web client.** The browser relays the model's tool call to `/rtc/tool` rather than acting on it directly, so the message store (and any future side-effects) never depend on client trust.
- **Persistence is an interface, not a database.** `MessageStore` is satisfied by a zero-dependency JSONL file so the repo runs with `npm install` and nothing else. Production swaps the implementation, not the call sites.
- **Barge-in cancels only when a response is active.** Cancelling an idle response throws `response_cancel_not_active`; gating on tracked response state avoids the error and keeps logs clean — small, but it's the difference between a demo and something that survives real traffic.
- **GA Realtime, deliberately.** The beta interface was removed 2026-05-12. This targets the GA shapes (nested `session.audio`, `response.output_audio.delta`, the multipart `/realtime/calls` handshake) rather than the patterns most tutorials still show.

---

## Run it

**Prerequisites:** Node.js 18+, an OpenAI API key with Realtime access. For the phone path: a Twilio number and a tunnel (ngrok). The web path needs neither.

```bash
git clone https://github.com/waqarali-7/voice-agent-realtime.git
cd voice-agent-realtime
npm install

cp .env.example .env      # add your OPENAI_API_KEY

npm run dev               # starts on :5050
```

### Web demo (no phone, no Twilio)

Open <http://localhost:5050>, click **Call Ava**, allow the mic, and talk. Try: *"Can you take a message? It's Ali, my number is 0300-0000025, ask the team to call me about my order."* Then check what she saved:

```bash
curl http://localhost:5050/messages
```

### Phone

```bash
ngrok http 5050
```

In the Twilio console, set the number's **"A call comes in"** webhook to:

```
https://YOUR-SUBDOMAIN.ngrok.app/incoming-call   (HTTP POST)
```

Call the number and talk to Ava.

### Sanity checks (no call needed)

```bash
curl http://localhost:5050/health
# → {"status":"ok","agent":"Ava — Front Desk"}

curl -X POST http://localhost:5050/incoming-call -H "Host: example.ngrok.app"
# → TwiML with a single-scheme wss:// stream URL
```

---

## Test

```bash
npm run typecheck
npm test
```

Tests cover TwiML generation and the double-scheme guard, forwarded-host normalization, the message store round-trip, and tool dispatch (including the unknown-tool safety path).

---

## Customizing the agent

Edit `src/agent.ts` — change the `voice`, rewrite `instructions` for a different role, or set a new `greeting`. To run different agents on different numbers, branch on the called number in the webhook and pass the chosen agent into the bridge. To add a capability, add one entry to the registry in `src/tools.ts` (definition + handler) — it's immediately available to both phone and web.

---

## Deploy

Runs anywhere that supports a long-lived Node process with WebSockets — **Render**, **Railway**, **Fly.io**, or a VPS. Set `OPENAI_API_KEY`, deploy, point the Twilio webhook at `https://your-host/incoming-call`. Serverless platforms without persistent WebSocket support (e.g. standard Vercel functions) aren't a fit for the media-stream socket.

> The message store writes to a local JSONL file by default. For multi-instance deploys, swap `JsonlMessageStore` for a database-backed implementation of the same `MessageStore` interface.

---

## License

MIT — fork it, ship it, make it yours.

---

Built by **Waqar Ali** — senior full-stack & AI automation engineer.
[Upwork](https://www.upwork.com/freelancers/waqarali7) · [GitHub](https://github.com/waqarali-7)
