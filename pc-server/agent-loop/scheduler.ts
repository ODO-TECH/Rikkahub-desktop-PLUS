// agent-loop/scheduler.ts — 生命周期 L3:耐久 once / fixed_interval 调度 tick
//
// 纪律:
//  - 投递 = 复用消息队列 + 唯一生成入口 generateAnswer(经 dispatchMessageQueue),
//    不新开第二条生成路径;USER 消息带 scheduled 注解,是普通新任务边界。
//  - 先推进再投递:事务/CAS 领取成功后才投递,进程中途死掉最多漏一次,不会重复跑。
//  - 忙会话(catch_up_once)退避 60s,空闲后只补一次;skip 直接跳到下一个未来时点。
//    两种策略都不逐周期堆积。
//  - tick 时间由参数注入,测试不真实等待;进程定时器 unref,不阻止退出。

import { getConversation } from "../conversations";
import { compressing, generating } from "../conversations/generation-state";
import {
  enqueueMessage,
  hasQueuedMessages,
  isQueueHeldByInterrupt,
  isQueuePaused,
} from "../conversations/message-queue";
import { dispatchMessageQueue } from "../conversations/orchestrator";
import { state } from "../persistence/json-store";
import {
  SCHEDULE_BUSY_BACKOFF_MS,
  claimScheduleAdvance,
  dueSchedules,
  nextScheduleTime,
  type TaskScheduleDto,
} from "./schedule-store";

export const SCHEDULE_TICK_MS = 15_000;
const SCHEDULE_TICK_BATCH = 20;

export interface SchedulerTickResult {
  /** 实际投递(进入队列/点火)的条数。 */
  delivered: number;
  /** 因会话缺失被禁用的条数。 */
  skipped: number;
  /** 因会话忙被退避的条数。 */
  deferred: number;
}

function schedulerEnabled(): boolean {
  const config = state.settings.agentLoop;
  return config?.schedulingEnabled === true;
}

function busy(conversationId: string): boolean {
  return (
    generating.has(conversationId) ||
    compressing.has(conversationId) ||
    hasQueuedMessages(conversationId) ||
    isQueuePaused(conversationId) ||
    isQueueHeldByInterrupt(conversationId)
  );
}

function deliver(schedule: TaskScheduleDto): boolean {
  const conversation = getConversation(schedule.conversationId);
  if (!conversation) return false;
  enqueueMessage(conversation.id, [{ type: "text", text: schedule.goal }], {
    annotations: [{ type: "scheduled", scheduleId: schedule.id }],
  });
  // 与 messages POST / 队列续跑同一入口:空闲时立即点火;若门控(暂停/压缩)拦下,
  // 消息留在队列,等既有 resume/收尾派发接手,不另造投递路径。
  dispatchMessageQueue(conversation.id);
  return true;
}

/** 领取后的推进计划:先落库再投递,避免崩溃/重复 tick 造成重复执行。 */
function advanceFor(schedule: TaskScheduleDto, now: number, isBusy: boolean): { nextRunAt: number; enabled: boolean } {
  if (isBusy) {
    if (schedule.misfirePolicy === "skip") {
      // skip:本次不跑;一次性调度没有下一次,直接禁用。
      return schedule.kind === "once"
        ? { nextRunAt: schedule.nextRunAt, enabled: false }
        : { nextRunAt: nextScheduleTime(schedule, now), enabled: true };
    }
    // catch_up_once:退避到 60s 后,空闲时只补一次。
    return { nextRunAt: now + SCHEDULE_BUSY_BACKOFF_MS, enabled: true };
  }
  if (schedule.kind === "once") {
    return { nextRunAt: schedule.nextRunAt, enabled: false };
  }
  return { nextRunAt: nextScheduleTime(schedule, now), enabled: true };
}

/** 单次 tick(纯同步,时间注入)。开关关闭时零副作用。 */
export function runSchedulerTick(now = Date.now()): SchedulerTickResult {
  const result: SchedulerTickResult = { delivered: 0, skipped: 0, deferred: 0 };
  if (!schedulerEnabled()) return result;

  for (const schedule of dueSchedules(now, SCHEDULE_TICK_BATCH)) {
    const conversation = getConversation(schedule.conversationId);
    if (!conversation) {
      // 目标会话不存在:禁用并保留记录(审计可见),绝不重建会话。
      if (claimScheduleAdvance(schedule, { nextRunAt: schedule.nextRunAt, enabled: false }, now)) {
        result.skipped += 1;
      }
      continue;
    }
    const isBusy = busy(conversation.id);
    const advance = advanceFor(schedule, now, isBusy);
    if (!claimScheduleAdvance(schedule, advance, now)) continue; // 已被其他 tick 领取
    if (isBusy) {
      result.deferred += 1;
      continue;
    }
    if (deliver(schedule)) result.delivered += 1;
    else result.skipped += 1;
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

function start(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      const outcome = runSchedulerTick();
      if (outcome.delivered > 0 || outcome.skipped > 0) {
        console.log(
          `[scheduler] tick:投递 ${outcome.delivered} 条,禁用 ${outcome.skipped} 条,退避 ${outcome.deferred} 条`,
        );
      }
    } catch (error) {
      console.error("[scheduler] tick 失败(不影响服务):", error);
    }
  }, SCHEDULE_TICK_MS);
  // 不阻止进程退出。
  timer.unref?.();
}

function stop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** 进程级调度器(启动收敛之后 start,优雅停机 stop)。 */
export const AgentTaskScheduler = { start, stop, tick: runSchedulerTick };
