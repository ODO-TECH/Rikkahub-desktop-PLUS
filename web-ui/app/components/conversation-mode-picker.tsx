import * as React from "react";
import { useSearchParams } from "react-router";
import { Bot, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import api from "~/services/api";
import { useConversationStore } from "~/stores/conversation-store";
import { getLatestPlan } from "~/lib/plan-model";

import { PlanPanel } from "~/components/workbench/plan-panel";
import { PlanPanelToggle } from "~/components/workbench/plan-panel-toggle";

export function ConversationModePicker({
  conversationId,
  disabled,
}: {
  conversationId: string | null;
  disabled?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const detail = useConversationStore((s) =>
    conversationId ? s.entries[conversationId]?.detail : undefined,
  );
  const chatOnly = conversationId
    ? detail?.conversationKind === "chat"
    : params.get("mode") === "chat";
  const mode = chatOnly
    ? "chat"
    : conversationId
      ? (detail?.executionMode ?? "agent")
      : params.get("turn") === "chat"
        ? "chat"
        : "agent";
  const [pending, setPending] = React.useState(false);
  const change = async (next: "agent" | "chat") => {
    if (mode === next) return;
    setPending(true);
    try {
      if (conversationId)
        await api.post(`conversations/${conversationId}/mode`, { executionMode: next });
      else
        setParams(
          (previous) => {
            const p = new URLSearchParams(previous);
            if (next === "chat") p.set("turn", "chat");
            else p.delete("turn");
            return p;
          },
          { replace: true },
        );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  if (chatOnly) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="下一轮模式">
      <div
        className="inline-flex rounded-lg border bg-muted/40 p-0.5"
        role="group"
        aria-label="选择后续对话模式"
      >
        {(["agent", "chat"] as const).map((value) => (
          <button
            key={value}
            type="button"
            disabled={disabled || pending}
            aria-pressed={mode === value}
            onClick={() => void change(value)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${mode === value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            {value === "agent" ? (
              <Bot className="size-3.5" />
            ) : (
              <MessageSquare className="size-3.5" />
            )}
            {value === "agent" ? "Agent" : "纯对话"}
          </button>
        ))}
      </div>
      <span className="text-xs text-muted-foreground">
        {mode === "agent"
          ? "可使用工具、计划与子任务"
          : conversationId
            ? "从下一轮起禁用工作区工具，仅保留独立 Skill 与 MCP，直到切回 Agent"
            : "本会话以纯对话开始：禁用工作区工具，仅保留独立 Skill 与 MCP；随时可切回 Agent"}
      </span>
    </div>
  );
}

/**
 * 输入区上方的一整行:左侧档位开关,右侧计划入口;计划展开后紧贴在本行下方。
 * 计划原先放在右侧工作台(用户反馈"放在侧栏不方便看"),现在与档位同层,
 * 展开/收起不再挤占文件侧边栏。整行的宽度/水平内缩与输入卡一致。
 *
 * 2026-11-23 二次反馈:档位是「会话类型」而不是输入框的属性——新建会话时
 * 由左侧栏的新建选项决定,输入区不再提供档位;对话标签本身就是纯对话容器,
 * 也不显示档位。只有工作区里已存在的 Agent 会话才保留「下一轮」开关
 * (临时禁用工作区工具后还能切回来),计划入口始终按需出现。
 */
export function ComposerModeBar({
  conversationId,
  disabled,
  chatContainer,
}: {
  conversationId: string | null;
  disabled?: boolean;
  chatContainer?: boolean;
}) {
  const [planOpen, setPlanOpen] = React.useState(false);
  const detail = useConversationStore((s) =>
    conversationId ? s.entries[conversationId]?.detail : undefined,
  );
  const hasPlan = React.useMemo(() => Boolean(getLatestPlan(detail ?? null)), [detail]);
  React.useEffect(() => {
    if (!hasPlan) setPlanOpen(false);
  }, [hasPlan]);
  // 对话标签固定纯对话,不显示档位;工作区里新建的 Agent 草稿从第一轮就要能选
  // 「下一轮」档位(用户 2026-11-23 反馈:新建 Agent 的初始界面应显示);
  // 已有会话里纯对话类型不显示,Agent 类型在详情到位后显示。
  const showModePicker =
    !chatContainer &&
    (conversationId ? detail != null && detail.conversationKind !== "chat" : true);
  if (!showModePicker && !hasPlan) return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div className="flex flex-wrap items-center gap-2">
        {showModePicker ? (
          <ConversationModePicker conversationId={conversationId} disabled={disabled} />
        ) : null}
        {hasPlan ? (
          <div className="ml-auto flex shrink-0 items-center">
            <PlanPanelToggle
              conversationId={conversationId}
              open={planOpen}
              onToggle={() => setPlanOpen((current) => !current)}
            />
          </div>
        ) : null}
      </div>
      {planOpen ? (
        <div className="mt-1 overflow-hidden rounded-xl border bg-[var(--ds-surface-100)] shadow-[var(--ds-elevation-100)]">
          <PlanPanel conversationId={conversationId} variant="inline" />
        </div>
      ) : null}
    </div>
  );
}
