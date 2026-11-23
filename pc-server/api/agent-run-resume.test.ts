// api/agent-run-resume.test.ts — 生命周期 L2:中断 run 的用户显式恢复路由契约
//
// 钉住:恢复判定(404/409 矩阵)、恢复消息的形状(固定文本 + run_resume 注解)、
// 旧 run 只读(状态不被改写)、重复点击只产生一个活动生成、suspended 不得经本接口
// 绕过审批。
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-agent-run-resume-"));

import type { Conversation, Message, State } from "../foundation/types";
import { generating } from "../conversations/generation-state";
import { state, setState } from "../persistence/json-store";
import * as actualOrchestrator from "../conversations/orchestrator";

// bun 的 mock.module 全局生效且跨测试文件不回收:闸门委托式桩——仅本文件用例激活时
// 改写 generateAnswer(测试无 provider,不能真跑引擎),其余时候透传真实实现。
const realGenerateAnswer = actualOrchestrator.generateAnswer;
let resumeGateActive = false;
const generatedIds: string[] = [];
mock.module("../conversations/orchestrator", () => ({
  ...actualOrchestrator,
  generateAnswer: async (conversation: Conversation, ...rest: unknown[]) => {
    if (!resumeGateActive) return realGenerateAnswer(conversation, ...(rest as []));
    // 复刻真实入口的同步占位语义(generating.set 在首个 await 之前),这是重复点击
    // 必须落到 409 的依据;不触发真实引擎。
    generating.set(conversation.id, new AbortController());
    generatedIds.push(conversation.id);
  },
}));

const conversations = await import("../conversations");
const { configureWorkingSet, registerConversation } = await import("../conversations/working-set");
const { abortGeneration } = await import("../conversations/generation-state");
const { insertRun, getRun, updateRun } = await import("../agent-loop/run-store");
const { handleConversationRoutes } = await import("./handlers/conversations");

const priorState = state;
const db = conversations.openConversationsDb();

function seedConversationRow(id: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO pc_conversation (id, assistant_id, title, create_at, update_at) VALUES (?, 'a1', 't', 1, 1)",
  ).run(id);
}

function makeMessage(role: Message["role"], parts: Message["parts"]): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    role,
    parts,
    annotations: [],
    createdAt: new Date(1).toISOString(),
    finishedAt: null,
  } as unknown as Message;
}

function makeConversation(id: string, messages: Message[] = [makeMessage("USER", [{ type: "text", text: "hi" }])]): Conversation {
  return {
    id,
    assistantId: "a1",
    title: id,
    systemPrompt: null,
    // 与线上结构一致:每个节点一条消息,selectIndex 选分支。
    messages: messages.map((entry, index) => ({ id: `${id}-n${index}`, selectIndex: 0, messages: [entry] })),
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 1,
  } as unknown as Conversation;
}

/** 测试隔离:abort 只发信号,生成续体清理是异步的;直接摘除占位避免串扰。 */
function clearGenerating(conversationId: string): void {
  abortGeneration(conversationId, "replaced");
  generating.delete(conversationId);
}

const registry = new Map<string, Conversation>();
function seedConversation(id: string, messages?: Message[]): Conversation {
  seedConversationRow(id);
  const conversation = makeConversation(id, messages);
  registry.set(id, conversation);
  registerConversation(conversation);
  return conversation;
}

beforeAll(() => {
  resumeGateActive = true;
  setState({
    settings: {
      assistantId: "a1",
      assistants: [],
      chatModelId: "",
      agentLoop: {
        enabled: true,
        transportRetry: true,
        maxReplans: 2,
        stallRepeatLimit: 3,
        sameErrorLimit: 3,
        requireVerifiedCompletion: true,
        schedulingEnabled: false,
      },
    },
  } as unknown as State);
  configureWorkingSet({
    loadConversation: (conversationId) => registry.get(conversationId),
    isGenerating: (conversationId) => generating.has(conversationId),
    hasSseClients: () => false,
    hasDirty: () => false,
  });
});

afterAll(() => {
  resumeGateActive = false;
  setState(priorState);
  db.prepare("DELETE FROM pc_conversation WHERE id LIKE 'resume-%'").run();
});

async function call(
  target: string,
  method = "GET",
): Promise<{ status: number; body: any }> {
  const url = new URL(`http://127.0.0.1/api/${target}`);
  const request = new Request(url, { method });
  const response = await handleConversationRoutes(request, url, target);
  if (!response) throw new Error(`路由未命中: ${target}`);
  return { status: response.status, body: await response.json().catch(() => null) };
}

const CONV = "resume-a";
const OTHER = "resume-b";

// 中断 run(进程重启收敛后的样子):stopped + interrupted
seedConversation(CONV);
insertRun({ id: "resume-run-interrupted", conversationId: CONV, nodeId: null, engine: "chat", startedAt: 10 });
updateRun("resume-run-interrupted", { status: "stopped", stopReason: "interrupted", endedAt: 20 });
// 已完成 run
insertRun({ id: "resume-run-done", conversationId: CONV, nodeId: null, engine: "chat", startedAt: 30 });
updateRun("resume-run-done", { status: "succeeded", endedAt: 40 });
// 暂停 run(对应消息流里有待执行审批)
seedConversation(OTHER, [
  makeMessage("USER", [{ type: "text", text: "hi" }]),
  makeMessage("ASSISTANT", [
    { type: "tool", toolCallId: "tc-1", toolName: "bash", input: "{}", output: [], approvalState: { type: "approved" } } as never,
  ]),
]);
insertRun({ id: "resume-run-suspended", conversationId: OTHER, nodeId: null, engine: "chat", startedAt: 50 });
updateRun("resume-run-suspended", { status: "suspended", phase: "awaiting_approval" });

describe("GET recovery 判定", () => {
  test("中断 run → new_run;完成 run → none + 原因;跨会话/未知 → 404", async () => {
    const resumable = await call(`conversations/${CONV}/agent-runs/resume-run-interrupted/recovery`);
    expect(resumable.status).toBe(200);
    expect(resumable.body).toMatchObject({ runId: "resume-run-interrupted", mode: "new_run", reason: null });
    expect(resumable.body.checkpoint.throughSeq).toBeGreaterThanOrEqual(0);

    const done = await call(`conversations/${CONV}/agent-runs/resume-run-done/recovery`);
    expect(done.body).toMatchObject({ mode: "none", reason: "status_succeeded" });

    const suspended = await call(`conversations/${OTHER}/agent-runs/resume-run-suspended/recovery`);
    expect(suspended.body).toMatchObject({ mode: "suspended", reason: null });

    expect((await call(`conversations/${OTHER}/agent-runs/resume-run-interrupted/recovery`)).status).toBe(404);
    expect((await call(`conversations/${CONV}/agent-runs/ghost/recovery`)).status).toBe(404);
  });

  test("会话忙 → conversation_busy", async () => {
    const controller = new AbortController();
    generating.set(CONV, controller);
    try {
      const busy = await call(`conversations/${CONV}/agent-runs/resume-run-interrupted/recovery`);
      expect(busy.body).toMatchObject({ mode: "none", reason: "conversation_busy" });
    } finally {
      generating.delete(CONV);
    }
  });
});

describe("POST resume 执行", () => {
  test("成功恢复:202 + 恢复消息落尾(固定文本 + run_resume 注解),旧 run 只读", async () => {
    const before = getRun("resume-run-interrupted")!;
    const { status, body } = await call(`conversations/${CONV}/agent-runs/resume-run-interrupted/resume`, "POST");
    expect(status).toBe(202);
    expect(body).toEqual({ status: "resumed", resumedFromRunId: "resume-run-interrupted" });

    const conversation = registry.get(CONV)!;
    const resumeNode = conversation.messages.find((node) =>
      node.messages.some((message) =>
        message.role === "USER" &&
        (message.annotations as Array<{ type?: string }>).some((entry) => entry.type === "run_resume"),
      ),
    );
    expect(resumeNode).toBeDefined();
    const resumeMessage = resumeNode!.messages[0];
    expect((resumeMessage.annotations as Array<{ type?: string; runId?: string }>)[0]).toEqual({
      type: "run_resume",
      runId: "resume-run-interrupted",
    });
    const text = (resumeMessage.parts[0] as { text?: string }).text ?? "";
    expect(text).toContain("Resume the interrupted task");

    // 旧 run 保持只读终局
    expect(getRun("resume-run-interrupted")).toMatchObject({
      status: before.status,
      stopReason: before.stopReason,
      endedAt: before.endedAt,
    });
    // 生成已被点火(同步占位);立即清理,后台失败不影响断言
    expect(generating.has(CONV)).toBe(true);
    clearGenerating(CONV);
  });

  test("重复点击:生成占位期间第二次恢复 → 409 conversation_busy", async () => {
    insertRun({ id: "resume-run-twice", conversationId: CONV, nodeId: null, engine: "chat", startedAt: 60 });
    updateRun("resume-run-twice", { status: "stopped", stopReason: "interrupted", endedAt: 70 });

    const first = await call(`conversations/${CONV}/agent-runs/resume-run-twice/resume`, "POST");
    expect(first.status).toBe(202);
    try {
      const second = await call(`conversations/${CONV}/agent-runs/resume-run-twice/resume`, "POST");
      expect(second.status).toBe(409);
    } finally {
      clearGenerating(CONV);
    }
  });

  test("纯对话模式不启动 Agent 恢复，保留原历史", async () => {
    registry.get(CONV)!.executionMode = "chat";
    insertRun({ id: "resume-run-off", conversationId: CONV, nodeId: null, engine: "chat", startedAt: 80 });
    updateRun("resume-run-off", { status: "stopped", stopReason: "interrupted", endedAt: 90 });
    setState({
      settings: { assistantId: "a1", assistants: [], chatModelId: "" },
    } as unknown as State);
    try {
      const nodeCount = registry.get(CONV)!.messages.length;
      // 判定与写入同口径:开关关闭时不宣称可恢复,POST 也被拒。
      const offRecovery = await call(`conversations/${CONV}/agent-runs/resume-run-off/recovery`);
      expect(offRecovery.body).toMatchObject({ mode: "none", reason: "feature_disabled" });
      expect((await call(`conversations/${CONV}/agent-runs/resume-run-off/resume`, "POST")).status).toBe(409);
      expect(registry.get(CONV)!.messages).toHaveLength(nodeCount);
    } finally {
      registry.get(CONV)!.executionMode = "agent";
      setState({
        settings: {
          assistantId: "a1",
          assistants: [],
          chatModelId: "",
          agentLoop: {
            enabled: true,
            transportRetry: true,
            maxReplans: 2,
            stallRepeatLimit: 3,
            sameErrorLimit: 3,
            requireVerifiedCompletion: true,
            schedulingEnabled: false,
          },
        },
      } as unknown as State);
    }
  });

  test("恢复矩阵:suspended/完成/未知/跨会话一律拒绝,不写消息", async () => {
    const nodeCount = registry.get(OTHER)!.messages.length;
    expect((await call(`conversations/${OTHER}/agent-runs/resume-run-suspended/resume`, "POST")).status).toBe(409);
    expect((await call(`conversations/${CONV}/agent-runs/resume-run-done/resume`, "POST")).status).toBe(409);
    expect((await call(`conversations/${CONV}/agent-runs/ghost/resume`, "POST")).status).toBe(404);
    expect((await call(`conversations/${OTHER}/agent-runs/resume-run-interrupted/resume`, "POST")).status).toBe(404);
    expect(registry.get(OTHER)!.messages).toHaveLength(nodeCount);
  });
});
