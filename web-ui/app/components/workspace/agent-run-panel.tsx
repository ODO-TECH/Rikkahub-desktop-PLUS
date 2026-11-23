// ===== 本次运行(自主循环 S1):折叠流水条 =====
//
// 数据源是会话 SSE 的 agent-run 帧(conversation-store 的 agentRuns 切片)。实验开关
// 关闭时服务端不推帧、本组件不渲染——对普通对话零占位、零行为差。
//
// O2:latest 仍是实时窗口;历史 run 由窗格级选择(agent-run-selection)驱动独立读取,
// 不写回 latest 槽位。历史选中期间 SSE 只更新 latest;标题提示有新运行,切回 latest
// 才跟随。事件筛选只改视图,不改服务端顺序;翻页游标始终取当前已加载最小 seq。
// 收起态一行摘要(终局/轮次/工具/重试),展开为事件流水(轮次、工具调用、审批、重试、
// 终局)。事件只记摘要,不存正文,长任务上千条也不会拖垮面板。
import * as React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  CircleStop,
  Flag,
  Gauge,
  Hash,
  History,
  Loader2,
  LocateFixed,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Route,
  Shield,
  ShieldCheck,
  Target,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import type {
  AgentRunEventDto,
  AgentRunStatus,
  AgentRunSummary,
  RunBoundarySnapshotDto,
} from "~/types";
import {
  prependConversationAgentRunPage,
  useConversationAgentRun,
  useConversationStore,
} from "~/stores/conversation-store";
import {
  agentRunEpoch,
  fetchAgentRunEventPage,
  postAgentRunResume,
  useAgentRunEpoch,
} from "~/stores/agent-run-sync";
import { filterAgentRunEvents, type AgentRunEventFilter } from "~/lib/agent-run-events";
import { buildToolCallMessageIndex, shortToolCallId } from "~/lib/agent-run-locate";
import { useAgentRunHistory, useAgentRunList } from "~/hooks/use-agent-run-history";
import { useRunPlanProjection } from "~/hooks/use-run-plan-projection";
import { useRunRecovery } from "~/hooks/use-run-recovery";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useAgentRunSelection } from "~/components/workspace/agent-run-selection";
import api from "~/services/api";
import { extractErrorMessage } from "~/lib/error";
import { cn } from "~/lib/utils";

const STATUS_ICON: Record<AgentRunStatus, React.ComponentType<{ className?: string }>> = {
  running: Loader2,
  suspended: Pause,
  succeeded: Check,
  failed: CircleAlert,
  exhausted: Hash,
  stalled: TriangleAlert,
  stopped: CircleStop,
};

const STATUS_TONE: Record<AgentRunStatus, string> = {
  running: "",
  suspended: "text-warning",
  succeeded: "text-success",
  failed: "text-warning",
  exhausted: "text-warning",
  stalled: "text-warning",
  stopped: "",
};

const EVENT_ICON: Record<AgentRunEventDto["kind"], React.ComponentType<{ className?: string }>> = {
  run_started: Play,
  run_resumed: Play,
  round: Hash,
  round_summary: Gauge,
  tool_call: Wrench,
  tool_execution: Terminal,
  tool_result: Check,
  boundary: Shield,
  approval: ShieldCheck,
  retry: RefreshCw,
  replan: Route,
  stall: TriangleAlert,
  error: CircleAlert,
  run_suspended: Pause,
  run_finished: Flag,
};

const FILTERS: AgentRunEventFilter[] = ["all", "tools", "approval", "retry_replan", "issues"];

/** 未知 kind 的安全兜底:后端新增 kind 的窗口期,旧前端必须仍能渲染而不崩。
 *  这些事件按服务端摘要展示,图标用问号提示"本前端还不认识"。 */
export function agentRunEventIcon(kind: string): React.ComponentType<{ className?: string }> {
  return EVENT_ICON[kind as AgentRunEventDto["kind"]] ?? CircleHelp;
}

function payloadObject(payload: AgentRunEventDto["payload"]): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  return typeof payload[key] === "string" ? (payload[key] as string) : null;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  return typeof payload[key] === "number" ? (payload[key] as number) : null;
}

/** O4:边界快照的一行说明。full_access 只描述应用权限档;系统沙箱是否生效始终单独显示,
 *  两者同时为真时绝不合并成"无边界"。 */
export function describeRunBoundary(
  boundary: RunBoundarySnapshotDto,
  t: TFunction<"page">,
): string {
  const preset = t(`conversations.agent_run.boundary.preset.${boundary.permissionPreset}`, {
    defaultValue: boundary.permissionPreset,
  });
  const scope = t(`conversations.agent_run.boundary.scope.${boundary.effectiveWriteScope}`, {
    defaultValue: boundary.effectiveWriteScope,
  });
  const sandbox = t(
    boundary.sandbox.boundaryActive
      ? "conversations.agent_run.boundary.sandbox.active"
      : "conversations.agent_run.boundary.sandbox.inactive",
  );
  return `${preset} · ${scope} · ${sandbox}`;
}

/** 事件使用语境(读写/目标范围);旧事件或非工具事件缺字段时省略。 */
function boundaryUsageSuffix(payload: Record<string, unknown>, t: TFunction<"page">): string {
  const parts: string[] = [];
  const access = payloadString(payload, "access");
  if (access) {
    parts.push(t(`conversations.agent_run.boundary.access.${access}`, { defaultValue: access }));
  }
  const target = payloadString(payload, "targetScope");
  if (target) {
    parts.push(t(`conversations.agent_run.boundary.target.${target}`, { defaultValue: target }));
  }
  return parts.join(" · ");
}

/** 审批 pending 的白名单缘由:reasonCode 本地化,危险规则只带规则 id(不含完整命令)。 */
function approvalPendingReason(
  payload: Record<string, unknown>,
  t: TFunction<"page">,
): string | null {
  const reasonCode = payloadString(payload, "reasonCode");
  const ruleId = payloadString(payload, "ruleId");
  if (reasonCode) {
    const label = t(`conversations.agent_run.boundary.reason.${reasonCode}`, {
      defaultValue: reasonCode,
    });
    return ruleId ? `${label} · ${ruleId}` : label;
  }
  return payloadString(payload, "reasonSummary");
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

function formatRunOption(run: AgentRunSummary, t: TFunction<"page">): string {
  const time = new Date(run.startedAt).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const status = t(`conversations.agent_run.status.${run.status}`, {
    defaultValue: run.status,
  });
  return t("conversations.agent_run.history_option", { time, status, rounds: run.rounds });
}

/** 服务端摘要含动态信息(工具名/错误正文),对已知 kind 用结构化 payload 重新拼出
 *  本地化文案;未知 kind 只按服务端摘要展示,连摘要都没有时明确标注不丢行。 */
export function describeAgentRunEvent(event: AgentRunEventDto, t: TFunction<"page">): string {
  const payload = payloadObject(event.payload);
  switch (event.kind) {
    case "run_started":
      return t("conversations.agent_run.kind.run_started", {
        engine: payloadString(payload, "engine") ?? "",
      });
    case "run_resumed":
      return t("conversations.agent_run.kind.run_resumed");
    case "round":
      return t("conversations.agent_run.kind.round", {
        round: payloadNumber(payload, "round") ?? 0,
      });
    case "round_summary": {
      const calls =
        (payloadNumber(payload, "calls") ?? 0) + (payloadNumber(payload, "nestedCalls") ?? 0);
      const raw = payloadNumber(payload, "resultBytesRaw") ?? 0;
      const clipped = payloadNumber(payload, "resultBytesClipped") ?? 0;
      const saved = payloadNumber(payload, "savedTokensEst") ?? 0;
      const bytes = (value: number) =>
        value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${Math.round(value)} B`;
      return t("conversations.agent_run.kind.round_summary", {
        round: payloadNumber(payload, "round") ?? 0,
        calls,
        raw: bytes(raw),
        clipped: bytes(clipped),
        saved:
          saved >= 1
            ? t("conversations.agent_run.kind.round_summary_saved", { tokens: Math.round(saved) })
            : "",
      });
    }
    case "tool_call":
      return t("conversations.agent_run.kind.tool_call", {
        tool: payloadString(payload, "toolName") ?? "",
      });
    case "tool_execution":
      return t("conversations.agent_run.kind.tool_execution", {
        tool: payloadString(payload, "toolName") ?? "",
      });
    case "tool_result":
      return t("conversations.agent_run.kind.tool_result", {
        tool: payloadString(payload, "toolName") ?? "",
      });
    case "boundary": {
      const preset = payloadString(payload, "permissionPreset") ?? "";
      const scope = payloadString(payload, "effectiveWriteScope") ?? "";
      const sandbox = payloadObject(payload.sandbox as AgentRunEventDto["payload"]);
      const active = sandbox.boundaryActive === true;
      return t("conversations.agent_run.kind.boundary", {
        preset: t(`conversations.agent_run.boundary.preset.${preset}`, { defaultValue: preset }),
        scope: t(`conversations.agent_run.boundary.scope.${scope}`, { defaultValue: scope }),
        sandbox: t(
          active
            ? "conversations.agent_run.boundary.sandbox.active"
            : "conversations.agent_run.boundary.sandbox.inactive",
        ),
      });
    }
    case "approval": {
      const tool = payloadString(payload, "toolName") ?? payloadString(payload, "toolCallId") ?? "";
      const decision = payloadString(payload, "decision");
      const reason = payloadString(payload, "reason");
      if (decision === "pending") {
        const pendingReason = approvalPendingReason(payload, t);
        return pendingReason
          ? t("conversations.agent_run.kind.approval_pending_reason", {
              tool,
              reason: pendingReason,
            })
          : t("conversations.agent_run.kind.approval_pending", { tool });
      }
      if (decision === "approved")
        return t("conversations.agent_run.kind.approval_approved", { tool });
      if (decision === "denied") {
        return reason
          ? t("conversations.agent_run.kind.approval_denied_reason", { tool, reason })
          : t("conversations.agent_run.kind.approval_denied", { tool });
      }
      return event.summary;
    }
    case "retry": {
      const attempt = payloadNumber(payload, "attempt") ?? 0;
      const max = payloadNumber(payload, "maxAttempts");
      return max
        ? t("conversations.agent_run.kind.retry", { attempt, max })
        : t("conversations.agent_run.kind.retry_no_max", { attempt });
    }
    case "run_finished": {
      const status = payloadString(payload, "status");
      if (!status) return event.summary;
      const label = t(`conversations.agent_run.status.${status}`, { defaultValue: status });
      const stopReason = payloadString(payload, "stopReason");
      return stopReason
        ? t("conversations.agent_run.kind.run_finished_reason", {
            status: label,
            reason: stopReason,
          })
        : t("conversations.agent_run.kind.run_finished", { status: label });
    }
    case "run_suspended":
      return t("conversations.agent_run.kind.run_suspended");
    default:
      return event.summary || t("conversations.agent_run.unknown_event", { kind: event.kind });
  }
}

/** 工具/审批类事件的 toolCallId 后缀;定位入口不复制工具详情。 */
function eventToolCallId(event: AgentRunEventDto): string | null {
  const kind = event.kind as string;
  if (
    kind !== "tool_call" &&
    kind !== "tool_result" &&
    kind !== "approval" &&
    kind !== "tool_execution"
  ) {
    return null;
  }
  return payloadString(payloadObject(event.payload), "toolCallId");
}

/** 事件流水本体(展开态)。单独导出便于对未知 kind 做渲染契约测试,
 *  O2 的筛选/翻页也只在这里扩展,不把状态塞进折叠面板外壳。 */
export function AgentRunEventList({
  events,
  error,
  loading = false,
  hasMore = false,
  loadingOlder = false,
  loadOlderError = null,
  boundaries = {},
  boundariesLoading = false,
  onLoadOlder,
  onLocateToolCall,
}: {
  events: AgentRunEventDto[];
  error?: string | null;
  loading?: boolean;
  hasMore?: boolean;
  loadingOlder?: boolean;
  loadOlderError?: string | null;
  /** O4:run 级投影里的全部边界定义,不依赖当前事件页是否加载到来源。 */
  boundaries?: Record<string, RunBoundarySnapshotDto>;
  boundariesLoading?: boolean;
  onLoadOlder?: () => void;
  onLocateToolCall?: (toolCallId: string) => void;
}) {
  const { t } = useTranslation("page");
  return (
    <div className="max-h-64 space-y-1 overflow-y-auto overscroll-contain border-t border-[var(--ds-divider)] px-3 py-2">
      {hasMore || loadOlderError ? (
        <div className="flex flex-wrap items-center gap-2 pb-1">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={onLoadOlder}
            disabled={loadingOlder || !onLoadOlder}
          >
            {loadingOlder ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {loadingOlder
              ? t("conversations.agent_run.loading_older")
              : t("conversations.agent_run.load_older")}
          </Button>
          {loadOlderError ? <span className="text-warning">{loadOlderError}</span> : null}
        </div>
      ) : null}
      {loading ? (
        <p className="flex items-center gap-2 text-[var(--ds-text-tertiary)]">
          <Loader2 className="size-3 animate-spin" />
          {t("conversations.agent_run.loading_history")}
        </p>
      ) : null}
      {error ? <p className="text-warning">{error}</p> : null}
      {!loading && !error && events.length === 0 ? (
        <p className="text-[var(--ds-text-tertiary)]">{t("conversations.agent_run.empty")}</p>
      ) : null}
      {!loading
        ? events.map((event) => {
            const EventIcon = agentRunEventIcon(event.kind);
            const warn = event.kind === "error" || event.kind === "stall";
            const toolCallId = eventToolCallId(event);
            const payload = payloadObject(event.payload);
            const boundaryId = payloadString(payload, "boundaryId");
            const boundary =
              boundaryId && event.kind !== "boundary" ? (boundaries[boundaryId] ?? null) : null;
            return (
              <div key={event.seq} className="flex items-start gap-2">
                <span className="w-16 shrink-0 text-[var(--ds-text-tertiary)] tabular-nums">
                  {formatClock(event.at)}
                </span>
                <EventIcon
                  aria-hidden
                  className={cn(
                    "mt-0.5 size-3 shrink-0",
                    warn ? "text-warning" : "text-[var(--ds-text-tertiary)]",
                  )}
                />
                <span className={cn("min-w-0 flex-1 break-words", warn && "text-warning")}>
                  {describeAgentRunEvent(event, t)}
                  {boundaryId && event.kind !== "boundary" ? (
                    <span
                      title={
                        boundary
                          ? [
                              `${boundary.workspace.type}: ${boundary.workspace.root}`,
                              `cwd: ${boundary.workspace.cwd}`,
                              `sandbox: ${boundary.sandbox.tier} / ${boundary.sandbox.measured} / ${boundary.sandbox.mechanism}`,
                            ].join("\n")
                          : undefined
                      }
                      className={cn(
                        "ml-1 inline-flex items-center gap-1 align-baseline",
                        boundary
                          ? "text-[var(--ds-text-tertiary)]"
                          : boundariesLoading
                            ? "text-[var(--ds-text-tertiary)]"
                            : "text-warning",
                      )}
                    >
                      <Shield aria-hidden className="size-3" />
                      {boundary
                        ? [describeRunBoundary(boundary, t), boundaryUsageSuffix(payload, t)]
                            .filter(Boolean)
                            .join(" · ")
                        : boundariesLoading
                          ? t("conversations.agent_run.boundary_loading")
                          : t("conversations.agent_run.boundary_unavailable")}
                    </span>
                  ) : null}
                  {toolCallId ? (
                    <span className="ml-1 inline-flex items-center gap-1 align-baseline text-[var(--ds-text-tertiary)]">
                      <code
                        className="rounded bg-[var(--ds-on-surface)] px-1 py-px text-[10px]"
                        title={toolCallId}
                      >
                        {shortToolCallId(toolCallId)}
                      </code>
                      {onLocateToolCall ? (
                        <button
                          type="button"
                          aria-label={t("conversations.agent_run.locate")}
                          title={t("conversations.agent_run.locate")}
                          onClick={() => onLocateToolCall(toolCallId)}
                          className="inline-flex size-4 items-center justify-center rounded outline-none transition-colors hover:bg-[var(--ds-on-surface)] hover:text-[var(--ds-text-primary)] focus-visible:ring-2 focus-visible:ring-ring/50"
                        >
                          <LocateFixed aria-hidden className="size-3" />
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })
        : null}
    </div>
  );
}

export function AgentRunPanel({ conversationId }: { conversationId: string | null }) {
  const { t } = useTranslation("page");
  const entry = useConversationAgentRun(conversationId);
  const { selection, selectLatest, selectRun, locateMessage } = useAgentRunSelection();
  const epoch = useAgentRunEpoch(conversationId);
  const selectedRunId = selection.mode === "history" ? selection.runId : null;
  const history = useAgentRunHistory(conversationId, selectedRunId, epoch);
  const list = useAgentRunList(conversationId, entry?.run.id ?? null, epoch);
  const [open, setOpen] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [resuming, setResuming] = React.useState(false);
  const [filter, setFilter] = React.useState<AgentRunEventFilter>("all");
  const [loadingOlderLatest, setLoadingOlderLatest] = React.useState(false);
  const [olderFailedLatest, setOlderFailedLatest] = React.useState(false);
  const olderLatestInFlightRef = React.useRef(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  // 只在展开时订阅正文引用:收起态不因流式增量重渲染;展开态构建 toolCallId → 消息索引。
  const detail = useConversationStore((state) =>
    open && conversationId ? (state.entries[conversationId]?.detail ?? null) : null,
  );
  const toolMessages = React.useMemo(() => buildToolCallMessageIndex(detail), [detail]);
  // O4:边界定义来自 run 级投影(全部 boundary 事件),与当前事件页是否加载到来源无关。
  // 只在展开时读取;历史选中期间读历史 run 的投影,latest 跟随当前 run。
  const projectionRunId = open ? (selectedRunId ?? entry?.run.id ?? null) : null;
  const projection = useRunPlanProjection(conversationId, projectionRunId, epoch);
  // 实时 run 中途权限变化会产生新 boundaryId:投影若早于定义取回,引用会短暂缺失。
  // 检测到缺失引用时补拉一次(同一缺失锚点只补一次,坏数据不会形成请求环)。
  const projectionEvents = selectedRunId !== null ? history.events : (entry?.events ?? []);
  const projectionKnown = projection.projection?.boundaries ?? null;
  const missingBoundaryKey = React.useMemo(() => {
    if (!open || !projectionRunId || !projectionKnown) return null;
    for (const event of projectionEvents) {
      if (event.kind === "boundary") continue;
      const boundaryId = payloadString(payloadObject(event.payload), "boundaryId");
      if (boundaryId && !projectionKnown[boundaryId]) return `${projectionRunId}:${event.seq}`;
    }
    return null;
  }, [open, projectionRunId, projectionKnown, projectionEvents]);
  const lastReloadedBoundaryKey = React.useRef<string | null>(null);
  const reloadProjection = projection.reload;
  React.useEffect(() => {
    if (!missingBoundaryKey || projection.loading) return;
    if (lastReloadedBoundaryKey.current === missingBoundaryKey) return;
    lastReloadedBoundaryKey.current = missingBoundaryKey;
    reloadProjection();
  }, [missingBoundaryKey, projection.loading, reloadProjection]);

  // 本组件的「有 run / 无 run」是异步出现的:早退必须在全部 hook 之后,
  // 否则 entry 从 null 变成有值时会多出后面这个 useMemo(React #310)。
  const eventsForFilter = selectedRunId !== null ? history.events : (entry?.events ?? []);
  const filteredEvents = React.useMemo(
    () => filterAgentRunEvents(eventsForFilter, filter),
    [eventsForFilter, filter],
  );

  // 生命周期 L2:只有「最近一条 stopped/interrupted」是恢复候选;能否恢复由服务端判定
  // (GET recovery),前端不自行推断。历史 run 保持只读——恢复语义是接着当前任务跑,
  // 历史任务之后可能已发布新计划,沿用它就是错的。
  const resumeCandidateId =
    selectedRunId === null &&
    entry?.run &&
    entry.run.status === "stopped" &&
    entry.run.stopReason === "interrupted"
      ? entry.run.id
      : null;
  const recovery = useRunRecovery(conversationId, resumeCandidateId, epoch);
  const canResume = resumeCandidateId !== null && recovery.recovery?.mode === "new_run";

  if (!entry) return null;

  const isHistory = selectedRunId !== null;
  const selectedHistory =
    selectedRunId !== null ? (list.runs.find((item) => item.id === selectedRunId) ?? null) : null;
  const run = isHistory ? selectedHistory : entry.run;
  const events = isHistory ? history.events : entry.events;
  const hasMore = isHistory ? history.hasMore : entry.hasMore;
  const loadingOlder = isHistory ? history.loadingOlder : loadingOlderLatest;
  const loadOlderError = isHistory
    ? history.olderFailed
      ? t("conversations.agent_run.load_older_failed")
      : null
    : olderFailedLatest
      ? t("conversations.agent_run.load_older_failed")
      : null;
  const loadingEvents = isHistory ? history.loading : false;
  const historyError =
    history.error === "missing"
      ? t("conversations.agent_run.history_missing")
      : history.error === "failed"
        ? t("conversations.agent_run.history_failed")
        : null;
  const eventsError = isHistory ? historyError : (run?.error ?? null);

  const handleLocateToolCall = (toolCallId: string) => {
    const messageId = toolMessages.get(toolCallId);
    if (!messageId) {
      toast.info(t("conversations.agent_run.locate_missing"));
      return;
    }
    locateMessage(messageId, toolCallId);
  };

  const handleLoadOlderLatest = async () => {
    if (
      !conversationId ||
      olderLatestInFlightRef.current ||
      !entry.hasMore ||
      entry.minSeq === null
    ) {
      return;
    }
    const runId = entry.run.id;
    const windowToken = entry.windowToken;
    const beforeSeq = entry.minSeq;
    olderLatestInFlightRef.current = true;
    setLoadingOlderLatest(true);
    setOlderFailedLatest(false);
    try {
      const page = await fetchAgentRunEventPage(conversationId, runId, beforeSeq);
      // 重连(代次前进)或离开窗格后的迟到响应直接丢弃;run/token 由 store 再兜一层。
      if (agentRunEpoch(conversationId) !== epoch) return;
      prependConversationAgentRunPage(conversationId, runId, page, windowToken);
    } catch (error) {
      console.error("Load older agent run events failed:", error);
      setOlderFailedLatest(true);
    } finally {
      olderLatestInFlightRef.current = false;
      setLoadingOlderLatest(false);
    }
  };

  // 停滞/轮次耗尽是"判断层"的终局:机器保留全部上下文停下来,由人决定继续还是改目标。
  // 「继续」走正常发消息入口(新用户消息 = 高层反馈,计数与目标锁随之重置);
  // 「改目标」只把焦点交给本窗格的输入框,不替用户改写任何东西。历史 run 只读。
  const canNudge =
    !isHistory && (entry.run.status === "stalled" || entry.run.status === "exhausted");
  const handleContinue = async () => {
    if (!conversationId || sending) return;
    setSending(true);
    try {
      await api.post(`conversations/${conversationId}/messages`, {
        parts: [{ type: "text", text: t("conversations.agent_run.actions.continue_message") }],
      });
    } catch (error) {
      toast.error(extractErrorMessage(error, t("conversations.agent_run.actions.send_failed")));
    } finally {
      setSending(false);
    }
  };
  const handleChangeGoal = () => {
    // 分栏时每个窗格各有一个输入框:从本面板向上找所属 .chat-pane,避免聚焦到邻列。
    const pane = rootRef.current?.closest(".chat-pane");
    const textarea = pane?.querySelector<HTMLTextAreaElement>("textarea");
    textarea?.focus();
    textarea?.scrollIntoView({ block: "nearest" });
  };
  // 恢复:服务端写入恢复消息并点火生成,新 run 由服务端链接到旧 run;
  // 前端只跟随既有 SSE,不伪造任何 run 状态。
  const handleResume = async () => {
    if (!conversationId || !resumeCandidateId || resuming) return;
    setResuming(true);
    try {
      await postAgentRunResume(conversationId, resumeCandidateId);
    } catch (error) {
      toast.error(extractErrorMessage(error, t("conversations.agent_run.actions.resume_failed")));
      recovery.reload();
    } finally {
      setResuming(false);
    }
  };

  const status = run?.status ?? null;
  const statusLabel = status
    ? t(`conversations.agent_run.status.${status}`, { defaultValue: status })
    : t("conversations.agent_run.loading_history");
  const phaseLabel = run
    ? t(`conversations.agent_run.phase.${run.phase}`, { defaultValue: run.phase })
    : null;
  const toolCalls = events.reduce(
    (count, event) => (event.kind === "tool_call" ? count + 1 : count),
    0,
  );
  const parts = [
    statusLabel,
    phaseLabel,
    run ? t("conversations.agent_run.rounds", { count: run.rounds }) : null,
    run ? t("conversations.agent_run.tools", { count: toolCalls }) : null,
    run && run.attempts > 0 ? t("conversations.agent_run.retries", { count: run.attempts }) : null,
    run && run.replanCount > 0
      ? t("conversations.agent_run.replans", { count: run.replanCount })
      : null,
  ].filter((part): part is string => part !== null);

  const StatusIcon = status ? (STATUS_ICON[status] ?? CircleHelp) : CircleHelp;
  const statusTone = status ? (STATUS_TONE[status] ?? "") : "";
  const duration =
    run?.endedAt != null
      ? formatDuration(run.endedAt - run.startedAt)
      : status === "running"
        ? t("conversations.agent_run.live")
        : null;
  const terminalReason = run?.stopReason ?? run?.stallReason ?? null;
  const historyOptions = list.runs.filter((item) => item.id !== entry.run.id);
  const selectedMissing =
    selectedRunId !== null && !list.runs.some((item) => item.id === selectedRunId);
  const hasNewerRun = selectedRunId !== null && entry.run.id !== selectedRunId;

  return (
    <div ref={rootRef} className="mx-auto mb-2 w-full max-w-3xl px-4">
      <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] text-xs text-[var(--ds-text-secondary)]">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded text-left outline-none transition-colors hover:bg-[var(--ds-on-surface)] focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <StatusIcon
              className={cn(
                "size-3.5 shrink-0",
                status === "running" && "animate-spin",
                statusTone,
              )}
            />
            <span className="shrink-0 font-medium text-[var(--ds-text-primary)]">
              {isHistory
                ? t("conversations.agent_run.history_title")
                : t("conversations.agent_run.title")}
            </span>
            <span className="min-w-0 flex-1 truncate tabular-nums">{parts.join(" · ")}</span>
            {duration ? <span className="shrink-0 tabular-nums">{duration}</span> : null}
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-(--ds-duration-fast) ease-(--ds-ease-swift) motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </button>
          {historyOptions.length > 0 || isHistory ? (
            // 原生 select 在窄侧栏 + 大字号下会把标题/时长顶穿(用户截图里的
            // “本次运行 4:04[最新运行]”重叠)。改成图标下拉:触发器只占一个图标位,
            // 运行列表放进菜单,宽度由菜单自己撑开。
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("conversations.agent_run.selector_label")}
                  title={t("conversations.agent_run.selector_label")}
                  className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <History className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-w-72">
                <DropdownMenuLabel>{t("conversations.agent_run.selector_label")}</DropdownMenuLabel>
                <DropdownMenuItem
                  className="gap-2"
                  onSelect={() => {
                    selectLatest();
                  }}
                >
                  <Check
                    aria-hidden
                    className={cn("size-3.5 shrink-0", selectedRunId !== null && "opacity-0")}
                  />
                  <span className="truncate">{t("conversations.agent_run.latest_option")}</span>
                </DropdownMenuItem>
                {selectedMissing && selectedRunId !== null ? (
                  <DropdownMenuItem disabled className="gap-2">
                    <Check aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate">{shortToolCallId(selectedRunId, 10)}</span>
                  </DropdownMenuItem>
                ) : null}
                {historyOptions.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    className="gap-2"
                    onSelect={() => {
                      selectRun(item.id);
                      setOpen(true);
                    }}
                  >
                    <Check
                      aria-hidden
                      className={cn("size-3.5 shrink-0", selectedRunId !== item.id && "opacity-0")}
                    />
                    <span className="truncate">{formatRunOption(item, t)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {run?.goal ? (
          <p
            className="truncate border-t border-[var(--ds-divider)] px-3 py-1.5 leading-5 text-[var(--ds-text-tertiary)]"
            title={run.goal}
          >
            {t("conversations.agent_run.goal_label")}：{run.goal}
          </p>
        ) : null}
        {isHistory ? (
          <div className="flex items-center gap-2 border-t border-[var(--ds-divider)] px-3 py-1">
            <span className="min-w-0 flex-1 truncate text-[var(--ds-text-tertiary)]">
              {hasNewerRun
                ? t("conversations.agent_run.newer_run")
                : t("conversations.agent_run.history_readonly")}
            </span>
            <Button type="button" size="xs" variant="ghost" onClick={selectLatest}>
              {t("conversations.agent_run.back_to_latest")}
            </Button>
          </div>
        ) : null}
        {terminalReason ? (
          <p
            className="truncate border-t border-[var(--ds-divider)] px-3 py-1.5 leading-5 text-[var(--ds-text-tertiary)]"
            title={terminalReason}
          >
            {t("conversations.agent_run.terminal_reason", { reason: terminalReason })}
          </p>
        ) : null}
        {canResume ? (
          <div className="flex items-center gap-1.5 border-t border-[var(--ds-divider)] px-3 py-1.5">
            <Button
              type="button"
              size="xs"
              variant="tertiary"
              className="shrink-0"
              onClick={handleResume}
              disabled={resuming || !conversationId}
            >
              {resuming ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              {t("conversations.agent_run.actions.resume")}
            </Button>
            <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-[var(--ds-text-tertiary)]">
              {t("conversations.agent_run.actions.resume_hint")}
            </span>
          </div>
        ) : null}
        {canNudge ? (
          <div className="flex items-center gap-1.5 border-t border-[var(--ds-divider)] px-3 py-1.5">
            <Button
              type="button"
              size="xs"
              variant="tertiary"
              className="shrink-0"
              onClick={handleContinue}
              disabled={sending || !conversationId}
            >
              {sending ? <Loader2 className="animate-spin" /> : <Play />}
              {t("conversations.agent_run.actions.continue")}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={handleChangeGoal}>
              <Target />
              {t("conversations.agent_run.actions.change_goal")}
            </Button>
          </div>
        ) : null}
        {open ? (
          <>
            <div className="flex flex-wrap items-center gap-1 border-t border-[var(--ds-divider)] px-3 py-1.5">
              {FILTERS.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={filter === item}
                  onClick={() => setFilter(item)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                    filter === item
                      ? "bg-[var(--ds-on-surface)] font-medium text-[var(--ds-text-primary)]"
                      : "text-[var(--ds-text-tertiary)] hover:text-[var(--ds-text-secondary)]",
                  )}
                >
                  {t(`conversations.agent_run.filter.${item}`)}
                </button>
              ))}
              <span className="ml-auto shrink-0 tabular-nums text-[var(--ds-text-tertiary)]">
                {t("conversations.agent_run.loaded_events", { count: events.length })}
              </span>
            </div>
            <AgentRunEventList
              events={filteredEvents}
              error={eventsError}
              loading={loadingEvents}
              hasMore={hasMore}
              loadingOlder={loadingOlder}
              loadOlderError={loadOlderError}
              onLoadOlder={isHistory ? history.loadOlder : handleLoadOlderLatest}
              onLocateToolCall={handleLocateToolCall}
              boundaries={projection.projection?.boundaries ?? {}}
              boundariesLoading={projection.loading}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
