import { expect, test } from "bun:test";
import { AgentRuntime, KernelStore } from "../../agent-kernel/src/index";
import { desktopKernelLimits } from "./limits";

test("LongCat repository analysis can continue after the recorded ninth request", async () => {
  // Alpha.2's dsh-yukkuli task stopped here: 9 requests billed 191,533 tokens,
  // then ~60k was needed to send the collected source for the next model step.
  const store = new KernelStore();
  let called = false;
  const runtime = new AgentRuntime({ store, provider: { async *stream() {
    called = true;
    yield { type: "response", message: { role: "assistant", content: "analysis" }, finish: "stop",
      usage: { inputTokens: 60000, outputTokens: 1000 } };
  } } });
  try {
    const id = runtime.create({ model: "LongCat-2.5", input: "collected source: " + "x".repeat(180000),
      limits: desktopKernelLimits(true, 1048576, 4096) });
    const checkpoint = runtime.inspect(id);
    checkpoint.steps = 9;
    store.save(checkpoint);
    for (let i = 0; i < 9; i++) expect(store.reserve(id, 1)).toBe(true);
    store.reconcile(id, 9, 191533);
    const result = await runtime.resume(id);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(called).toBe(true);
    expect(store.budget(id).tokens).toBe(252533);
  } finally { store.close(); }
});
