import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, capturedClientOptions } = vi.hoisted(() => ({
  createMock: vi.fn(),
  capturedClientOptions: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = { create: createMock };
    constructor(options: unknown) {
      capturedClientOptions.push(options);
    }
  },
}));

import {
  MESSENGER_LLM_MODEL,
  MESSENGER_LLM_NOT_CONFIGURED_MESSAGE,
  runLlmTurn,
} from "../app/services/messenger-llm.server";

const BASE_INPUT = {
  system: "You are FlowerBot.",
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  tools: [
    {
      name: "resolve_date",
      description: "Resolve a date phrase",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
  ],
};

describe("runLlmTurn", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
    createMock.mockReset();
    capturedClientOptions.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins the model to Claude Sonnet 5", () => {
    expect(MESSENGER_LLM_MODEL).toBe("claude-sonnet-5");
  });

  it("returns notConfigured without calling the API when ANTHROPIC_API_KEY is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const result = await runLlmTurn(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.notConfigured).toBe(true);
      expect(result.error).toBe(MESSENGER_LLM_NOT_CONFIGURED_MESSAGE);
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("maps a text response and passes model/system/tools through", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "Kumusta!" }],
      stop_reason: "end_turn",
    });

    const result = await runLlmTurn(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stopReason).toBe("end_turn");
      expect(result.blocks).toEqual([{ type: "text", text: "Kumusta!" }]);
    }

    const params = createMock.mock.calls[0][0];
    expect(params.model).toBe("claude-sonnet-5");
    expect(params.system).toBe(BASE_INPUT.system);
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].name).toBe("resolve_date");
    expect(params.max_tokens).toBeGreaterThanOrEqual(1024);
  });

  it("maps tool_use blocks", async () => {
    createMock.mockResolvedValue({
      content: [
        { type: "text", text: "Sandali lang po" },
        { type: "tool_use", id: "toolu_1", name: "resolve_date", input: { base: "tomorrow" } },
      ],
      stop_reason: "tool_use",
    });

    const result = await runLlmTurn(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stopReason).toBe("tool_use");
      expect(result.blocks[1]).toEqual({
        type: "tool_use",
        id: "toolu_1",
        name: "resolve_date",
        input: { base: "tomorrow" },
      });
    }
  });

  it("never throws on API errors and excludes the key from the error string", async () => {
    createMock.mockRejectedValue(new Error("429 rate limited"));
    const result = await runLlmTurn(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("429");
      expect(result.error).not.toContain("sk-ant-test-key");
    }
  });

  it("trims a trailing newline from a pasted API key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key\n");
    createMock.mockResolvedValue({ content: [], stop_reason: "end_turn" });
    await runLlmTurn(BASE_INPUT);
    expect((capturedClientOptions[0] as { apiKey: string }).apiKey).toBe("sk-ant-test-key");
  });
});
