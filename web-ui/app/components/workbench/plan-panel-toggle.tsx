import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ListChecks } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useConversationStore } from "~/stores/conversation-store";
import { getLatestPlan } from "~/lib/plan-model";
import { planProgress } from "@server/tools/plan";
import { cn } from "~/lib/utils";

// 计划入口已从右侧工作台挪到输入区档位开关旁(2026-11-23 用户反馈:
// 计划放在侧栏里不方便看,应在输入区随手展开/收起)。
// 只在本会话真的存在一份计划时才出现;面板开关状态由 ComposerModeBar 持有。
export function PlanPanelToggle({
  conversationId,
  open,
  onToggle,
}: {
  conversationId?: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const detail = useConversationStore((state) =>
    conversationId ? state.entries[conversationId]?.detail : undefined,
  );
  const plan = React.useMemo(() => getLatestPlan(detail ?? null), [detail]);

  if (!plan) return null;
  const progress = planProgress(plan);
  const label = open ? t("workbench.plan.toggle_close") : t("workbench.plan.toggle_open");

  return (
    <Button
      type="button"
      variant={open ? "secondary" : "ghost"}
      size="sm"
      aria-label={label}
      title={label}
      aria-expanded={open}
      aria-pressed={open}
      className="h-7 shrink-0 gap-1 rounded-md px-2 text-xs"
      onClick={onToggle}
    >
      <ListChecks className="size-3.5" strokeWidth={1.75} />
      <span className="font-medium">{t("workbench.plan.title")}</span>
      <span className="tabular-nums text-muted-foreground">
        {progress.completed}/{progress.total}
      </span>
      <ChevronDown
        aria-hidden
        className={cn(
          "size-3 opacity-70 transition-transform duration-150 motion-reduce:transition-none",
          open && "rotate-180",
        )}
      />
    </Button>
  );
}
