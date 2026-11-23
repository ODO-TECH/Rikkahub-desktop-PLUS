// components/workspace/agent-run-schedules.tsx — 生命周期 L3:会话级定时任务
//
// 展示与操作都走服务端事实:下次运行时间由服务端算好返回,前端只格式化;
// 开关关闭时整块不渲染(记录仍在服务端,重新打开即恢复可见)。
import * as React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { CalendarClock, ChevronDown, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useSettingsStore } from "~/stores/app-store";
import api from "~/services/api";
import { extractErrorMessage } from "~/lib/error";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

export interface TaskScheduleDto {
  id: string;
  conversationId: string;
  goal: string;
  kind: "once" | "fixed_interval";
  runAt: number | null;
  intervalSeconds: number | null;
  nextRunAt: number;
  enabled: boolean;
  misfirePolicy: "skip" | "catch_up_once";
  lastRunAt: number | null;
  lastRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 一条调度的单行摘要(纯函数,面板与测试共用):状态 · 规则 · 下次/上次。 */
export function formatScheduleSummary(
  schedule: TaskScheduleDto,
  now: number,
  t: TFunction<"page">,
): string {
  const parts: string[] = [];
  parts.push(
    schedule.enabled
      ? t("conversations.agent_schedules.enabled")
      : t("conversations.agent_schedules.disabled"),
  );
  if (schedule.kind === "once") {
    parts.push(
      t("conversations.agent_schedules.once_at", {
        time: formatClock(schedule.runAt ?? schedule.nextRunAt),
      }),
    );
  } else {
    parts.push(
      t("conversations.agent_schedules.every", {
        minutes: Math.max(1, Math.round((schedule.intervalSeconds ?? 3600) / 60)),
      }),
    );
  }
  if (schedule.enabled && schedule.nextRunAt > now) {
    parts.push(
      t("conversations.agent_schedules.next_run", { time: formatClock(schedule.nextRunAt) }),
    );
  }
  if (schedule.lastRunAt !== null) {
    parts.push(
      t("conversations.agent_schedules.last_run", { time: formatClock(schedule.lastRunAt) }),
    );
  }
  return parts.join(" · ");
}

export function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 创建表单 → 请求体(纯函数):空目标/未填时间在客户端就拦下,服务端仍做同一校验。 */
export function scheduleDraftToBody(draft: {
  goal: string;
  kind: "once" | "fixed_interval";
  minutes: number;
  runAtLocal: string;
}): { ok: true; body: Record<string, unknown> } | { ok: false; error: "goal" | "time" } {
  const goal = draft.goal.trim();
  if (!goal) return { ok: false, error: "goal" };
  if (draft.kind === "once") {
    const at = draft.runAtLocal ? new Date(draft.runAtLocal).getTime() : Number.NaN;
    if (!Number.isFinite(at)) return { ok: false, error: "time" };
    return { ok: true, body: { goal, kind: "once", runAt: at } };
  }
  const minutes = Number.isFinite(draft.minutes) ? Math.round(draft.minutes) : Number.NaN;
  if (!Number.isFinite(minutes) || minutes < 1) return { ok: false, error: "time" };
  return {
    ok: true,
    body: { goal, kind: "fixed_interval", intervalSeconds: minutes * 60, misfirePolicy: "catch_up_once" },
  };
}

export function AgentRunSchedules({ conversationId }: { conversationId: string | null }) {
  const { t } = useTranslation("page");
  const agentLoop = useSettingsStore((state) => state.settings?.agentLoop);
  const [items, setItems] = React.useState<TaskScheduleDto[]>([]);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [goal, setGoal] = React.useState("");
  const [kind, setKind] = React.useState<"once" | "fixed_interval">("fixed_interval");
  const [minutes, setMinutes] = React.useState(60);
  const [runAtLocal, setRunAtLocal] = React.useState("");
  const [formError, setFormError] = React.useState<string | null>(null);
  const visible = agentLoop?.schedulingEnabled === true;

  const load = React.useCallback(async () => {
    if (!conversationId) return;
    try {
      const response = await api.get<{ schedules: TaskScheduleDto[] }>(
        `conversations/${conversationId}/task-schedules`,
      );
      setItems(response.schedules);
    } catch (error) {
      console.error("Load task schedules failed:", error);
    }
  }, [conversationId]);

  React.useEffect(() => {
    if (!visible) {
      setItems([]);
      return;
    }
    void load();
  }, [visible, load]);

  if (!visible || !conversationId) return null;

  const create = async () => {
    const draft = scheduleDraftToBody({ goal, kind, minutes, runAtLocal });
    if (!draft.ok) {
      setFormError(
        draft.error === "goal"
          ? t("conversations.agent_schedules.need_goal")
          : t("conversations.agent_schedules.need_time"),
      );
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api.post(`conversations/${conversationId}/task-schedules`, draft.body);
      setGoal("");
      await load();
    } catch (error) {
      const message = extractErrorMessage(error, t("conversations.agent_schedules.create_failed"));
      setFormError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (schedule: TaskScheduleDto) => {
    setBusy(true);
    try {
      await api.patch(`conversations/${conversationId}/task-schedules/${schedule.id}`, {
        enabled: !schedule.enabled,
      });
      await load();
    } catch (error) {
      toast.error(extractErrorMessage(error, t("conversations.agent_schedules.create_failed")));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (schedule: TaskScheduleDto) => {
    setBusy(true);
    try {
      await api.delete(`conversations/${conversationId}/task-schedules/${schedule.id}`);
      await load();
    } catch (error) {
      toast.error(extractErrorMessage(error, t("conversations.agent_schedules.delete_failed")));
    } finally {
      setBusy(false);
    }
  };

  const now = Date.now();
  const next = items
    .filter((item) => item.enabled)
    .sort((left, right) => left.nextRunAt - right.nextRunAt)[0];

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4">
      <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] text-xs text-[var(--ds-text-secondary)]">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left outline-none transition-colors hover:bg-[var(--ds-on-surface)] focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <CalendarClock aria-hidden className="size-3.5 shrink-0" />
          <span className="shrink-0 font-medium text-[var(--ds-text-primary)]">
            {t("conversations.agent_schedules.title")}
          </span>
          <span className="min-w-0 flex-1 truncate tabular-nums">
            {next
              ? formatScheduleSummary(next, now, t)
              : items.length > 0
                ? t("conversations.agent_schedules.all_disabled")
                : t("conversations.agent_schedules.empty")}
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-(--ds-duration-fast) ease-(--ds-ease-swift) motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </button>
        {open ? (
          <div className="space-y-2 border-t border-[var(--ds-divider)] px-3 py-2">
            {items.length > 0 ? (
              <ul className="space-y-1">
                {items.map((schedule) => (
                  <li key={schedule.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={schedule.goal}>
                      {schedule.goal}
                    </span>
                    <span className="shrink-0 tabular-nums text-[var(--ds-text-tertiary)]">
                      {formatScheduleSummary(schedule, now, t)}
                    </span>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void toggle(schedule)}
                    >
                      {schedule.enabled
                        ? t("conversations.agent_schedules.disable")
                        : t("conversations.agent_schedules.enable")}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label={t("conversations.agent_schedules.delete")}
                      disabled={busy}
                      onClick={() => void remove(schedule)}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[var(--ds-text-tertiary)]">
                {t("conversations.agent_schedules.empty")}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <Input
                className="h-7 min-w-40 flex-1 text-xs"
                value={goal}
                placeholder={t("conversations.agent_schedules.goal_placeholder")}
                onChange={(event) => setGoal(event.target.value)}
              />
              <select
                className="h-7 rounded border border-[var(--ds-divider)] bg-transparent px-1 text-[11px]"
                value={kind}
                onChange={(event) => setKind(event.target.value as "once" | "fixed_interval")}
              >
                <option value="fixed_interval">{t("conversations.agent_schedules.kind_interval")}</option>
                <option value="once">{t("conversations.agent_schedules.kind_once")}</option>
              </select>
              {kind === "fixed_interval" ? (
                <label className="flex items-center gap-1 text-[11px] text-[var(--ds-text-tertiary)]">
                  {t("conversations.agent_schedules.minutes_label")}
                  <Input
                    className="h-7 w-16 text-right text-xs tabular-nums"
                    inputMode="numeric"
                    value={String(minutes)}
                    onChange={(event) => setMinutes(Number(event.target.value))}
                  />
                </label>
              ) : (
                <input
                  type="datetime-local"
                  className="h-7 rounded border border-[var(--ds-divider)] bg-transparent px-1 text-[11px]"
                  value={runAtLocal}
                  onChange={(event) => setRunAtLocal(event.target.value)}
                />
              )}
              <Button type="button" size="xs" variant="tertiary" disabled={busy} onClick={() => void create()}>
                {busy ? <Loader2 className="animate-spin" /> : <Plus />}
                {t("conversations.agent_schedules.create")}
              </Button>
            </div>
            {formError ? <p className="text-[11px] text-destructive">{formError}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
