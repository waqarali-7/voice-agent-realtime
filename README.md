# Real-Time Voice Agent — Twilio × OpenAI Realtime

An AI phone agent that **answers calls and holds a natural spoken conversation** in real time. It bridges [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams) to the [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) over WebSockets — speech in, speech out, low latency, with barge-in support.

Built with **Node.js, TypeScript, and Fastify**.

<!-- ▸ Add a 20-30s recording here: call the number, talk to the agent, show it responding. For a voice demo, audio is everything — a screen recording with audible call audio is ideal. -->

![Voice agent demo](docs/demo.gif)

---

## What it does

Call a Twilio number wired to this server and you're talking to an AI receptionist ("Ava"). She greets you, answers questions, and responds conversationally — interrupting her mid-sentence works, because the agent stops and listens when you start speaking.

```
Caller ──phone──► Twilio ──Media Stream (μ-law)──► this server ──► OpenAI Realtime API
   ▲                                                                      │
   └──────────────── generated speech (μ-law) ◄───────────────────────────┘
```

---

## What this demonstrates

- **Real-time bidirectional audio** over WebSockets between two services.
- **Twilio Media Streams** handling — parsing `start` / `media` / `stop` events and tagging outbound audio with the `streamSid`.
- **OpenAI Realtime session setup** — configuring `g711_ulaw` audio in/out, voice, instructions, and server-side voice-activity detection.
- **Barge-in** — when the caller speaks over the agent, queued audio is cleared so the agent yields the floor (natural turn-taking, not a walkie-talkie).
- **Clean separation** — the agent persona (`src/agent.ts`) is decoupled from the transport bridge (`src/bridge.ts`), so the same plumbing serves a receptionist, a booking line, or a survey bot by swapping one object.

---

## Architecture

| File | Responsibility |
|---|---|
| `src/server.ts` | Fastify server: Twilio voice webhook (returns TwiML) + the `/media` WebSocket per call |
| `src/bridge.ts` | One `RealtimeBridge` per call — opens the OpenAI socket, relays audio both ways, handles barge-in |
| `src/agent.ts` | The agent's voice, personality, greeting, and instructions — the swappable part |

The audio never needs resampling: Twilio and the OpenAI Realtime API both speak 8kHz μ-law, so frames pass straight through.

---

## Run it

**Prerequisites:** Node.js 18+, an OpenAI API key with Realtime access, a Twilio account with a phone number, and a tunnel (ngrok) for local testing.

```bash
git clone https://github.com/waqarali-7/voice-agent-realtime.git
cd voice-agent-realtime
npm install

cp .env.example .env      # add your OPENAI_API_KEY

npm run dev               # starts on :5050
```

Expose it and point Twilio at it:

```bash
ngrok http 5050
```

Then in the Twilio console, set your number's **"A call comes in"** webhook to:

```
https://YOUR-NGROK-SUBDOMAIN.ngrok.app/incoming-call   (HTTP POST)
```

Call the number and talk to Ava.

### Sanity checks (no phone call needed)

```bash
# Health
curl http://localhost:5050/health
# → {"status":"ok","agent":"Ava — Front Desk"}

# TwiML the webhook returns
curl -X POST http://localhost:5050/incoming-call -H "Host: example.ngrok.app"
```

---

## Deploy

Runs anywhere that supports a long-lived Node WebSocket server — **Render**, **Railway**, **Fly.io**, or a VPS. Set `OPENAI_API_KEY` in the environment, deploy, and point your Twilio webhook at `https://your-host/incoming-call`.

> Serverless platforms that don't support persistent WebSocket connections (e.g. standard Vercel functions) aren't a fit for the media-stream socket — use a host that keeps the process alive.

---

## Customizing the agent

Open `src/agent.ts` and edit the `receptionist` object — change the `voice`, rewrite the `instructions` for a different role, or set a new `greeting`. To run different agents on different numbers, branch on the called number in the webhook and pass the chosen agent into the bridge.

---

## License

MIT — fork it, ship it, make it yours.

---

Built by **Waqar Ali** — senior full-stack & AI automation engineer.
[Upwork](https://www.upwork.com/freelancers/waqarali7) · [GitHub](https://github.com/waqarali-7)
