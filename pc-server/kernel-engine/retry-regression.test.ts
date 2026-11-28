import { expect, spyOn, test } from "bun:test";
import { AgentRuntime, KernelStore } from "../../agent-kernel/src/index";
import { desktopTransportRetryOptions } from "./transport-retry";
import { DesktopProvider } from "./provider";
import { defaultAssistant } from "../assistants";
import { model, provider } from "../model-providers";
import { transportRetryDelayMs } from "../inference-engine/transport-retry";
import { ProviderError } from "../../agent-kernel/src/openai";
import type { EngineRunContext } from "../engines";
import type { ModelProvider } from "../../agent-kernel/src/types";

test("active kernel waits 5s/10s for 429 with Retry-After: 1", async () => {
  const waits: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    waits.push(ms);
    return realSetTimeout(callback, 0);
  }) as typeof setTimeout);
  const store = new KernelStore();
  let attempts = 0;
  const provider: ModelProvider = { async *stream() {
    attempts++;
    throw new ProviderError("HTTP 429: rate limit", true, 1000);
  } };
  try {
    const runtime = new AgentRuntime({ store, provider,
      ...desktopTransportRetryOptions({ transportRetryDelaySeconds: 5 }),
    });
    const result = await runtime.start({ model: "fake", input: "test retry" });
    expect(result.status).toBe("failed");
    expect(attempts).toBe(3);
    expect(waits).toEqual([5000, 10000]);
  } finally { timer.mockRestore(); store.close(); }
});

for (const scenario of ["disabled", "long-header", "partial", "cancel"] as const) {
  test(`kernel retry boundary: ${scenario}`, async () => {
    const store = new KernelStore();
    let attempts = 0;
    const controller = new AbortController();
    const provider: ModelProvider = { async *stream() {
      attempts++;
      if (scenario === "partial") yield { type: "reasoning", delta: "started" };
      if (scenario === "cancel") controller.abort();
      throw new ProviderError("rate limit", true, scenario === "long-header" ? 61000 : 1000);
    } };
    try {
      const runtime = new AgentRuntime({ store, provider,
        ...desktopTransportRetryOptions({ transportRetry: scenario !== "disabled", transportRetryDelaySeconds: 5 }),
      });
      const result = await runtime.start({ model: "fake", input: "test boundary" }, controller.signal);
      expect(result.status).toBe(scenario === "cancel" ? "cancelled" : "failed");
      expect(attempts).toBe(1);
    } finally { store.close(); }
  });
}

test("Retry-After: 0/1 cannot shorten the configured 5s backoff", () => {
  for (const retryAfter of [0, 1000]) {
    expect(transportRetryDelayMs(1, retryAfter, 5000)).toBe(5000);
    expect(transportRetryDelayMs(2, retryAfter, 5000)).toBe(10000);
  }
});

for (const body of ["rate limit reached", "insufficient_quota", "账户余额不足，请充值"]) {
  test(`desktop 429 preserves Retry-After and classifies ${body}`, async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(body, { status: 429, headers: { "Retry-After": "1" } }),
    });
    const selected = model("fake", "Fake");
    const ctx = { provider: provider({ id: "retry-test", name: "Retry test",
      baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [selected] }),
      assistant: defaultAssistant(), model: selected, conversation: { id: "retry-test", executionMode: "chat" },
    } as unknown as EngineRunContext;
    let caught: unknown;
    try {
      for await (const _ of new DesktopProvider(ctx, () => {}).stream({ model: "fake",
        messages: [{ role: "user", content: "hello" }], tools: [], maxOutputTokens: 1024,
      }, new AbortController().signal)) {}
    } catch (error) { caught = error; }
    finally { server.stop(true); }
    expect(caught).toBeInstanceOf(ProviderError);
    const error = caught as ProviderError;
    expect(error.retryable).toBe(body === "rate limit reached");
    expect(error.retryAfterMs).toBe(1000);
  });
}
