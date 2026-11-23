// agent-loop/run-tracker.ts — 把一次 generateAnswer 的 GenerationEvent 观察成运行记录(S1)
//
// 定位:纯观察者。不改变生成语义、不向引擎回注任何判定(判定表在 S3)。控制器看到的
// 事件与前端看到的一致:工具卡/审批/传输重试/错误;正文增量一律忽略(只记计数与摘要)。
//
// 生命周期由编排器显式驱动:beginAgentRun → boundary(每轮) → observe(每个事件) →
// suspend(审批暂停)/ finishTerminal(终局)。全部写入 best-effort,失败只降级为不可见。
//
// 推送纪律:每个变化经 initAgentRunBroadcast 注入的出口广播到会话 SSE(事件名 agent-run)。
// 与 sse 模块解耦用注入(同 memory-vector 的模式),避免 agent-loop → api 反向依赖。

import { estimateTokens, id, isRecord } from "../foundation/utils";
import {
  boundaryIdFor,
  type ToolBoundaryObservation,
  type ToolBoundaryObserver,
  type ToolBoundarySnapshot,
} from "../foundation/tool-boundary";
import type { EngineStatus, GenerationEvent } from "../inference-engine/events";
import {
  appendRunEvent,
  approvalDecisionKeysForRun,
  approvalUsagesForRun,
  boundarySnapshotsForRun,
  getRun,
  insertRun,
  latestSuspendedRun,
  updateRun,
  type RunApprovalUsage,
  type RunPatch,
} from "./run-store";
import { clipToolResultText } from "../inference-engine/result-clip";
import { state } from "../persistence/json-store";
import type {
  AgentRoundSummary,
  AgentRunEventDto,
  AgentRunPhase,
  AgentRunPushDto,
  AgentRunStatus,
  AgentRunSummary,
} from "./types";

export type AgentRunTerminal = "succeeded" | "failed" | "exhausted" | "stalled" | "stopped";

export interface AgentRunTracker {
  readonly runId: string;
  readonly conversationId: string;
  /** 轮边界:聊天引擎 = 工具循环每轮迭代;pi = turn_start。同轮重复调用幂等。 */
  boundary(round: number): void;
  /** 观察一个生成事件。 */
  observe(event: GenerationEvent): void;
  /** O4:工具边界观察(审批最终判定 / 执行前)。审批时点带 pending 缘由时同时记等待流水;
   *  执行时点单独记 tool_execution——两者不互相冒充。 */
  observeBoundary(observation: ToolBoundaryObservation): void;
  /** O4:记一次审批决定(按 toolCallId+decision 去重,附审批时点 boundaryId)。 */
  noteApprovalDecision(
    toolCallId: string,
    decision: "approved" | "denied",
    options?: { reason?: string; toolName?: string },
  ): void;
  /** 追加一条流水(审批端点在途 run 记账用;其余调用方不要直接写)。 */
  record(kind: AgentRunEventDto["kind"], summary: string, payload?: AgentRunEventDto["payload"]): void;
  /** engine_status 出站前补充 runId/轮次/重试/replan 计数(旧前端忽略新字段)。 */
  enrichStatus(status: EngineStatus): EngineStatus;
  /** 自主循环(S3):判定表触发一次 replan(计数 + 相位 + replan 事件)。返回累计次数。 */
  noteReplan(reason: string, goal?: string | null): number;
  /** 自主循环(S3):判定表判定停滞(相位 awaiting_user + stall 事件)。 */
  noteStall(reason: string): void;
  /** 自主循环(S2):回填目标快照(计划 v2 的 goal;只存摘要,不存正文)。 */
  setGoal(goal: string): void;
  /** S-F4:当前轮的体积快照(工具批执行完、turn_end 判定前读取)。轮内无调用 → null。
   *  纯读,不落库——落库发生在轮边界推进/终局(见 flushRound)。 */
  roundSummary(): AgentRoundSummary | null;
  /** pause-resume 引擎的审批暂停:状态置 suspended,不写终局(批准后续跑接续本 run)。 */
  suspend(): void;
  /** 收敛终局。幂等,重复调用只生效一次。 */
  finishTerminal(status: AgentRunTerminal, detail?: { stopReason?: string; error?: string }): void;
  /** finally 兜底:仍在 running(异常/导入替换等未走到显式终局的路径)才收敛 stopped。
   *  suspended(审批暂停)与已收敛的终局不动。 */
  ensureSettled(stopReason: string): void;
}

/** 活跃 run 注册表(会话 → tracker)。审批端点据此把用户决定记进在途 run;
 *  暂停/终局即摘除,避免陈旧引用。 */
const activeRuns = new Map<string, AgentRunTracker>();

export function activeRunFor(conversationId: string): AgentRunTracker | undefined {
  return activeRuns.get(conversationId);
}

/** O4:编排层把工具层的边界观察适配到当前 run tracker。observer 只做观测,
 *  任何异常都吞掉——记录失败不得影响审批/执行。 */
export function createRunBoundaryObserver(tracker: AgentRunTracker): ToolBoundaryObserver {
  return (observation) => {
    try {
      tracker.observeBoundary(observation);
    } catch {
      /* best-effort */
    }
  };
}

let pushObserver: ((conversationId: string, push: AgentRunPushDto) => void) | null = null;

/** SSE 出口注入(api/sse.ts 的 initSseWiring 调用)。未注入 = 只落库不推送。 */
export function initAgentRunBroadcast(observer: (conversationId: string, push: AgentRunPushDto) => void): void {
  pushObserver = observer;
}

/** 拒绝缘由进 run 流水前的路径脱敏:完整路径只留在审批卡,不复制进观测记录。 */
export function redactApprovalReason(reason: string): string {
  return reason
    .replace(/[A-Za-z]:[\\/][^\s"'`]+/g, "<path>")
    .replace(/(^|\s)\/[^\s"'`]+/g, "$1<path>")
    .trim()
    .slice(0, 120);
}

function boundarySummary(snapshot: ToolBoundarySnapshot): string {
  const scope = snapshot.effectiveWriteScope === "wide" ? "宽写" : "严写";
  const sandbox = snapshot.sandbox.boundaryActive ? "系统沙箱生效" : "无系统沙箱";
  return `边界 ${snapshot.permissionPreset} · ${scope} · ${sandbox}`;
}

interface TrackerSeed {
  boundaries: Map<string, ToolBoundarySnapshot>;
  usages: Map<string, RunApprovalUsage>;
  decisions: Set<string>;
}

class Tracker implements AgentRunTracker {
  private summary: AgentRunSummary;
  private readonly toolNames = new Map<string, string>();
  /** 已记过 pending 审批的工具:OpenAI 路径只有 tool_call_created(终局态即 pending),
   *  Claude 路径建卡后还会补一发 tool_approval_updated pending——同一等待只记一条流水。 */
  private readonly pendingApprovals = new Set<string>();
  /** O4:本 run 已知的边界定义与审批使用语境(resume 时从库里补种)。 */
  private readonly knownBoundaries: Map<string, ToolBoundarySnapshot>;
  private readonly approvalUsage: Map<string, RunApprovalUsage>;
  /** O4:已落库的决定键(toolCallId + decision),双路径去重。 */
  private readonly decidedApprovals: Set<string>;
  private lastRetryAttempt = 0;
  private finished = false;
  /** S-F4:本轮体积累计。round 记录归属轮次(与 summary.rounds 对齐)。 */
  private round = { round: 0, calls: 0, nestedCalls: 0, okCalls: 0, resultBytesRaw: 0, resultBytesClipped: 0, rawTokensEst: 0, savedTokensEst: 0 };

  constructor(summary: AgentRunSummary, seed?: TrackerSeed) {
    this.summary = summary;
    this.knownBoundaries = seed?.boundaries ?? new Map();
    this.approvalUsage = seed?.usages ?? new Map();
    this.decidedApprovals = seed?.decisions ?? new Set();
  }

  get runId(): string {
    return this.summary.id;
  }

  get conversationId(): string {
    return this.summary.conversationId;
  }

  private persist(patch: RunPatch): void {
    Object.assign(this.summary, {
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
      ...(patch.stopReason !== undefined ? { stopReason: patch.stopReason } : {}),
      ...(patch.rounds !== undefined ? { rounds: patch.rounds } : {}),
      ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
      ...(patch.replanCount !== undefined ? { replanCount: patch.replanCount } : {}),
      ...(patch.stallReason !== undefined ? { stallReason: patch.stallReason } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    });
    updateRun(this.summary.id, patch);
  }

  private push(event: AgentRunEventDto | null): void {
    if (!pushObserver) return;
    try {
      pushObserver(this.summary.conversationId, { type: "agent_run", run: { ...this.summary }, event });
    } catch {
      /* 推送失败不影响生成 */
    }
  }

  /** 记录一条事件并推送。内部使用;beginAgentRun 的接续路径也需要。 */
  record(kind: AgentRunEventDto["kind"], summary: string, payload: AgentRunEventDto["payload"] = null): void {
    const event = appendRunEvent(this.summary.id, kind, summary, payload);
    if (event) this.push(event);
  }

  /** 进入审批等待:相位 + 一条 pending 流水。同一工具重复上报只落一次。 */
  private markApprovalPending(
    toolCallId: string,
    name: string,
    approval?: { reasonCode?: string; reasonSummary?: string; ruleId?: string },
    usage?: RunApprovalUsage,
  ): void {
    if (this.pendingApprovals.has(toolCallId)) {
      if (this.summary.phase !== "awaiting_approval") this.persist({ phase: "awaiting_approval" });
      return;
    }
    this.pendingApprovals.add(toolCallId);
    this.persist({ phase: "awaiting_approval" });
    this.record("approval", `等待审批 · ${name}`, {
      toolCallId,
      toolName: name,
      decision: "pending",
      stage: "approval",
      ...(usage?.boundaryId ? { boundaryId: usage.boundaryId } : {}),
      ...(usage?.access ? { access: usage.access } : {}),
      ...(usage?.targetScope ? { targetScope: usage.targetScope } : {}),
      ...(approval?.reasonCode ? { reasonCode: approval.reasonCode } : {}),
      ...(approval?.reasonSummary ? { reasonSummary: approval.reasonSummary.slice(0, 240) } : {}),
      ...(approval?.ruleId ? { ruleId: approval.ruleId } : {}),
    });
  }

  /** 稳定 boundaryId 首次出现才写 boundary 事件;ref 事件只带 id。 */
  private ensureBoundary(snapshot: ToolBoundarySnapshot): string {
    const boundaryId = boundaryIdFor(snapshot);
    if (this.knownBoundaries.has(boundaryId)) return boundaryId;
    this.knownBoundaries.set(boundaryId, snapshot);
    this.record("boundary", boundarySummary(snapshot), {
      boundaryId,
      workspace: { ...snapshot.workspace },
      permissionPreset: snapshot.permissionPreset,
      effectiveWriteScope: snapshot.effectiveWriteScope,
      sandbox: { ...snapshot.sandbox },
    });
    return boundaryId;
  }

  observeBoundary(observation: ToolBoundaryObservation): void {
    if (this.finished) return;
    const boundaryId = this.ensureBoundary(observation.snapshot);
    const usage: RunApprovalUsage = {
      boundaryId,
      access: observation.access,
      targetScope: observation.targetScope,
    };
    const name = observation.toolName ?? this.toolNames.get(observation.toolCallId) ?? observation.toolCallId;
    if (observation.stage === "execution") {
      this.record("tool_execution", `执行工具 ${name}`, {
        toolCallId: observation.toolCallId,
        toolName: name,
        stage: "execution",
        boundaryId,
        access: observation.access,
        targetScope: observation.targetScope,
      });
      return;
    }
    // 审批时点的使用语境只记在 approval 事件上;执行时的有效边界另有一条。
    this.approvalUsage.set(observation.toolCallId, usage);
    if (observation.approval) {
      this.markApprovalPending(observation.toolCallId, name, observation.approval, usage);
    }
  }

  noteApprovalDecision(
    toolCallId: string,
    decision: "approved" | "denied",
    options: { reason?: string; toolName?: string } = {},
  ): void {
    if (this.finished) return;
    const key = `${toolCallId}\u0000${decision}`;
    if (this.decidedApprovals.has(key)) return;
    this.decidedApprovals.add(key);
    this.pendingApprovals.delete(toolCallId);
    this.persist({ phase: this.summary.status === "suspended" ? "awaiting_approval" : "acting" });
    const name = options.toolName ?? this.toolNames.get(toolCallId) ?? toolCallId;
    const usage = this.approvalUsage.get(toolCallId);
    const reason = decision === "denied" ? redactApprovalReason(options.reason ?? "") : "";
    this.record("approval", decision === "approved" ? `已批准 · ${name}` : `已拒绝 · ${name}${reason ? `:${reason}` : ""}`, {
      toolCallId,
      toolName: name,
      decision,
      stage: "approval",
      decidedAt: Date.now(),
      ...(usage?.boundaryId ? { boundaryId: usage.boundaryId } : {}),
      ...(usage?.access ? { access: usage.access } : {}),
      ...(usage?.targetScope ? { targetScope: usage.targetScope } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  boundary(round: number): void {
    if (this.finished) return;
    const rounds = Math.max(0, Math.floor(round));
    const nextRounds = Math.max(rounds, this.summary.rounds);
    const advanced = nextRounds > this.summary.rounds;
    const restoreActing = this.summary.status === "running" && this.summary.phase !== "acting";
    // 同轮重复边界(流式降级重试 / steering 再采样)不重复计数、不刷流水;
    // 但审批/重试相位结束后回到 acting 仍要落一次。
    if (!advanced && !restoreActing) return;
    // S-F4:轮边界先结算上一轮的体积,再进入新轮——summry 归属的 round 是"刚结束的那轮"。
    if (advanced) this.flushRound();
    this.persist({ rounds: nextRounds, ...(restoreActing ? { phase: "acting" as AgentRunPhase } : {}) });
    if (advanced) {
      this.round.round = nextRounds;
      this.record("round", `第 ${nextRounds} 轮`, { round: nextRounds });
    }
  }

  /** S-F4:当前轮体积快照(判定表在 turn_end 消费)。纯读,不落库。 */
  roundSummary(): AgentRoundSummary | null {
    if (this.round.calls === 0 && this.round.nestedCalls === 0) return null;
    return { ...this.round, round: this.round.round || this.summary.rounds };
  }

  /** S-F4:把本轮累计落成一条 round_summary 流水并清零(轮边界/终局调用)。 */
  private flushRound(): void {
    const stats = this.roundSummary();
    if (!stats) return;
    this.round = { ...this.round, calls: 0, nestedCalls: 0, okCalls: 0, resultBytesRaw: 0, resultBytesClipped: 0, rawTokensEst: 0, savedTokensEst: 0 };
    const kb = (bytes: number): string => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`);
    const saved = stats.savedTokensEst >= 1 ? ` · 约省 ${Math.round(stats.savedTokensEst)} token` : "";
    const nested = stats.nestedCalls > 0 ? `(嵌套 ${stats.nestedCalls})` : "";
    const text = `第 ${stats.round} 轮 · ${stats.calls + stats.nestedCalls} 次调用${nested} · ${kb(stats.resultBytesRaw)} → ${kb(stats.resultBytesClipped)}${saved}`;
    this.record("round_summary", text.slice(0, 240), { ...stats });
  }

  observe(event: GenerationEvent): void {
    if (this.finished) return;
    switch (event.kind) {
      case "tool_call_created": {
        this.toolNames.set(event.toolCallId, event.toolName);
        const nested = isRecord(event.metadata) && typeof event.metadata.nestedInRunCode === "string";
        if (nested) this.round.nestedCalls += 1;
        else this.round.calls += 1;
        this.record("tool_call", `调用工具 ${event.toolName}`, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(nested ? { nested: true } : {}),
        });
        // OpenAI 路径的卡在这里就是终局审批态(参数齐备):pending 即进入等待。
        // Claude 路径稍后还会补一发 tool_approval_updated pending,由 Set 去重。
        if (event.approvalState.type === "pending") {
          // 边界 observer 通常先于本事件到达(最终审批判定即观测);这里按已知语境补记,
          // 若 observer 未注入则 payload 只缺 boundaryId,其余行为不变。
          this.markApprovalPending(
            event.toolCallId,
            event.toolName,
            event.approvalState.reasonCode ? event.approvalState : undefined,
            this.approvalUsage.get(event.toolCallId),
          );
        }
        return;
      }
      case "tool_approval_updated": {
        const name = this.toolNames.get(event.toolCallId) ?? event.toolCallId;
        const approval = event.approvalState;
        if (approval.type === "pending") {
          this.markApprovalPending(
            event.toolCallId,
            name,
            approval.reasonCode ? approval : undefined,
            this.approvalUsage.get(event.toolCallId),
          );
        } else if (approval.type === "approved" || approval.type === "answered") {
          this.noteApprovalDecision(event.toolCallId, "approved", { toolName: name });
        } else if (approval.type === "denied") {
          this.noteApprovalDecision(event.toolCallId, "denied", { toolName: name, reason: approval.reason });
        }
        return;
      }
      case "tool_result": {
        // partial(bash 流式中间帧)只刷新 output,不是一次新的执行,记流水会刷屏。
        if (event.final === false) return;
        this.pendingApprovals.delete(event.toolCallId);
        const name = this.toolNames.get(event.toolCallId) ?? event.toolCallId;
        this.record("tool_result", `完成工具 ${name}`, { toolCallId: event.toolCallId, toolName: name });
        // S-F4:体积口径与富化层裁剪同源——逐条文本过 clipToolResultText,差的 token
        // 用 estimateTokens 现算(与 contextNudgeBlock 同一个函数,两处数字不会打架)。
        let text = "";
        let failed = false;
        for (const entry of event.output) {
          if (!isRecord(entry)) continue;
          if (entry.type === "text") text += String(entry.text ?? "");
          else {
            const errorText = (entry as { error?: unknown }).error;
            if (typeof errorText === "string") {
              failed = true;
              text += errorText;
            }
          }
        }
        if (!failed) this.round.okCalls += 1;
        const rawBytes = Buffer.byteLength(text, "utf8");
        // 观察者永不因环境异常打断生成:测试/极早期装配下 state 可能尚未就绪。
        const config = state?.settings?.resultClip;
        const clipped =
          config?.enabled === true
            ? clipToolResultText(text, { thresholdChars: config.thresholdChars, headChars: config.headChars, tailChars: config.tailChars })
            : null;
        const clippedText = clipped ?? text;
        const rawTokens = estimateTokens(text);
        this.round.resultBytesRaw += rawBytes;
        this.round.resultBytesClipped += Buffer.byteLength(clippedText, "utf8");
        this.round.rawTokensEst += rawTokens;
        if (clipped) {
          this.round.savedTokensEst += Math.max(0, rawTokens - estimateTokens(clippedText));
        }
        return;
      }
      case "engine_status": {
        const status = event.status;
        if (status.busy && status.phase === "retrying") {
          const attempt = status.attempt ?? this.summary.attempts + 1;
          if (attempt > this.lastRetryAttempt) {
            this.lastRetryAttempt = attempt;
            this.persist({ phase: "retrying", attempts: Math.max(attempt, this.summary.attempts) });
            this.record("retry", `传输重试 第 ${attempt}/${status.maxAttempts ?? "?"} 次`, {
              attempt,
              maxAttempts: status.maxAttempts ?? null,
            });
          }
        } else if (!status.busy && this.summary.phase === "retrying" && this.summary.status === "running") {
          this.persist({ phase: "acting" });
        }
        return;
      }
      case "error": {
        this.record("error", event.error);
        return;
      }
      default:
        return;
    }
  }

  enrichStatus(status: EngineStatus): EngineStatus {
    if (!status.busy) return status;
    return {
      ...status,
      runId: this.summary.id,
      round: this.summary.rounds,
      attempts: this.summary.attempts,
      replanCount: this.summary.replanCount,
      ...(this.summary.stallReason ? { stallReason: this.summary.stallReason } : {}),
    };
  }

  noteReplan(reason: string, goal?: string | null): number {
    if (this.finished) return this.summary.replanCount;
    const count = this.summary.replanCount + 1;
    this.persist({
      phase: "replanning",
      replanCount: count,
      ...(goal ? { goal: goal.slice(0, 500) } : {}),
    });
    this.record("replan", `第 ${count} 次重规划:${reason}`, {
      replan: count,
      reason: reason.slice(0, 240),
    });
    return count;
  }

  noteStall(reason: string): void {
    if (this.finished) return;
    const text = reason.slice(0, 240);
    this.persist({ phase: "awaiting_user", stallReason: text });
    this.record("stall", `停滞:${text}`, { reason: text });
  }

  setGoal(goal: string): void {
    if (this.finished) return;
    const text = goal.trim().slice(0, 500);
    if (!text || text === this.summary.goal) return;
    this.persist({ goal: text });
  }

  suspend(): void {
    if (this.finished) return;
    this.persist({ status: "suspended", phase: "awaiting_approval" });
    this.record("run_suspended", "等待审批,已暂停(批准后继续)");
    activeRuns.delete(this.summary.conversationId);
  }

  finishTerminal(status: AgentRunTerminal, detail?: { stopReason?: string; error?: string }): void {
    if (this.finished) return;
    this.flushRound();
    this.finished = true;
    this.persist({
      status: status as AgentRunStatus,
      endedAt: Date.now(),
      ...(detail?.stopReason !== undefined ? { stopReason: detail.stopReason } : {}),
      ...(detail?.error !== undefined ? { error: detail.error } : {}),
    });
    const label =
      status === "succeeded" ? "完成"
      : status === "failed" ? "失败"
      : status === "exhausted" ? "轮次耗尽"
      : status === "stalled" ? "停滞"
      : `已停止${detail?.stopReason ? `(${detail.stopReason})` : ""}`;
    this.record("run_finished", label, {
      status,
      ...(detail?.stopReason !== undefined ? { stopReason: detail.stopReason } : {}),
    });
    activeRuns.delete(this.summary.conversationId);
  }

  ensureSettled(stopReason: string): void {
    if (this.finished || this.summary.status !== "running") return;
    this.finishTerminal("stopped", { stopReason });
  }
}

export interface BeginAgentRunInput {
  conversationId: string;
  nodeId: string | null;
  engine: string;
  /** true:接续最近一条 suspended run(聊天引擎审批后重触发续跑),而不是新开一条。 */
  resumeSuspended?: boolean;
  /** 生命周期 L2:本次生成由哪条中断 run 显式恢复而来(恢复消息注解);普通生成为空。 */
  resumedFromRunId?: string | null;
  /** 生命周期 L3:触发本次生成的调度 id;手动/恢复生成为空。 */
  scheduleId?: string | null;
}

/** 开一条运行记录。返回 null = 未启用或落库失败(调用方退回无观测路径,行为不变)。 */
export function beginAgentRun(input: BeginAgentRunInput): AgentRunTracker | null {
  if (input.resumeSuspended) {
    const existing = latestSuspendedRun(input.conversationId);
    if (existing) {
      const patch: RunPatch = { status: "running", phase: "acting", endedAt: null, error: null };
      updateRun(existing.id, patch);
      const tracker = new Tracker(
        { ...existing, status: "running", phase: "acting", endedAt: null, error: null },
        {
          // O4:接续运行不能丢边界去重与决定去重——种子里已存在的快照/决定不再重复写。
          boundaries: new Map(Object.entries(boundarySnapshotsForRun(existing.id))),
          usages: approvalUsagesForRun(existing.id),
          decisions: approvalDecisionKeysForRun(existing.id),
        },
      );
      activeRuns.set(input.conversationId, tracker);
      tracker.record("run_resumed", "继续运行(审批后)");
      return tracker;
    }
  }
  const startedAt = Date.now();
  const runId = id();
  const resumedFromRunId = input.resumedFromRunId ?? null;
  const scheduleId = input.scheduleId ?? null;
  const ok = insertRun({
    id: runId,
    conversationId: input.conversationId,
    nodeId: input.nodeId,
    engine: input.engine,
    startedAt,
    resumedFromRunId,
    scheduleId,
  });
  if (!ok) return null;
  const summary: AgentRunSummary = {
    id: runId,
    conversationId: input.conversationId,
    nodeId: input.nodeId,
    engine: input.engine,
    status: "running",
    phase: "planning",
    stopReason: null,
    rounds: 0,
    attempts: 0,
    replanCount: 0,
    stallReason: null,
    goal: null,
    resumedFromRunId,
    scheduleId,
    startedAt,
    endedAt: null,
    error: null,
  };
  const tracker = new Tracker(summary);
  activeRuns.set(input.conversationId, tracker);
  tracker.record("run_started", `开始运行(${input.engine})`, {
    engine: input.engine,
    nodeId: input.nodeId,
    ...(resumedFromRunId ? { resumedFromRunId } : {}),
    ...(scheduleId ? { scheduleId } : {}),
  });
  return tracker;
}

/** 审批端点把用户决定记进运行流水:优先在途 run(pause-resume 暂停前/pi 在跑),
 *  否则最近一条 suspended run(暂停期间用户点卡)。不改变任何审批语义。 */
export function recordApprovalDecision(
  conversationId: string,
  toolCallId: string,
  approved: boolean,
  reason?: string,
): void {
  const decision = approved ? "approved" : "denied";
  const active = activeRuns.get(conversationId);
  if (active) {
    active.noteApprovalDecision(toolCallId, decision, reason !== undefined ? { reason } : {});
    return;
  }
  const suspended = latestSuspendedRun(conversationId);
  if (!suspended) return;
  // O4:审批端点与后续 tool_approval_updated 可能先后各报一次同一决定——落库前去重。
  if (approvalDecisionKeysForRun(suspended.id).has(`${toolCallId}\u0000${decision}`)) return;
  const usage = approvalUsagesForRun(suspended.id).get(toolCallId);
  const redacted = decision === "denied" ? redactApprovalReason(reason ?? "") : "";
  const label = approved ? `用户批准 · ${toolCallId}` : `用户拒绝${redacted ? `:${redacted}` : ""} · ${toolCallId}`;
  const event = appendRunEvent(suspended.id, "approval", label, {
    toolCallId,
    decision,
    stage: "approval",
    decidedAt: Date.now(),
    ...(usage?.boundaryId ? { boundaryId: usage.boundaryId } : {}),
    ...(usage?.access ? { access: usage.access } : {}),
    ...(usage?.targetScope ? { targetScope: usage.targetScope } : {}),
    ...(redacted ? { reason: redacted } : {}),
  });
  if (!event || !pushObserver) return;
  const run = getRun(suspended.id);
  if (!run) return;
  try {
    pushObserver(conversationId, { type: "agent_run", run, event });
  } catch {
    /* best-effort */
  }
}
