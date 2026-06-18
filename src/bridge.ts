import WebSocket from "ws";
import { Agent } from "./agent.js";
import { toolDefinitions, dispatchTool, type ToolContext } from "./tools.js";
import { log } from "./lib/logger.js";

/**
 * RealtimeBridge connects a single phone call to the OpenAI Realtime API (GA
 * interface) and relays audio in both directions:
 *
 *   Caller speech  ─(Twilio μ-law)─►  OpenAI  ─► transcription + reasoning
 *   OpenAI speech  ◄─(Twilio μ-law)─  OpenAI  ◄─ generated audio
 *
 * Twilio Media Streams send/receive 8kHz μ-law (g711_ulaw) base64 audio. The
 * OpenAI Realtime API consumes and produces that same format, so frames pass
 * straight through with no resampling, tagged with the Twilio streamSid.
 *
 * The agent can also call tools (e.g. take_message, end_call); tool calls are
 * dispatched in-process and the result is fed back so the agent can speak it.
 *
 * Targets the GA Realtime interface (the beta interface was removed
 * 2026-05-12): no "OpenAI-Beta" header, session.type set, audio config nested
 * under session.audio.{input,output}, output deltas as
 * "response.output_audio.delta".
 */

const logger = log("bridge");

const MODEL = process.env.REALTIME_MODEL ?? "gpt-realtime-2";
const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;

type SendToTwilio = (twilioMessage: object) => void;

export class RealtimeBridge {
  private openai: WebSocket | null = null;
  private streamSid: string | null = null;
  private readonly agent: Agent;
  private readonly sendToTwilio: SendToTwilio;
  private readonly toolCtx: ToolContext;
  private readonly onEndCall: () => void;
  private ready = false;
  private responseActive = false;

  constructor(
    agent: Agent,
    sendToTwilio: SendToTwilio,
    toolCtx: ToolContext,
    onEndCall: () => void = () => {}
  ) {
    this.agent = agent;
    this.sendToTwilio = sendToTwilio;
    this.toolCtx = toolCtx;
    this.onEndCall = onEndCall;
  }

  /** Open the OpenAI socket and configure the session. */
  connect(): void {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");

    this.openai = new WebSocket(OPENAI_REALTIME_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    this.openai.on("open", () => this.configureSession());
    this.openai.on("message", (data) => this.handleOpenAiEvent(data));
    this.openai.on("error", (err) =>
      logger.error("openai socket error", { err: err.message })
    );
    this.openai.on("close", (code, reason) => {
      logger.info("openai connection closed", {
        code,
        reason: reason?.toString() || undefined,
      });
      this.ready = false;
    });
  }

  /**
   * Configure the realtime session: audio formats (G.711 μ-law for Twilio),
   * voice, instructions, server-side VAD, and the agent's tools.
   */
  private configureSession(): void {
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        model: MODEL,
        instructions: this.agent.instructions,
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
        tools: toolDefinitions(),
        tool_choice: "auto",
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
          logger.info("session ready", { agent: this.agent.name });
          this.sendGreeting();
        }
        break;

      // Track response lifecycle so we never cancel nothing or start a
      // response over a live one.
      case "response.created":
        this.responseActive = true;
        break;
      case "response.done":
      case "response.cancelled":
        this.responseActive = false;
        break;

      // Generated audio chunk → forward to the caller via Twilio.
      case "response.output_audio.delta":
        if (this.streamSid && event.delta) {
          this.sendToTwilio({
            event: "media",
            streamSid: this.streamSid,
            media: { payload: event.delta },
          });
        }
        break;

      // The model finished assembling a tool call.
      case "response.function_call_arguments.done":
        void this.handleToolCall(event);
        break;

      // Barge-in: caller speaks over the agent. Clear queued audio and cancel
      // the in-flight response — but only if one is active.
      case "input_audio_buffer.speech_started":
        if (this.streamSid && this.responseActive) {
          this.sendToTwilio({ event: "clear", streamSid: this.streamSid });
          this.send({ type: "response.cancel" });
        }
        break;

      case "error":
        logger.error("openai error event", { error: event.error });
        // Don't leave the flag stuck if a response failed to start/finish.
        this.responseActive = false;
        break;
    }
  }

  /** Run a tool the model called, feed the result back, let the agent speak it. */
  private async handleToolCall(event: any): Promise<void> {
    const name: string = event.name;
    const callId: string = event.call_id;
    let args: Record<string, any> = {};
    try {
      args = event.arguments ? JSON.parse(event.arguments) : {};
    } catch {
      logger.warn("tool args not valid JSON", { name });
    }

    logger.info("tool call", { name, callId });
    const result = await dispatchTool(name, args, this.toolCtx);

    // Return the tool output to the model.
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result.output),
      },
    });
    // Ask the model to speak a natural acknowledgement of the result.
    this.send({ type: "response.create" });

    // If the tool signals the call should end, close once the agent has had a
    // moment to deliver its farewell.
    if (result.endCall) {
      setTimeout(() => this.onEndCall(), 4000);
    }
  }

  /** Twilio sent us a frame of caller audio — forward it to OpenAI. */
  appendCallerAudio(payloadBase64: string): void {
    this.send({ type: "input_audio_buffer.append", audio: payloadBase64 });
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
