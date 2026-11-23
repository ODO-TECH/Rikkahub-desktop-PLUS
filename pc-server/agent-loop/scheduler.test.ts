// agent-loop/scheduler.test.ts — 生命周期 L3:耐久调度 tick 的契约
//
// 钉住:once 只跑一次、interval 边界校验、catch_up_once 只补一次、skip 前进不补、
// 忙会话不堆队列、开关关闭零副作用、重复 tick 不重复领取、last_run_* 回写。
// 时间全部注入,不真实等待;生成入口用闸门委托桩隔离(不发真实请求)。
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import { getConversationsDb, openConversationsDb } from "../conversations";
import { setState, state } from "../persistence/json-store";
import type { State } from "../foundation/types";

// orchestrator 是全量重模块:只桩掉 dispatchMessageQueue(调度投递的唯一出口),
// 其余透传;闸门关闭时完全委托真实实现,避免跨文件泄漏。
import * as actualOrchestrator from "../conversations/orchestrator";

const realDispatch = actualOrchestrator.dispatchMessageQueue;
let schedulerGateActive = false;
const dispatched: string[] = [];
mock.module("../conversations/orchestrator", () => ({
  ...actualOrchestrator,
  dispatchMessageQueue: (conversationId: string) => {
    if (!schedulerGateActive) return realDispatch(conversationId);
    dispatched.push(conversationId);
  },
}));

const { clearMessageQueue, enqueueMessage, hasQueuedMessages, queueLength } = await import("../conversations/message-queue");
const { deleteSchedulesForConversations, createSchedule, getSchedule, markScheduleRun, updateSchedule } = await import("./schedule-store");
const { runSchedulerTick } = await import("./scheduler");

const db = getConversationsDb() ?? openConversationsDb();
const CONV = `sched-conv-${process.pid}`;
db.prepare(
  "INSERT OR IGNORE INTO pc_conversation (id, assistant_id, title, create_at, update_at) VALUES (?, 'a1', 't', 1, 1)",
).run(CONV);
// 调度器要求会话可被 getConversation 解析:注册到 working set。
const { registerConversation, configureWorkingSet } = await import("../conversations/working-set");
const conversation = {
  id: CONV, assistantId: "a1", title: "t", systemPrompt: null, messages: [],
  chatSuggestions: [], isPinned: false, createAt: 1, updateAt: 1,
} as never;
registerConversation(conversation);

const priorState = state;
beforeAll(() => {
  schedulerGateActive = true;
  configureWorkingSet({
    loadConversation: (id: string) => (id === CONV ? (conversation as never) : undefined),
    isGenerating: () => false,
    hasSseClients: () => false,
    hasDirty: () => false,
  });
});

afterAll(() => {
  schedulerGateActive = false;
  setState(priorState);
  clearMessageQueue(CONV);
  db.prepare("DELETE FROM pc_conversation WHERE id = ?").run(CONV);
});

function enableScheduling(enabled: boolean, schedulingEnabled: boolean): void {
  setState({
    settings: {
      assistantId: "a1",
      assistants: [],
      chatModelId: "",
      agentLoop: {
        enabled,
        transportRetry: true,
        maxReplans: 2,
        stallRepeatLimit: 3,
        sameErrorLimit: 3,
        requireVerifiedCompletion: true,
        schedulingEnabled,
      },
    },
  } as unknown as State);
}

function clearSchedules(): void {
  db.prepare("DELETE FROM pc_task_schedule WHERE conversation_id = ?").run(CONV);
  clearMessageQueue(CONV);
  dispatched.length = 0;
}

describe("调度 tick", () => {
  test("once 到期只跑一次;重复 tick 不重复领取", () => {
    clearSchedules();
    enableScheduling(true, true);
    const now = 1_000_000;
    const created = createSchedule(CONV, { goal: "跑一次", kind: "once", runAt: now + 1_000 }, now);
    expect(created.ok).toBe(true);

    expect(runSchedulerTick(now).delivered).toBe(0); // 未到期
    const atDue = runSchedulerTick(now + 2_000);
    expect(atDue.delivered).toBe(1);
    expect(dispatched).toEqual([CONV]);
    expect(hasQueuedMessages(CONV)).toBe(true);
    expect(queueLength(CONV)).toBe(1);

    const again = runSchedulerTick(now + 2_000);
    expect(again.delivered).toBe(0);
    const schedule = getSchedule(CONV, created.ok ? created.schedule.id : "");
    expect(schedule?.enabled).toBe(false);
  });

  test("interval 边界:小于 60s / 大于 30 天拒绝,合法值按 now+interval 排期", () => {
    clearSchedules();
    const now = 2_000_000;
    expect(createSchedule(CONV, { goal: "太短", kind: "fixed_interval", intervalSeconds: 30 }, now).ok).toBe(false);
    expect(
      createSchedule(CONV, { goal: "太长", kind: "fixed_interval", intervalSeconds: 2_592_001 }, now).ok,
    ).toBe(false);
    const ok = createSchedule(CONV, { goal: "每小时", kind: "fixed_interval", intervalSeconds: 3600 }, now);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.schedule.nextRunAt).toBe(now + 3_600_000);
  });

  test("catch_up_once:忙会话退避 60s 不投递;空闲后只补一次,不逐周期堆积", () => {
    clearSchedules();
    enableScheduling(true, true);
    const now = 3_000_000;
    const created = createSchedule(
      CONV,
      { goal: "补跑一次", kind: "fixed_interval", intervalSeconds: 60 },
      now,
    );
    expect(created.ok).toBe(true);
    // 制造忙:队列里已有一条待生成。
    enqueueMessage(CONV, [{ type: "text", text: "占位" }]);

    // 到期且忙:退避,不投递(队列长度不变)。
    const busyTick = runSchedulerTick(now + 120_000);
    expect(busyTick.deferred).toBe(1);
    expect(busyTick.delivered).toBe(0);
    expect(queueLength(CONV)).toBe(1);
    const deferred = getSchedule(CONV, created.ok ? created.schedule.id : "")!;
    expect(deferred.nextRunAt).toBe(now + 120_000 + 60_000);

    // 空闲后:只补一次,下一次排到 now+interval。
    clearMessageQueue(CONV);
    const catchUp = runSchedulerTick(now + 180_000);
    expect(catchUp.delivered).toBe(1);
    expect(queueLength(CONV)).toBe(1);
    if (!created.ok) throw new Error("schedule create failed");
    const after = getSchedule(CONV, created.schedule.id)!;
    expect(after.nextRunAt).toBe(now + 180_000 + 60_000);
  });

  test("skip:忙会话直接跳到下一个未来时点,不补跑", () => {
    clearSchedules();
    enableScheduling(true, true);
    const now = 4_000_000;
    const created = createSchedule(
      CONV,
      { goal: "跳过", kind: "fixed_interval", intervalSeconds: 300, misfirePolicy: "skip" },
      now,
    );
    expect(created.ok).toBe(true);
    enqueueMessage(CONV, [{ type: "text", text: "占位" }]);

    const tick = runSchedulerTick(now + 400_000);
    expect(tick.deferred).toBe(1);
    expect(tick.delivered).toBe(0);
    const row = getSchedule(CONV, created.ok ? created.schedule.id : "")!;
    expect(row.nextRunAt).toBe(now + 400_000 + 300_000);
    expect(queueLength(CONV)).toBe(1); // 只有占位那条,没有补跑
  });

  test("调度关闭不投递；已退役的 Agent 总开关不再阻止明确启用的调度", () => {
    clearSchedules();
    const now = 5_000_000;
    const created = createSchedule(CONV, { goal: "关着", kind: "fixed_interval", intervalSeconds: 60 }, now);
    expect(created.ok).toBe(true);

    enableScheduling(true, false);
    expect(runSchedulerTick(now + 120_000).delivered).toBe(0);
    expect(queueLength(CONV)).toBe(0);

    enableScheduling(false, true);
    expect(runSchedulerTick(now + 120_000).delivered).toBe(1);

    // 记录仍在:开关关闭只停投递,不删记录。
    expect(getSchedule(CONV, created.ok ? created.schedule.id : "")).not.toBeNull();
  });

  test("PATCH 只改目标不重排;改时间规则才重算 next_run_at", () => {
    clearSchedules();
    const now = 6_000_000;
    const created = createSchedule(CONV, { goal: "旧目标", kind: "fixed_interval", intervalSeconds: 60 }, now);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = created.schedule.nextRunAt;

    const goalOnly = updateSchedule(CONV, created.schedule.id, { goal: "新目标" }, now + 5_000);
    expect(goalOnly.ok).toBe(true);
    if (goalOnly.ok) {
      expect(goalOnly.schedule.goal).toBe("新目标");
      expect(goalOnly.schedule.nextRunAt).toBe(before);
    }

    const interval = updateSchedule(CONV, created.schedule.id, { intervalSeconds: 600 }, now + 10_000);
    expect(interval.ok).toBe(true);
    if (interval.ok) expect(interval.schedule.nextRunAt).toBe(now + 10_000 + 600_000);
  });

  test("last_run_* 回写;删除会话显式清理调度记录", () => {
    clearSchedules();
    const now = 7_000_000;
    const created = createSchedule(CONV, { goal: "回写", kind: "once", runAt: now + 1 }, now);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    markScheduleRun(created.schedule.id, "run-9", now + 500);
    expect(getSchedule(CONV, created.schedule.id)).toMatchObject({
      lastRunAt: now + 500,
      lastRunId: "run-9",
    });

    deleteSchedulesForConversations(db, [CONV]);
    expect(getSchedule(CONV, created.schedule.id)).toBeNull();
  });
});
