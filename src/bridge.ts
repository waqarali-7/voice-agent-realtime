import WebSocket from "ws";
import { Agent } from "./agent.js";

/**
 * RealtimeBridge connects a single phone call to the OpenAI Realtime API and
 * relays audio in both directions:
 *
 *   Caller speech  ─(Twilio μ-law)─►  OpenAI  ─► transcription + reasoning
 *   OpenAI speech  ◄─(Twilio μ-law)─  OpenAI  ◄─ generated audio
 *
 * Twilio Media Streams send/receive 8kHz μ-law (g711_ulaw) base64 audio.
 * The OpenAI Realtime API can consume and produce that same format directly,
 * so no resampling is needed — we just pass frames through and tag outgoing
 * frames with the Twilio streamSid.
 */

const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

type SendToTwilio = (twilioMessage: object) => void;

export class RealtimeBridge {
  private openai: WebSocket | null = null;
  private streamSid: string | null = null;
  private readonly agent: Agent;
  private readonly sendToTwilio: SendToTwilio;
  private ready = false;

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
        "OpenAI-Beta": "realtime=v1",
      },
    });

    this.openai.on("open", () => this.configureSession());
    this.openai.on("message", (data) => this.handleOpenAiEvent(data));
    this.openai.on("error", (err) =>
      console.error("[OpenAI] socket error:", err.message)
    );
    this.openai.on("close", () => {
      console.log("[OpenAI] connection closed");
      this.ready = false;
    });
  }

  /**
   * Configure the realtime session: audio formats, voice, instructions, and
   * server-side voice activity detection so the model knows when the caller
   * has stopped speaking and it's its turn to respond.
   */
  private configureSession(): void {
    this.send({
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: this.agent.voice,
        instructions: this.agent.instructions,
        modalities: ["text", "audio"],
        temperature: this.agent.temperature,
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
        content: [{ type: "text", text: this.agent.greeting }],
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
      case "session.updated":
        if (!this.ready) {
          this.ready = true;
          console.log("[OpenAI] session ready —", this.agent.name);
          this.sendGreeting();
        }
        break;

      // A chunk of generated audio — forward it to the caller via Twilio.
      case "response.audio.delta":
        if (this.streamSid && event.delta) {
          this.sendToTwilio({
            event: "media",
            streamSid: this.streamSid,
            media: { payload: event.delta },
          });
        }
        break;

      // Caller started talking while the agent was speaking — clear the
      // queued audio so the agent stops and listens (barge-in handling).
      case "input_audio_buffer.speech_started":
        if (this.streamSid) {
          this.sendToTwilio({ event: "clear", streamSid: this.streamSid });
        }
        break;

      case "error":
        console.error("[OpenAI] error event:", event.error?.message);
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
