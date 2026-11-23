import { afterEach, describe, expect, test } from "bun:test";
import { AgentRuntime, answerOf, KernelStore, ProviderError } from "../src/index.ts";
import type { KernelEvent, Message, ModelEvent, ModelProvider, ModelRequest, Tool, ToolDeclaration } from "../src/index.ts";
import { contextSplit, validateHistory } from "../src/context.ts";

const stores: KernelStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const store = () => { const value = new KernelStore(); stores.push(value); return value; };
const text = (content = "done"): ModelEvent => ({ type: "response", message: { role: "assistant", content }, finish: "stop",
  usage: { inputTokens: 10, outputTokens: 5 } });
const calls = (...names: string[]): ModelEvent => ({ type: "response", message: { role: "assistant", content: "", toolCalls:
  names.map((name, index) => ({ id: `call-${index}`, name, arguments: "{}" })) }, finish: "tools" });
function scripted(...steps: Array<ModelEvent | ((request: ModelRequest, signal: AbortSignal) => Promise<ModelEvent>)>): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return { requests, async *stream(request, signal) {
    requests.push(structuredClone(request));
    const step = steps.shift();
    if (!step) throw new Error("Unexpected model request");
    yield typeof step === "function" ? await step(request, signal) : step;
  } };
}
const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name, description: name, parameters: { type: "object", additionalProperties: false },
  execute: async () => ({ content: name }), ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("complete agent lifecycle", () => {
  test("chat and ordered tool result history", async () => {
    const provider = scripted(calls("read", "write"), request => {
      expect(request.messages.slice(-2).map(item => item.toolCallId)).toEqual(["call-0", "call-1"]);
      validateHistory(request.messages);
      return Promise.resolve(text("finished"));
    });
    const runtime = new AgentRuntime({ store: store(), provider, tools: [tool("read", { readOnly: true }), tool("write")] });
    const run = await runtime.start({ model: "fake", input: "work" });
    expect(run.status).toBe("completed");
    expect(answerOf(run)).toBe("finished");
    expect(run.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test("entire batch waits for approvals; completed results are never re-executed", async () => {
    let executions = 0;
    const provider = scripted(calls("safe", "danger"), text());
    const runtime = new AgentRuntime({ store: store(), provider, tools: [
      tool("safe", { execute: async () => { executions++; return { content: "safe" }; } }),
      tool("danger", { needsApproval: true, execute: async () => { executions++; return { content: "danger" }; } }),
    ] });
    let run = await runtime.start({ model: "fake", input: "work" });
    expect(run.status).toBe("awaiting_approval");
    expect(executions).toBe(0);
    runtime.approve(run.id, "call-1", false);
    run = await runtime.resume(run.id);
    expect(run.status).toBe("completed");
    expect(executions).toBe(1);
    expect(run.messages.find(item => item.toolCallId === "call-1")?.content).toContain("denied");
    await runtime.resume(run.id);
    expect(executions).toBe(1);
  });

  test("parallel reads overlap, writes form a global barrier", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const order: string[] = [];
    const runtime = new AgentRuntime({ store: store(), provider: scripted(calls("one", "two", "write", "three"), text()), tools: [
      tool("one", { readOnly: true, execute: async () => { order.push("one"); await release.promise; order.push("one-end"); return { content: "one" }; } }),
      tool("two", { readOnly: true, execute: async () => { order.push("two"); started.resolve(); await release.promise; return { content: "two" }; } }),
      tool("write", { execute: async () => { order.push("write"); return { content: "write" }; } }),
      tool("three", { readOnly: true, execute: async () => { order.push("three"); return { content: "three" }; } }),
    ] });
    const running = runtime.start({ model: "fake", input: "work" });
    await started.promise;
    expect(order).toEqual(["one", "two"]);
    release.resolve();
    expect((await running).status).toBe("completed");
    expect(order.indexOf("write")).toBeGreaterThan(order.indexOf("one-end"));
    expect(order.indexOf("three")).toBeGreaterThan(order.indexOf("write"));
  });

  test("invalid and truncated arguments never execute", async () => {
    let executed = 0;
    const truncated = calls("write");
    if (truncated.type === "response") truncated.finish = "length";
    const runtime = new AgentRuntime({ store: store(), provider: scripted(truncated, text()), tools: [tool("write", {
      execute: async () => { executed++; return { content: "bad" }; },
    })] });
    const run = await runtime.start({ model: "fake", input: "work" });
    expect(run.status).toBe("completed");
    expect(executed).toBe(0);
    expect(run.messages.find(message => message.role === "tool")?.content).toContain("truncated");
    const invalid = new AgentRuntime({ store: store(), provider: scripted(calls("write"), text()), tools: [tool("write", {
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async () => { executed++; return { content: "bad" }; },
    })] });
    const failedArgs = await invalid.start({ model: "fake", input: "work" });
    expect(failedArgs.messages.find(message => message.role === "tool")?.content).toContain("required");
    expect(executed).toBe(0);
  });

  test("steering is consumed at tool boundary; followup waits until the current work ends", async () => {
    const events: KernelEvent[] = [];
    let runtime!: AgentRuntime;
    const provider = scripted(calls("read"), request => {
      expect(request.messages.at(-1)?.content).toBe("change direction");
      expect(request.messages.some(message => message.content === "next task")).toBe(false);
      return Promise.resolve(text("first answer"));
    }, request => {
      expect(request.messages.at(-1)?.content).toBe("next task");
      return Promise.resolve(text("second answer"));
    });
    runtime = new AgentRuntime({ store: store(), provider, onEvent: event => { events.push(event); }, tools: [tool("read", {
      execute: async (_args, context) => {
        runtime.send(context.runId, "change direction");
        runtime.send(context.runId, "next task", "followup");
        return { content: "read result" };
      },
    })] });
    const run = await runtime.start({ model: "fake", input: "first task" });
    expect(answerOf(run)).toBe("second answer");
    expect(provider.requests).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "run", runId: run.id, status: "completed" });
  });

  test("background tool waits without another model call and resumes with the supplied result", async () => {
    let executed = 0;
    const provider = scripted(calls("job"), text());
    const runtime = new AgentRuntime({ store: store(), provider, tools: [tool("job", {
      execute: async () => { executed++; return { content: "started", waitFor: "job-1" }; },
    })] });
    const waiting = await runtime.start({ model: "fake", input: "work" });
    expect(waiting.status).toBe("waiting");
    expect(provider.requests).toHaveLength(1);
    runtime.completeTool(waiting.id, "call-0", { content: "job finished" });
    const run = await runtime.resume(waiting.id);
    expect(run.status).toBe("completed");
    expect(executed).toBe(1);
    expect(run.messages.find(message => message.role === "tool")?.content).toBe("job finished");
  });

  test("single model slot does not deadlock a child, and approvals propagate as a wait", async () => {
    const sub: ModelEvent = { type: "response", message: { role: "assistant", content: "", toolCalls: [
      { id: "sub-1", name: "subagent", arguments: JSON.stringify({ input: "child work" }) },
    ] }, finish: "tools" };
    const provider = scripted(sub, calls("danger"), text("child done"), text("parent done"));
    const runtime = new AgentRuntime({ store: store(), provider, modelConcurrency: 1, toolConcurrency: 1,
      tools: [tool("danger", { needsApproval: true })] });
    const parent = await runtime.start({ model: "fake", input: "parent", tools: ["subagent", "danger"] });
    expect(parent.status).toBe("waiting");
    const childId = parent.pendingTools[0].childRunId!;
    expect(runtime.inspect(childId).status).toBe("awaiting_approval");
    expect(runtime.inspect(childId).tools).not.toContain("subagent");
    runtime.approve(childId, "call-0", true);
    const completed = await runtime.resume(parent.id);
    expect(answerOf(completed)).toBe("parent done");
    expect(runtime.store.runs()).toHaveLength(2);
    expect(runtime.store.budget(parent.rootId).requests).toBe(4);
  });

  test("child cannot expand tool scope and root budget covers descendants", async () => {
    const sub: ModelEvent = { type: "response", message: { role: "assistant", content: "", toolCalls: [
      { id: "sub", name: "subagent", arguments: JSON.stringify({ input: "child", tools: ["hidden"] }) },
    ] }, finish: "tools" };
    const provider = scripted(sub, text());
    const runtime = new AgentRuntime({ store: store(), provider, tools: [tool("hidden")] });
    const run = await runtime.start({ model: "fake", input: "parent", tools: ["subagent"] });
    expect(run.messages.find(message => message.role === "tool")?.content).toContain("not available");
    expect(runtime.store.runs()).toHaveLength(1);
    const limited = new AgentRuntime({ store: store(), provider: scripted(calls("subagent")) });
    const result = await limited.start({ model: "fake", input: "work", limits: { maxRequests: 1 } });
    expect(result.status).toBe("limited");
    expect(limited.store.budget(result.rootId).requests).toBe(1);
  });

  test("cancellation stops queued writes and never retries an uncertain side effect", async () => {
    const entered = deferred<void>();
    let writes = 0;
    const runtime = new AgentRuntime({ store: store(), provider: scripted(calls("write", "later")), tools: [
      tool("write", { execute: async (_args, context) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
        return { content: "never" };
      } }), tool("later", { execute: async () => { writes++; return { content: "bad" }; } }),
    ] });
    const id = runtime.create({ model: "fake", input: "work" });
    const running = runtime.resume(id);
    await entered.promise;
    runtime.cancel(id);
    const run = await running;
    expect(run.status).toBe("cancelled");
    expect(run.pendingTools[0].status).toBe("uncertain");
    expect(writes).toBe(0);
  });

  test("restart marks side effects uncertain; explicit resolution avoids replay", async () => {
    let executions = 0;
    const runtime = new AgentRuntime({ store: store(), provider: scripted(text()), tools: [tool("write", {
      execute: async () => { executions++; return { content: "duplicate" }; },
    })] });
    const id = runtime.create({ model: "fake", input: "work" });
    const run = runtime.inspect(id);
    run.status = "running";
    run.messages.push({ role: "assistant", content: "", toolCalls: [{ id: "call-0", name: "write", arguments: "{}" }] });
    run.pendingTools = [{ call: run.messages.at(-1)!.toolCalls![0], status: "running", approval: "auto" }];
    runtime.store.save(run);
    expect(runtime.recover()).toEqual([id]);
    await expect(runtime.resume(id)).rejects.toThrow("explicit resolution");
    runtime.resolveInterrupted(id, "call-0", { content: "confirmed already done" });
    const result = await runtime.resume(id);
    expect(result.status).toBe("completed");
    expect(executions).toBe(0);
    expect(result.messages.find(message => message.role === "tool")?.content).toBe("confirmed already done");
  });

  test("only zero-output transient errors retry, with shared attempt accounting", async () => {
    let attempts = 0;
    const provider: ModelProvider = { async *stream() {
      if (++attempts < 2) throw new ProviderError("temporary", true);
      yield text();
    } };
    const runtime = new AgentRuntime({ store: store(), provider, retryDelayMs: 0 });
    const result = await runtime.start({ model: "fake", input: "work" });
    expect(result.status).toBe("completed");
    expect(runtime.store.budget(result.rootId).requests).toBe(2);
    let visibleAttempts = 0;
    const partial: ModelProvider = { async *stream() {
      visibleAttempts++;
      yield { type: "text", delta: "half" };
      throw new ProviderError("drop", true);
    } };
    const broken = new AgentRuntime({ store: store(), provider: partial, retryDelayMs: 0 });
    expect((await broken.start({ model: "fake", input: "work" })).status).toBe("failed");
    expect(visibleAttempts).toBe(1);
    expect(broken.store.runs()[0].draft?.content).toBe("half");
  });

  test("large tool output is recoverable through artifact paging", async () => {
    const runtime = new AgentRuntime({ store: store(), provider: scripted(calls("read"), text()), tools: [tool("read", {
      execute: async () => ({ content: "A".repeat(1000) }),
    })] });
    const run = await runtime.start({ model: "fake", input: "work", limits: { maxToolOutputChars: 50 } });
    const output = run.messages.find(message => message.role === "tool")!.content;
    const id = output.match(/artifact ([a-f0-9-]+)/)![1];
    expect(output.length).toBeLessThan(200);
    expect(runtime.store.readArtifact(id, 100, 10)).toBe("A".repeat(10));
  });

  test("context compaction preserves system instructions and complete tool groups", async () => {
    const history: Message[] = [
      { role: "user", content: "old task " + "x".repeat(500) },
      { role: "assistant", content: "", toolCalls: [{ id: "old-call", name: "read", arguments: "{}" }] },
      { role: "tool", toolCallId: "old-call", content: "evidence" },
      { role: "assistant", content: "old answer" },
    ];
    const provider = scripted(text("Task summary with evidence"), request => {
      expect(request.messages[0].content).toBe("system rule");
      expect(request.messages.some(message => message.content.includes("Earlier work summary"))).toBe(true);
      validateHistory(request.messages);
      return Promise.resolve(text("continued"));
    });
    const count = (messages: readonly Message[], tools: readonly ToolDeclaration[]) => JSON.stringify(messages).length + tools.length * 500;
    const runtime = new AgentRuntime({ store: store(), provider, countTokens: count });
    const run = await runtime.start({ model: "fake", system: "system rule", input: "continue", history,
      tools: [], limits: { contextTokens: 1400, keepRecentTokens: 10, maxOutputTokens: 150 } });
    expect(run.status).toBe("completed");
    expect(provider.requests).toHaveLength(2);
    const grouped = contextSplit(history, 60);
    validateHistory(grouped.recent);
  });

  test("observer exceptions cannot fail the agent; duplicate call IDs are rejected", async () => {
    const runtime = new AgentRuntime({ store: store(), provider: scripted(text()), onEvent: () => { throw new Error("UI failed"); } });
    expect((await runtime.start({ model: "fake", input: "hello" })).status).toBe("completed");
    const duplicate = calls("read", "read");
    if (duplicate.type === "response") duplicate.message.toolCalls![1].id = "call-0";
    const invalid = new AgentRuntime({ store: store(), provider: scripted(duplicate), tools: [tool("read")] });
    expect((await invalid.start({ model: "fake", input: "work" })).error).toContain("Duplicate");
  });

  test("repeated identical tool failures stop before exhausting all requests", async () => {
    let round = 0;
    const provider: ModelProvider = { async *stream() {
      yield { type: "response", message: { role: "assistant", content: "", toolCalls: [
        { id: `missing-${round++}`, name: "missing", arguments: "{}" },
      ] }, finish: "tools" };
    } };
    const runtime = new AgentRuntime({ store: store(), provider });
    const run = await runtime.start({ model: "fake", input: "work" });
    expect(run.status).toBe("limited");
    expect(run.error).toContain("Repeated tool failure");
    expect(round).toBe(3);
    validateHistory(run.messages);
  });

  test("artifact reads cannot access another root task", async () => {
    const database = store();
    const artifact = database.artifact("private result", "another-root");
    const call: ModelEvent = { type: "response", message: { role: "assistant", content: "", toolCalls: [
      { id: "artifact", name: "artifact_read", arguments: JSON.stringify({ id: artifact }) },
    ] }, finish: "tools" };
    const runtime = new AgentRuntime({ store: database, provider: scripted(call, text()) });
    const run = await runtime.start({ model: "fake", input: "read artifact" });
    const result = run.messages.find(message => message.role === "tool")?.content ?? "";
    expect(result).toContain("Unknown artifact");
    expect(result).not.toContain("private result");
  });
});
