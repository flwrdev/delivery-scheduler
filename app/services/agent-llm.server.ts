// Thin LLM interface for the FlowerCart agent — ALL channels (Messenger,
// customer account, storefront). Renamed from messenger-llm.server.ts
// 2026-08-24; the MESSENGER_LLM_* export names are kept for compatibility.
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
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
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
  /** Static system prompt — the large, cache-stable prefix (identical across conversations). */
  system: string;
  /** Volatile per-call context (e.g. the current date) — appended AFTER the cache breakpoint. */
  systemContext?: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
}

export async function runLlmTurn({
  system,
  systemContext,
  messages,
  tools,
}: RunLlmTurnInput): Promise<LlmTurnResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: MESSENGER_LLM_NOT_CONFIGURED_MESSAGE, notConfigured: true };
  }

  try {
    const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
    // Prompt caching (prefix match; render order is tools -> system -> messages):
    // ONE cache_control breakpoint on the static system block caches the tools +
    // static system prefix — byte-identical across every conversation and turn.
    // The volatile date rides in a trailing, UNCACHED system block after it.
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
    ];
    if (systemContext) {
      systemBlocks.push({ type: "text", text: systemContext });
    }
    const response = await client.messages.create({
      model: MESSENGER_LLM_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemBlocks,
      messages: messages as Anthropic.MessageParam[],
      tools: tools as Anthropic.Tool[],
    });

    // Log token counts ONLY (never message text) so cache hits are verifiable:
    // cache_read > 0 on the 2nd+ call proves the tools+system prefix is cached.
    const usage = response.usage;
    console.log(
      `[messenger-llm] input=${usage?.input_tokens ?? 0} cache_write=${
        usage?.cache_creation_input_tokens ?? 0
      } cache_read=${usage?.cache_read_input_tokens ?? 0} output=${usage?.output_tokens ?? 0}`,
    );

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
