// agent-loop/run-tracker.test.ts — 运行状态机与流水(S1)
//
// 钉住观察者语义:轮边界去重与相位恢复、审批相位往返、pause-resume 的
// suspend → resume 接续同一条 run、终局幂等、engine_status 计数补全。
// 推送出口用 initAgentRunBroadcast 注入(与 api/sse 解耦的既有缝)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { AgentRunPushDto } from "./types";
import { getConversationsDb, openConversationsDb } from "../conversations";
import {
  activeRunFor,
  beginAgentRun,
  initAgentRunBroadcast,
  recordApprovalDecision,
  type AgentRunTracker,
} from "./run-tracker";
import { getRun, listRunEvents } from "./run-store";
import { setState, state } from "../persistence/json-store";
import { defaultState } from "../app-config/defaults";

const db = getConversationsDb() ?? openConversationsDb();
const CONV = `run-tracker-conv-${process.pid}`;
db.prepare(
  "INSERT OR IGNORE INTO pc_conversation (id, assistant_id, title, create_at, update_at) VALUES (?, 'a1', 't', 1, 1)",
).run(CONV);

const pushes: AgentRunPushDto[] = [];
beforeAll(() => {
  initAgentRunBroadcast((_conversationId, push) => pushes.push(push));
});

let tracker: AgentRunTracker;

afterAll(() => {
  tracker?.finishTerminal("stopped", { stopReason: "test-teardown" });
  initAgentRunBroadcast(() => {
    /* 撤掉测试出口 */
  });
  db.prepare("DELETE FROM pc_conversation WHERE id = ?").run(CONV);
});

describe("运行状态机", () => {
  test("begin 落库并推送 run_started;同轮重复边界不重复计数", () => {
    tracker = beginAgentRun({ conversationId: CONV, nodeId: "n1", engine: "chat" })!;
    expect(tracker).not.toBeNull();
    expect(activeRunFor(CONV)).toBe(tracker);
    expect(getRun(tracker.runId)).toMatchObject({ status: "running", phase: "planning", rounds: 0 });
    expect(pushes.at(-1)?.event?.kind).toBe("run_started");

    tracker.boundary(1);
    tracker.boundary(1); // 流式降级重采样:同轮幂等
    tracker.boundary(2);
    expect(getRun(tracker.runId)!.rounds).toBe(2);
    const rounds = listRunEvents(tracker.runId).filter((event) => event.kind === "round");
    expect(rounds.map((event) => event.payload)).toEqual([{ round: 1 }, { round: 2 }]);
    expect(getRun(tracker.runId)!.phase).toBe("acting");
  });

  test("工具调用 → 等待审批 → 批准,相位往返正确", () => {
    tracker.observe({
      kind: "tool_call_created",
      toolCallId: "tc1",
      toolName: "bash",
      input: "{}",
      approvalState: { type: "pending" },
    });
    expect(getRun(tracker.runId)!.phase).toBe("awaiting_approval");

    // Claude 路径建卡后还会补一发 pending 同步:同一等待不重复记流水
    tracker.observe({ kind: "tool_approval_updated", toolCallId: "tc1", approvalState: { type: "pending" } });
    expect(listRunEvents(tracker.runId).filter((event) => event.kind === "approval")).toHaveLength(1);

    tracker.observe({ kind: "tool_approval_updated", toolCallId: "tc1", approvalState: { type: "approved" } });
    expect(getRun(tracker.runId)!.phase).toBe("acting");
    const kinds = listRunEvents(tracker.runId).map((event) => event.kind);
    expect(kinds).toContain("tool_call");
    expect(kinds.filter((kind) => kind === "approval")).toHaveLength(2);

    // partial 工具帧不记账,终局帧记一次
    tracker.observe({ kind: "tool_result", toolCallId: "tc1", output: [], final: false });
    tracker.observe({ kind: "tool_result", toolCallId: "tc1", output: [] });
    expect(listRunEvents(tracker.runId).filter((event) => event.kind === "tool_result")).toHaveLength(1);
  });

  test("engine_status retrying 计 attempts;busy 结束时回 acting;enrichStatus 补计数", () => {
    tracker.observe({
      kind: "engine_status",
      status: { busy: true, phase: "retrying", attempt: 1, maxAttempts: 3 },
    });
    expect(getRun(tracker.runId)).toMatchObject({ phase: "retrying", attempts: 1 });
    tracker.observe({
      kind: "engine_status",
      status: { busy: true, phase: "retrying", attempt: 1, maxAttempts: 3 },
    });
    // 同一 attempt 的重复帧不重复记账
    expect(listRunEvents(tracker.runId).filter((event) => event.kind === "retry")).toHaveLength(1);
    tracker.observe({ kind: "engine_status", status: { busy: false } });
    expect(getRun(tracker.runId)!.phase).toBe("acting");

    const enriched = tracker.enrichStatus({ busy: true, phase: "compacting" });
    expect(enriched).toMatchObject({ runId: tracker.runId, round: 2, attempts: 1, replanCount: 0 });
    expect(tracker.enrichStatus({ busy: false })).toEqual({ busy: false });
  });

  test("审批暂停 suspend → 批准后 resume 接续同一条 run", () => {
    tracker.suspend();
    const suspendedId = tracker.runId;
    expect(getRun(suspendedId)).toMatchObject({ status: "suspended", phase: "awaiting_approval" });
    expect(activeRunFor(CONV)).toBeUndefined();

    // 暂停期间点审批卡:记进最近一条 suspended run(未记录过的决定)
    recordApprovalDecision(CONV, "tc2", true);
    expect(listRunEvents(suspendedId).at(-1)?.kind).toBe("approval");

    const resumed = beginAgentRun({
      conversationId: CONV,
      nodeId: "n1",
      engine: "chat",
      resumeSuspended: true,
    })!;
    expect(resumed.runId).toBe(suspendedId);
    expect(getRun(suspendedId)).toMatchObject({ status: "running", phase: "acting", endedAt: null });
    expect(listRunEvents(suspendedId).at(-1)?.kind).toBe("run_resumed");
    tracker = resumed;
  });

  test("终局幂等;ensureSettled 不覆盖已收敛的终局", () => {
    tracker.finishTerminal("succeeded");
    expect(getRun(tracker.runId)).toMatchObject({ status: "succeeded" });
    expect(getRun(tracker.runId)!.endedAt).not.toBeNull();
    expect(activeRunFor(CONV)).toBeUndefined();
    const finished = listRunEvents(tracker.runId).filter((event) => event.kind === "run_finished");
    expect(finished).toHaveLength(1);

    tracker.finishTerminal("failed", { error: "重复收敛" });
    tracker.ensureSettled("late-finally");
    expect(getRun(tracker.runId)).toMatchObject({ status: "succeeded", error: null });
    expect(listRunEvents(tracker.runId).filter((event) => event.kind === "run_finished")).toHaveLength(1);
  });

  test("S-F4:每轮一条 round_summary(嵌套单计),裁剪后体积与 token 估算同源", () => {
    // 决定性裁剪配置:>400 字符的结果按 200/60 头尾裁,原始与裁剪后字节必然不同。
    const prior = state;
    setState({
      ...defaultState(),
      settings: {
        ...defaultState().settings,
        resultClip: { enabled: true, thresholdChars: 400, headChars: 200, tailChars: 60 },
      },
    } as typeof state);
    try {
      const roundTracker = beginAgentRun({ conversationId: CONV, nodeId: "n1", engine: "pi" })!;
      roundTracker.boundary(1);
      roundTracker.observe({
        kind: "tool_call_created",
        toolCallId: "rc1",
        toolName: "run_code",
        input: "{\"code\":\"…\"}",
        approvalState: { type: "auto" },
      });
      roundTracker.observe({
        kind: "tool_call_created",
        toolCallId: "rc1:n1",
        toolName: "read",
        input: "{\"path\":\"big\"}",
        approvalState: { type: "auto" },
        metadata: { nestedInRunCode: "rc1" },
      });
      roundTracker.observe({
        kind: "tool_result",
        toolCallId: "rc1:n1",
        output: [{ type: "text", text: "y".repeat(900) }],
        final: true,
      });
      roundTracker.observe({
        kind: "tool_result",
        toolCallId: "rc1",
        output: [{ type: "text", text: "done" }],
        final: true,
      });
      const snapshot = roundTracker.roundSummary()!;
      expect(snapshot).toMatchObject({ round: 1, calls: 1, nestedCalls: 1, okCalls: 2 });
      expect(snapshot.resultBytesRaw).toBe(904);
      expect(snapshot.resultBytesClipped).toBeLessThan(snapshot.resultBytesRaw);
      expect(snapshot.rawTokensEst).toBeGreaterThan(200);
      expect(snapshot.savedTokensEst).toBeGreaterThan(0);
      // 轮边界先结算上一轮,再开新轮;流水恰好一条,round 归属 1。
      roundTracker.boundary(2);
      const summaries = listRunEvents(roundTracker.runId).filter((event) => event.kind === "round_summary");
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.payload).toMatchObject({ round: 1, calls: 1, nestedCalls: 1 });
      expect(summaries[0]!.summary.length).toBeLessThanOrEqual(240);
      expect(summaries[0]!.summary).toContain("嵌套 1");
      // 第 2 轮无调用 → 终局不产空汇总。
      roundTracker.finishTerminal("succeeded");
      expect(listRunEvents(roundTracker.runId).filter((event) => event.kind === "round_summary")).toHaveLength(1);
    } finally {
      setState(prior);
    }
  });

  test("S-F4:同一调用重复结果只记一条 round_summary;失败结果计 error 不进 okCalls", () => {
    const roundTracker = beginAgentRun({ conversationId: CONV, nodeId: "n1", engine: "chat" })!;
    roundTracker.boundary(1);
    roundTracker.observe({
      kind: "tool_call_created",
      toolCallId: "tc-fail",
      toolName: "bash",
      input: "{}",
      approvalState: { type: "auto" },
    });
    roundTracker.observe({ kind: "tool_result", toolCallId: "tc-fail", output: [{ type: "text", text: "ok" }], final: true });
    // 非终局帧不参与计账(与流水同纪律)。
    roundTracker.observe({ kind: "tool_result", toolCallId: "tc-fail", output: [{ type: "text", text: "ok" }], final: false });
    roundTracker.observe({ kind: "tool_result", toolCallId: "tc-fail", output: [{ error: "boom" }], final: true });
    const snapshot = roundTracker.roundSummary()!;
    expect(snapshot.calls).toBe(1);
    expect(snapshot.okCalls).toBe(1);
    roundTracker.finishTerminal("failed");
    expect(listRunEvents(roundTracker.runId).filter((event) => event.kind === "round_summary")).toHaveLength(1);
  });

  test("生命周期链接:beginAgentRun 写入 resumed_from_run_id / schedule_id", () => {
    const linked = beginAgentRun({
      conversationId: CONV,
      nodeId: "n1",
      engine: "chat",
      resumedFromRunId: "run-interrupted",
      scheduleId: "schedule-7",
    })!;
    expect(getRun(linked.runId)).toMatchObject({
      resumedFromRunId: "run-interrupted",
      scheduleId: "schedule-7",
    });
    const started = listRunEvents(linked.runId).find((event) => event.kind === "run_started");
    expect(started?.payload).toMatchObject({ resumedFromRunId: "run-interrupted", scheduleId: "schedule-7" });
    linked.finishTerminal("stopped", { stopReason: "test" });
  });
});
