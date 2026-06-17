import WebSocket from "ws";
import { Agent } from "./agent.js";

/**
 * RealtimeBridge connects a single phone call to the OpenAI Realtime API (GA
 * interface) and relays audio in both directions:
 *
 *   Caller speech  ─(Twilio μ-law)─►  OpenAI  ─► transcription + reasoning
 *   OpenAI speech  ◄─(Twilio μ-law)─  OpenAI  ◄─ generated audio
 *
 * Twilio Media Streams send/receive 8kHz μ-law (g711_ulaw) base64 audio.
 * The OpenAI Realtime API can consume and produce that same format directly,
 * so no resampling is needed — we just pass frames through and tag outgoing
 * frames with the Twilio streamSid.
 *
 * NOTE: This targets the GA Realtime interface (the beta interface, with the
 * "OpenAI-Beta: realtime=v1" header and flat audio-format strings, was removed
 * on 2026-05-12). Key GA differences vs beta:
 *   - No "OpenAI-Beta" header.
 *   - session.type must be set ("realtime").
 *   - Audio config is nested under session.audio.input/output, and the format
 *     is an object: { type: "audio/pcmu" } for G.711 μ-law.
 *   - Output audio deltas arrive as "response.output_audio.delta".
 *   - Greeting message items use content type "input_text".
 */

const MODEL = "gpt-realtime-2";
const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;

type SendToTwilio = (twilioMessage: object) => void;

export class RealtimeBridge {
  private openai: WebSocket | null = null;
  private streamSid: string | null = null;
  private readonly agent: Agent;
  private readonly sendToTwilio: SendToTwilio;
  private ready = false;
  private responseActive = false;

  constructor(agent: Agent, sendToTwilio: SendToTwilio) {
    this.agent = agent;
    this.sendToTwilio = sendToTwilio;
  }

  /** Open the OpenAI socket and configure the session. */
  connect(): void {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");

    this.openai = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        // GA interface: do NOT send "OpenAI-Beta: realtime=v1".
      },
    });

    this.openai.on("open", () => this.configureSession());
    this.openai.on("message", (data) => this.handleOpenAiEvent(data));
    this.openai.on("error", (err) =>
      console.error("[OpenAI] socket error:", err.message)
    );
    this.openai.on("close", (code, reason) => {
      console.log(
        `[OpenAI] connection closed (${code}) ${reason?.toString() ?? ""}`
      );
      this.ready = false;
    });
  }

  /**
   * Configure the realtime session: audio formats, voice, instructions, and
   * server-side voice activity detection so the model knows when the caller
   * has stopped speaking and it's its turn to respond.
   *
   * GA shape: audio config is nested under session.audio.{input,output} and the
   * format is an object. For Twilio's G.711 μ-law use { type: "audio/pcmu" }.
   */
  private configureSession(): void {
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        model: MODEL,
        instructions: this.agent.instructions,
        // Keep reasoning latency low for live phone calls.
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: { type: "server_vad" },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: this.agent.voice,
          },
        },
      },
    });
  }

  /** Speak the opening greeting once the session is ready. */
  private sendGreeting(): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: this.agent.greeting }],
      },
    });
    this.send({ type: "response.create" });
  }

  /** Handle events coming back from OpenAI. */
  private handleOpenAiEvent(raw: WebSocket.RawData): void {
    let event: any;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case "session.created":
      case "session.updated":
        if (!this.ready) {
          this.ready = true;
          console.log("[OpenAI] session ready —", this.agent.name);
          this.sendGreeting();
        }
        break;

      // Track whether a response is currently being generated, so we don't
      // cancel when nothing is active or start a new response over a live one.
      case "response.created":
        this.responseActive = true;
        break;
      case "response.done":
      case "response.cancelled":
        this.responseActive = false;
        break;

      // A chunk of generated audio — forward it to the caller via Twilio.
      // GA event name is "response.output_audio.delta".
      case "response.output_audio.delta":
        if (this.streamSid && event.delta) {
          this.sendToTwilio({
            event: "media",
            streamSid: this.streamSid,
            media: { payload: event.delta },
          });
        }
        break;
      
      case "error":
        console.error("[OpenAI] error event:", event.error);
        // If a response failed to start/finish, don't leave the flag stuck.
        this.responseActive = false;
        break;  

      // Caller started talking while the agent was speaking — clear the
      // queued audio so the agent stops and listens (barge-in handling),
      // and cancel the in-flight response on the OpenAI side — but only if
      // a response is actually active, otherwise OpenAI returns
      // "response_cancel_not_active".
      case "input_audio_buffer.speech_started":
        if (this.streamSid && this.responseActive) {
          this.sendToTwilio({ event: "clear", streamSid: this.streamSid });
          this.send({ type: "response.cancel" });
        }
        break;

      case "error":
        console.error("[OpenAI] error event:", event.error);
        break;
    }
  }

  /** Twilio sent us a frame of caller audio — forward it to OpenAI. */
  appendCallerAudio(payloadBase64: string): void {
    this.send({
      type: "input_audio_buffer.append",
      audio: payloadBase64,
    });
  }

  /**
   * Manually end the caller's turn and ask the model to respond.
   *
   * In production (real phone calls) server VAD handles this automatically, so
   * you normally don't call this. It's useful for scripted tests where you
   * stream a fixed audio clip and want a deterministic response.
   *
   * We refuse to commit while a response is still active (e.g. the greeting is
   * still playing), since that produces "conversation_already_has_active_
   * response". The test client should wait for the greeting to finish first.
   */
  commitCallerTurn(): void {
    if (this.responseActive) {
      console.warn(
        "[bridge] commitCallerTurn skipped — a response is still active (greeting still playing?)"
      );
      return;
    }
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
  }

  /** True while the model is generating a response. */
  isResponseActive(): boolean {
    return this.responseActive;
  }

  setStreamSid(sid: string): void {
    this.streamSid = sid;
  }

  close(): void {
    if (this.openai && this.openai.readyState === WebSocket.OPEN) {
      this.openai.close();
    }
  }

  private send(obj: object): void {
    if (this.openai && this.openai.readyState === WebSocket.OPEN) {
      this.openai.send(JSON.stringify(obj));
    }
  }
}
