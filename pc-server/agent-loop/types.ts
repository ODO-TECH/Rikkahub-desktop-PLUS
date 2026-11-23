// agent-loop/types.ts — 自主循环运行记录的线上契约(PC 专属)
//
// 一次 generateAnswer = 一个 run。记录只存摘要与计数,不存正文(见
// docs/plan-autonomous-loop.md §4.2)。前端面板与 GET /api/conversations/:id/agent-run
// 共用本文件的类型;web-ui 侧有同构的镜像类型(不跨项目 import)。

import type { JsonValue } from "../foundation/types";
import type { ToolBoundarySnapshot } from "../foundation/tool-boundary";
import type { PlanSnapshot } from "../tools/plan";

/** 运行终局 + 两个非终局态:
 *  - running:生成中。
 *  - suspended:暂停等审批(pause-resume 引擎的整批暂停;批准后重触发续跑会回到 running)。
 *  - 终局:succeeded / failed / exhausted / stalled / stopped。
 *  S1 只产生 running/suspended/succeeded/failed/stopped;exhausted/stalled 由 S3 接入。 */
export type AgentRunStatus =
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "exhausted"
  | "stalled"
  | "stopped";

/** 与 plan §3.2 状态机对齐;S1 实际写入 planning/acting/awaiting_approval/retrying,
 *  其余相位由 S3 的判定表接入。 */
export type AgentRunPhase =
  | "planning"
  | "acting"
  | "observing"
  | "deciding"
  | "replanning"
  | "verifying"
  | "awaiting_approval"
  | "awaiting_user"
  | "retrying";

export type AgentRunEventKind =
  | "run_started"
  | "run_resumed"
  | "round"
  /** S-F4:轮边界体积汇总(调用数/原始与裁剪后字节/估算省下的 token)。 */
  | "round_summary"
  | "tool_call"
  | "tool_result"
  /** O4:执行前记录的有效边界(附 toolCallId + stage=execution)。 */
  | "tool_execution"
  /** O4:边界定义。同一 run 内同一稳定快照只记一次;ref 事件只带 boundaryId。 */
  | "boundary"
  | "approval"
  | "retry"
  | "replan"
  | "stall"
  | "error"
  | "run_suspended"
  | "run_finished";

/** S-F4:一轮工具执行的体积快照。字节数与 token 估算都由观测事件现算,
 *  不读库、不读富化结果——与 contextNudgeBlock 共用 estimateTokens 口径。 */
export interface AgentRoundSummary {
  round: number;
  /** 顶层调用数(run_code 的嵌套调用单独计,防把一次折叠算成多次)。 */
  calls: number;
  nestedCalls: number;
  okCalls: number;
  resultBytesRaw: number;
  resultBytesClipped: number;
  /** 原始体积的 token 估算(estimateTokens 汇总,判定表预算刹车的输入)。 */
  rawTokensEst: number;
  savedTokensEst: number;
}

export interface AgentRunSummary {
  id: string;
  conversationId: string;
  /** 本次运行落点的节点 id(steer 分裂前的起点;面板定位用,可空)。 */
  nodeId: string | null;
  engine: string;
  status: AgentRunStatus;
  phase: AgentRunPhase;
  /** 仅 stopped 有值:interrupted / replaced / deleted。 */
  stopReason: string | null;
  rounds: number;
  attempts: number;
  replanCount: number;
  stallReason: string | null;
  /** 目标快照(S1 固定为 null;S2 起由计划 v2 的 goal 回填)。 */
  /** 生命周期:本 run 由哪条中断 run 显式恢复而来;普通运行为 null。 */
  resumedFromRunId?: string | null;
  /** 生命周期:触发本 run 的调度 id;手动/恢复运行为 null。 */
  scheduleId?: string | null;
  /** 目标快照(S1 固定为 null;S2 起由计划 v2 的 goal 回填)。 */
  goal: string | null;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

export interface AgentRunEventDto {
  seq: number;
  at: number;
  kind: AgentRunEventKind;
  /** 一句话摘要(截断;不放工具输出正文/模型正文)。 */
  summary: string;
  /** 结构化小载荷(toolCallId/审批决定/次数等),可为 null。 */
  payload: JsonValue | null;
}

/** SSE agent-run 帧载荷(也用于 GET 快照)。event 为 null = 仅状态快照;
 *  events 只在连接首帧(窗口快照)带,增量帧不带(避免 O(N²) 重放)。
 *  O1 只新增可选窗口字段:旧前端忽略即可。 */
export interface AgentRunPushDto {
  type: "agent_run";
  run: AgentRunSummary;
  event: AgentRunEventDto | null;
  events?: AgentRunEventDto[];
  /** 窗口更早处还有事件(首批 events 是最新一页,不是完整历史)。 */
  hasMore?: boolean;
  /** 窗口内最小 seq(向前翻页游标);空窗口为 null。 */
  nextBeforeSeq?: number | null;
  /** 窗口内最大 seq(本次快照覆盖到的尾部)。 */
  throughSeq?: number | null;
}

/** GET /api/conversations/:id/agent-run 响应。O1 起 events 为最新一页 + 窗口信息,
 *  字段只增不改:run/events 仍是旧契约,窗口字段可缺省(读取方需容错)。 */
export interface AgentRunSnapshotDto {
  run: AgentRunSummary | null;
  events: AgentRunEventDto[];
  hasMore?: boolean;
  nextBeforeSeq?: number | null;
  throughSeq?: number | null;
}

/** GET /api/conversations/:id/agent-runs 响应:保留的 run 摘要,不含事件。 */
export interface AgentRunListDto {
  runs: AgentRunSummary[];
}

/** GET /api/conversations/:id/agent-runs/:runId/events 响应。
 *  beforeSeq 语义为严格 seq < beforeSeq;页内按 seq ASC 返回。
 *  nextBeforeSeq = 本页最小 seq(继续向前翻页的游标);throughSeq = 本页最大 seq。 */
export interface AgentRunEventPageDto {
  runId: string;
  events: AgentRunEventDto[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
  throughSeq: number | null;
}

/** O3:run 级计划投影不可用的原因。有值 = plan 为 null,且前端必须如实展示原因,
 *  不能回退到别的 run 或按文本猜测。 */
export type RunPlanUnavailableReason =
  | "no_plan"
  | "source_missing"
  | "source_ambiguous"
  | "invalid_plan"
  | "anchor_missing";

/** toolCallId → 工具卡所在消息。visible = 该消息位于会话当前选中分支;
 *  false 表示历史来源仍在,但时间线上不可见,定位入口必须如实标注。 */
export interface RunPlanToolLocationDto {
  messageId: string;
  visible: boolean;
}

/** run 级计划投影(不依赖前端当前已加载的事件页)。 */
export interface RunPlanProjectionDto {
  plan: PlanSnapshot | null;
  /** 计划来源的 update_plan toolCallId;unavailable 时也尽量给出已知来源。 */
  sourceToolCallId: string | null;
  sourceMessageId: string | null;
  /** null = 已成功还原计划。 */
  unavailableReason: RunPlanUnavailableReason | null;
  /** 计划是否为 v2;旧计划不显示 evidence/未验证等 v2 语义。 */
  v2: boolean;
  /** 计划来源与步骤 evidence 的 toolCallId → 消息位置;找不到的 id 不出现在这里。 */
  toolLocations: Record<string, RunPlanToolLocationDto>;
}

/** O4:run 投影里的边界定义(按 boundaryId 去重)。审批/执行事件只带 boundaryId,
 *  面板从投影解析快照——不依赖当前已加载的事件页。 */
export type RunBoundarySnapshotDto = ToolBoundarySnapshot;

/** GET /api/conversations/:id/agent-runs/:runId/projection(O3 的 plan + O4 的 boundaries)。 */
export interface RunProjectionDto {
  runId: string;
  plan: RunPlanProjectionDto;
  /** run 内出现过的全部边界定义;键为 boundaryId。缺失的 ref 由前端明确标注不可用。 */
  boundaries: Record<string, RunBoundarySnapshotDto>;
}

/** 生命周期 L1:run 已落库进度的只读摘要(恢复与审计共用,不复制事件正文)。 */
export interface RunCheckpointDto {
  /** 已落库的最大事件 seq;没有事件为 0。 */
  throughSeq: number;
  /** 最后一条事件(最大 seq)的时间;没有事件为 null。 */
  lastEventAt: number | null;
  /** 现有 run 投影能否还原计划(投影失败按 false,不抛)。 */
  planAvailable: boolean;
  /** 边界投影去重后的数量。 */
  boundaryCount: number;
}

/** 生命周期 L2:恢复方式。none = 不可恢复;suspended = 走原审批续跑;
 *  new_run = 可新建 run 显式恢复。 */
export type AgentRunResumeMode = "none" | "suspended" | "new_run";

/** GET /api/conversations/:id/agent-runs/:runId/recovery 的响应。 */
export interface AgentRunRecoveryDto {
  runId: string;
  mode: AgentRunResumeMode;
  /** mode=none 时的明确原因(conversation_busy / approval_missing / status_*),否则 null。 */
  reason: string | null;
  checkpoint: RunCheckpointDto;
}
