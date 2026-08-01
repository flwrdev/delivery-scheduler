// Thin LLM interface for the FlowerCart Messenger agent (phase 4).
//
// THIS IS THE ONE-FILE PROVIDER SWAP (master doc): messages + tools in,
// text or tool-call blocks out. Nothing outside this file may import the
// provider SDK or know which model is being called. Swapping providers means
// rewriting this file only.
//
// Provider decision (merchant-approved 2026-08-01): Anthropic Claude Sonnet 5
// — near-Opus tool-use reliability at Sonnet cost, strong Taglish.
// Never log message text; log only statuses and error strings (key excluded).

import Anthropic from "@anthropic-ai/sdk";

export const MESSENGER_LLM_MODEL = "claude-sonnet-5";

export const MESSENGER_LLM_NOT_CONFIGURED_MESSAGE =
  "Messenger LLM is not configured on this environment.";

const MAX_OUTPUT_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface LlmToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type LlmContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmContentBlock[];
}

export type LlmTurnResult =
  | {
      ok: true;
      stopReason: string;
      blocks: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: unknown }
      >;
    }
  | { ok: false; error: string; notConfigured?: boolean };

export interface RunLlmTurnInput {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
}

export async function runLlmTurn({
  system,
  messages,
  tools,
}: RunLlmTurnInput): Promise<LlmTurnResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: MESSENGER_LLM_NOT_CONFIGURED_MESSAGE, notConfigured: true };
  }

  try {
    const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
    const response = await client.messages.create({
      model: MESSENGER_LLM_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: messages as Anthropic.MessageParam[],
      tools: tools as Anthropic.Tool[],
    });

    const blocks: Extract<LlmTurnResult, { ok: true }>["blocks"] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    }

    return { ok: true, stopReason: response.stop_reason ?? "end_turn", blocks };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "LLM call failed.",
    };
  }
}
