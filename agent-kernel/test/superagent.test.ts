import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, KernelStore, Superagent } from "../src/index.ts";
import type { ModelProvider, ModelRequest, Tool } from "../src/index.ts";

const stores: KernelStore[] = [];
const directories: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });
function setup(options: { provider?: ModelProvider; tools?: Tool[]; verify?: ConstructorParameters<typeof Superagent>[0]["verify"] } = {}) {
  const requests: ModelRequest[] = [];
  const store = new KernelStore(); stores.push(store);
  const runtime = new AgentRuntime({ store, tools: options.tools, provider: options.provider ?? { async *stream(request) {
    requests.push(structuredClone(request));
    yield { type: "response", message: { role: "assistant", content: "verified result" }, finish: "stop" };
  } } });
  return { store, runtime, requests, supervisor: new Superagent({ runtime, verify: options.verify, maxReplans: 1 }) };
}

test("duplicate events create one ticket; DAG passes evidence to dependent workers", async () => {
  const { supervisor, requests, store } = setup({ verify: async () => ({ ok: true, evidence: "checked artifact" }) });
  const input = { source: "im", triggerId: "message-1", prompt: "overall work", model: "fake", tasks: [
    { id: "read", prompt: "inspect" }, { id: "summarize", prompt: "summarize", dependsOn: ["read"] },
  ] };
  const ticket = supervisor.accept(input);
  expect(supervisor.accept(input).id).toBe(ticket.id);
  const result = await supervisor.advance(ticket.id);
  expect(result.status).toBe("ready");
  expect(result.tasks.every(task => task.evidence === "checked artifact")).toBe(true);
  expect(requests[1].messages.at(-1)?.content).toContain("Dependency results:\n[read]\nverified result");
  expect(store.budget(ticket.id).requests).toBe(2);
  expect(store.deliveries()).toHaveLength(1);
  supervisor.complete(ticket.id);
  expect(supervisor.inspect(ticket.id).status).toBe("completed");
});

test("invalid/cyclic task graph is rejected before any work starts", () => {
  const { supervisor } = setup();
  expect(() => supervisor.accept({ source: "test", triggerId: "a", model: "fake", prompt: "work",
    tasks: [{ id: "a", prompt: "a", dependsOn: ["b"] }, { id: "b", prompt: "b", dependsOn: ["a"] }] })).toThrow("cycle");
  expect(() => supervisor.accept({ source: "test", triggerId: "b", model: "fake", prompt: "work",
    tasks: [{ id: "a", prompt: "a", dependsOn: ["missing"] }] })).toThrow("Unknown");
});

test("failed evidence requires explicit bounded replan and does not spend planner calls", async () => {
  let checks = 0;
  const { supervisor, requests } = setup({ verify: async () => ({ ok: ++checks > 1, evidence: "test result" }) });
  const ticket = supervisor.accept({ source: "test", triggerId: "1", model: "fake", prompt: "work" });
  expect((await supervisor.advance(ticket.id)).status).toBe("failed");
  supervisor.replan(ticket.id, [{ id: "retry", prompt: "fix the failure" }]);
  expect((await supervisor.advance(ticket.id)).status).toBe("ready");
  expect(requests).toHaveLength(2);
  expect(() => supervisor.replan(ticket.id, [{ id: "again", prompt: "again" }])).toThrow("unavailable");
});

test("delivery failures keep a stable pending receipt until successful retry", async () => {
  const { supervisor, store } = setup();
  const ticket = supervisor.accept({ source: "test", triggerId: "2", model: "fake", prompt: "work" });
  await supervisor.advance(ticket.id);
  const deliveryId = store.deliveries()[0].id;
  await expect(supervisor.flush(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(store.deliveries()[0].id).toBe(deliveryId);
  let count = 0;
  expect(await supervisor.flush(async delivery => { expect(delivery.id).toBe(deliveryId); count++; })).toBe(1);
  expect(await supervisor.flush(async () => { count++; })).toBe(0);
  expect(count).toBe(1);
});

test("waiting ticket does not block independent tasks or repeatedly wake the same worker", async () => {
  let requests = 0;
  const provider: ModelProvider = { async *stream(request) {
    requests++;
    if (request.messages.at(-1)?.role === "tool") {
      yield { type: "response", message: { role: "assistant", content: "done" }, finish: "stop" }; return;
    }
    yield { type: "response", message: { role: "assistant", content: "", toolCalls: [{ id: "job", name: "job", arguments: "{}" }] }, finish: "tools" };
  } };
  const { runtime, supervisor } = setup({ provider, tools: [{ name: "job", description: "job", parameters: { type: "object" },
    execute: async () => ({ content: "queued", waitFor: "background" }) }] });
  const ticket = supervisor.accept({ source: "test", triggerId: "3", model: "fake", prompt: "work",
    tasks: [{ id: "a", prompt: "a" }, { id: "b", prompt: "b" }, { id: "c", prompt: "c" }] });
  const waiting = await supervisor.advance(ticket.id);
  expect(waiting.status).toBe("waiting");
  expect(requests).toBe(3);
  for (const task of waiting.tasks) runtime.completeTool(task.runId!, "job", { content: "finished" });
  const done = await supervisor.advance(ticket.id);
  expect(done.status).toBe("ready");
  expect(requests).toBe(6);
});

test("SQLite reopens with intake dedup, pending delivery and completed task state intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-kernel-")); directories.push(directory);
  const path = join(directory, "kernel.sqlite");
  const provider: ModelProvider = { async *stream() {
    yield { type: "response", message: { role: "assistant", content: "done" }, finish: "stop" };
  } };
  const first = new KernelStore(path);
  const initial = new Superagent({ runtime: new AgentRuntime({ store: first, provider }) });
  const input = { source: "github", triggerId: "issue:1", prompt: "work", model: "fake" };
  const ticket = initial.accept(input);
  await initial.advance(ticket.id);
  first.close();
  const second = new KernelStore(path); stores.push(second);
  const restored = new Superagent({ runtime: new AgentRuntime({ store: second, provider }) });
  expect(restored.accept(input).id).toBe(ticket.id);
  expect((await restored.advance(ticket.id)).status).toBe("ready");
  expect(second.deliveries()).toHaveLength(1);
});

test("ticket cancellation propagates to the running worker", async () => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const provider: ModelProvider = { async *stream(_request, signal) {
    entered();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    throw new Error("unreachable");
  } };
  const { runtime, supervisor } = setup({ provider });
  const ticket = supervisor.accept({ source: "test", triggerId: "4", model: "fake", prompt: "work" });
  const working = supervisor.advance(ticket.id);
  await ready;
  supervisor.cancel(ticket.id);
  const result = await working;
  expect(result.status).toBe("cancelled");
  expect(runtime.inspect(result.tasks[0].runId!).status).toBe("cancelled");
});

test("cancelling a ready ticket withdraws an undelivered result", async () => {
  const { supervisor, store } = setup();
  const ticket = supervisor.accept({ source: "test", triggerId: "5", model: "fake", prompt: "work" });
  await supervisor.advance(ticket.id);
  expect(store.deliveries()).toHaveLength(1);
  supervisor.cancel(ticket.id);
  expect(store.deliveries()).toHaveLength(0);
  expect(supervisor.inspect(ticket.id).status).toBe("cancelled");
});
