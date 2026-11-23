import { expect, test } from "bun:test";
import { AgentRuntime, KernelStore, OpenAIProvider, Superagent } from "../src/index.ts";

test("superagent → real SSE parser → tools → dependent task → durable delivery", async () => {
  const requests: Array<{ messages: Array<{ role: string; content: string | null; tool_call_id?: string }> }> = [];
  const executed: string[] = [];
  const provider = new OpenAIProvider({ endpoint: "https://test.invalid/chat/completions", fetch: (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as typeof requests[number];
    requests.push(body);
    const toolResponse = body.messages.at(-1)?.role === "tool";
    const summary = body.messages.at(-1)?.content?.includes("Assignment: summarize");
    const delta = toolResponse || summary ? { content: toolResponse ? "Inspection evidence: file exists" : "Final summary based on inspection" } :
      { tool_calls: [{ index: 0, id: "inspect", type: "function", function: { name: "read", arguments: '{"path":"input.txt"}' } }] };
    const frames = [
      { choices: [{ delta, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: toolResponse || summary ? "stop" : "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(frames, { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch });
  const store = new KernelStore();
  try {
    const runtime = new AgentRuntime({ store, provider, tools: [{ name: "read", description: "read file", readOnly: true,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async args => { executed.push((args as { path: string }).path); return { content: "file exists" }; },
    }] });
    const supervisor = new Superagent({ runtime, verify: async task => ({ ok: Boolean(task.result), evidence: "tool result or dependent result" }) });
    const ticket = supervisor.accept({ source: "bot", triggerId: "message-1", model: "test", prompt: "inspect then summarize", tools: ["read"],
      tasks: [{ id: "inspect", prompt: "inspect" }, { id: "summary", prompt: "summarize", dependsOn: ["inspect"] }] });
    const result = await supervisor.advance(ticket.id);
    expect(result.status).toBe("ready");
    expect(executed).toEqual(["input.txt"]);
    expect(requests).toHaveLength(3);
    expect(requests[1].messages.at(-1)).toEqual({ role: "tool", content: "file exists", tool_call_id: "inspect" });
    expect(requests[2].messages.at(-1)?.content).toContain("Inspection evidence: file exists");
    expect(store.budget(ticket.id)).toMatchObject({ requests: 3, tokens: 360 });
    const output: string[] = [];
    await supervisor.flush(async delivery => { output.push(delivery.content); });
    expect(output[0]).toContain("Final summary");
    expect(store.deliveries()).toHaveLength(0);
  } finally { store.close(); }
});
