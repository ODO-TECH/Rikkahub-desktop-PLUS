// Runs in a fresh process: paths/state/provider replacement must not leak into other tests.
import assert from "node:assert/strict";
import { join } from "node:path";
import { AgentRuntime, KernelStore } from "../../agent-kernel/src/index";
import type { ModelEvent, ModelRequest } from "../../agent-kernel/src/types";
import { defaultState } from "../app-config/defaults";
import { setState } from "../persistence/json-store";
import { defaultAssistant } from "../assistants";
import { message } from "../foundation/utils";
import { model, provider } from "../model-providers";
import type { Conversation, MessageNode } from "../foundation/types";
import type { EngineRunContext } from "../engines";
import { DesktopProvider } from "../kernel-engine/provider";
import { runKernelGeneration, kernelRunViews } from "../kernel-engine/driver";

const scenario = process.argv[2];
const state = defaultState();
const assistant = defaultAssistant();
assistant.enabledSkills = [];
assistant.mcpServers = [];
state.settings.assistants = [assistant];
setState(state);
const requests: ModelRequest[] = [];
DesktopProvider.prototype.stream = async function* (request): AsyncGenerator<ModelEvent> {
  requests.push(structuredClone(request));
  yield { type: "response", finish: "stop", message: { role: "assistant", content: `reply-${requests.length}` } };
};
function node(text: string, role: "USER" | "ASSISTANT" = "USER"): MessageNode {
  return { id: crypto.randomUUID(), selectIndex: 0, messages: [message(role, [{ type: "text", text }])] };
}
const conversation: Conversation = {
  id: "history-test", assistantId: assistant.id, title: "history-test", systemPrompt: null,
  messages: [node("original-user")], chatSuggestions: [], isPinned: false, createAt: 1, updateAt: 1,
  executionMode: "agent",
};
const selected = model("fake", "Fake");
const host = provider({ id: "history-test", name: "local-fake", baseUrl: "http://127.0.0.1:1/v1", models: [selected] });
const roots: string[] = [];
async function turn() {
  const target = node("", "ASSISTANT");
  conversation.messages.push(target);
  const ctx: EngineRunContext = {
    conversation, assistant, model: selected, provider: host,
    target: { node: target, message: target.messages[0]! },
    executeTool: async () => { throw new Error("Unexpected tool execution"); },
  };
  const reply = await runKernelGeneration(ctx, () => {});
  target.messages[0]!.parts = [{ type: "text", text: reply }];
  const root = target.messages[0]!.annotations.find(a => a && typeof a === "object" && "type" in a && a.type === "kernel_run") as { type: string; id: string };
  assert(root?.id);
  roots.push(root.id);
  return reply;
}
const text = () => JSON.stringify(requests.at(-1)!.messages);

if (scenario === "recovery") {
  const store = new KernelStore(join(process.env.RIKKAHUB_PC_DATA_DIR!, "agent-kernel.sqlite"));
  const runtime = new AgentRuntime({ store, provider: { async *stream() { throw new Error("must not replay"); } } });
  const oldId = runtime.create({ model: "fake", input: "stale-native-history" });
  const old = runtime.inspect(oldId);
  old.status = "running";
  old.pendingTools = [{ call: { id: "uncertain-call", name: "side_effect", arguments: "{}" }, status: "running", approval: "auto" }];
  store.save(old);
  store.close(); // simulate previous process leaving a running run on disk
  await turn(); // production driver invokes recover once, then creates its own new root
  const reopened = new KernelStore(join(process.env.RIKKAHUB_PC_DATA_DIR!, "agent-kernel.sqlite"));
  assert.equal(reopened.run(oldId).status, "interrupted");
  assert.equal(reopened.run(oldId).pendingTools[0]!.status, "uncertain");
  assert.notEqual(roots[0], oldId);
  assert.equal(requests.length, 1);
  assert(!text().includes("stale-native-history"));
  reopened.close();
} else {
  await turn();
  if (scenario === "two-turns") {
    // The app's edited answer must win over the original reply saved in the kernel store.
    conversation.messages[1]!.messages[0]!.parts = [{ type: "text", text: "app-owned-answer" }];
    conversation.messages.push(node("second-question"));
    await turn();
    assert(text().includes("app-owned-answer"));
    assert(!text().includes("reply-1"));
    assert(text().includes("second-question"));
    assert.notEqual(roots[0], roots[1]);
  } else if (scenario === "edit") {
    conversation.messages = [node("edited-user")];
    await turn();
    assert(text().includes("edited-user"));
    assert(!text().includes("original-user"));
    assert(!text().includes("reply-1"));
  } else if (scenario === "branch") {
    const answerNode = conversation.messages[1]!;
    answerNode.messages.push(message("ASSISTANT", [{ type: "text", text: "selected-branch-answer" }]));
    answerNode.selectIndex = 1;
    conversation.messages.push(node("branch-question"));
    await turn();
    assert(text().includes("selected-branch-answer"));
    assert(!text().includes("reply-1"));
  } else if (scenario === "delete") {
    assert(kernelRunViews(roots).some(r => r.id === roots[0]));
    // Same root derivation as GET conversations/:id/kernel-runs; deleting the conversation
    // removes all selected-branch annotations from the app's reachable records.
    conversation.messages = [];
    const reachableRoots = conversation.messages.flatMap(n => n.messages[n.selectIndex]?.annotations ?? [])
      .filter(a => a && typeof a === "object" && "type" in a && a.type === "kernel_run").map(a => String((a as any).id));
    assert.deepEqual(kernelRunViews(reachableRoots), []);
    assert(kernelRunViews(roots).length > 0); // historical kernel rows remain intact
  } else throw new Error(`Unknown scenario ${scenario}`);
}
console.log(`PASS ${scenario}`);
