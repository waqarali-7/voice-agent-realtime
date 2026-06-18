/**
 * tools.ts
 *
 * The agent's capabilities — the things Ava can actually *do*, not just say.
 *
 * Each tool has two parts:
 *   1. A JSON-schema definition sent to the model in `session.update` so the
 *      model knows the tool exists and what arguments it takes.
 *   2. A handler that runs in our code when the model calls it.
 *
 * The Realtime tool-call lifecycle (GA):
 *   model emits  response.function_call_arguments.done  (name, call_id, args)
 *   we run the handler, then reply with a `function_call_output` item carrying
 *   the same call_id, then `response.create` so Ava speaks the result.
 *
 * Keeping tools in one module (definition + handler together) means adding a
 * capability is a single, self-contained edit — and the same set works for
 * both the phone bridge and the web session.
 */

import type { MessageStore } from "./lib/messageStore.js";

/** Shape sent to OpenAI in session.update → session.tools[]. */
export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Result returned to the model and used to drive the spoken reply. */
export interface ToolResult {
  /** JSON-serializable payload the model sees as the tool output. */
  output: Record<string, unknown>;
  /** If true, the call should end after the agent finishes speaking. */
  endCall?: boolean;
}

export interface ToolContext {
  store: MessageStore;
  channel: "phone" | "web";
}

export type ToolHandler = (
  args: Record<string, any>,
  ctx: ToolContext
) => Promise<ToolResult>;

/** take_message — records a caller's message so the team can follow up. */
const takeMessageDef: ToolDefinition = {
  type: "function",
  name: "take_message",
  description:
    "Record a message from the caller so the team can call them back. " +
    "Call this once you have collected the caller's name, a callback number, " +
    "and what the message is about. Confirm the details back to the caller first.",
  parameters: {
    type: "object",
    properties: {
      caller_name: { type: "string", description: "The caller's full name." },
      callback_number: {
        type: "string",
        description: "A phone number to reach the caller on.",
      },
      message: {
        type: "string",
        description: "What the caller wants the team to know or call back about.",
      },
    },
    required: ["caller_name", "callback_number", "message"],
  },
};

const takeMessageHandler: ToolHandler = async (args, ctx) => {
  const saved = await ctx.store.save({
    callerName: String(args.caller_name ?? "").trim() || "Unknown",
    callbackNumber: String(args.callback_number ?? "").trim(),
    message: String(args.message ?? "").trim(),
    channel: ctx.channel,
  });
  return {
    output: {
      status: "saved",
      reference_id: saved.id.slice(0, 8),
      taken_at: saved.takenAt,
    },
  };
};

/** end_call — lets the agent hang up when the conversation is genuinely over. */
const endCallDef: ToolDefinition = {
  type: "function",
  name: "end_call",
  description:
    "End the call. Only call this once the conversation is genuinely finished " +
    "and the caller has said goodbye or has nothing further. Say a brief " +
    "farewell first.",
  parameters: { type: "object", properties: {} },
};

const endCallHandler: ToolHandler = async () => ({
  output: { status: "ending" },
  endCall: true,
});

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

const registry: Record<string, RegisteredTool> = {
  take_message: { definition: takeMessageDef, handler: takeMessageHandler },
  end_call: { definition: endCallDef, handler: endCallHandler },
};

/** Tool definitions for session.update. */
export function toolDefinitions(): ToolDefinition[] {
  return Object.values(registry).map((t) => t.definition);
}

/**
 * Dispatch a tool call by name. Unknown tools return a structured error rather
 * than throwing, so a hallucinated tool name can't crash a live call.
 */
export async function dispatchTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const tool = registry[name];
  if (!tool) {
    return { output: { status: "error", reason: `unknown tool: ${name}` } };
  }
  return tool.handler(args, ctx);
}
