// 设置 › 实验功能 › AgentBot。
// 命名口径：对外（设置项名称）统一叫 AgentBot——一个较大的实验性能力，自主循环只是它的
// 一小部分（还有运行记录、判定终局、传输重试，后续会加任务生命周期与调度）。
// 存储与接口暂沿用 agentLoop / settings/agent-loop：改名只动展示面，避免无谓的数据迁移。
// 页面层级：AgentBot 是实验功能本体，页顶只放两颗开关（启用 AgentBot / 传输重试，单个
// 开关不套折叠）；「自主循环」是它的第一个板块，做成卡内折叠区，后续板块（任务生命周期、
// 调度）各自成一块平级排在下面。
// 纪律：与「记忆与上下文」「心情」实验平级成页，开关不塞进对方的卡片里。
// 总开关默认关闭——关闭时两条引擎通路与改动前逐字一致（不记 run、不判定、不重试）。
// transportRetry 是"零输出失败窗口"的稳定性修复，独立于总开关生效（见方案 §4.3）。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { FlaskConical } from "lucide-react";
import { toast } from "sonner";

import api, { isApiNotFound } from "~/services/api";
import type { AgentLoopSettings } from "~/types";
import {
  SettingsFold,
  SettingsGroup,
  SettingsRow,
  SettingsRows,
  SettingsStack,
  SettingsSwitchRow,
} from "~/components/settings/shared";
import { Input } from "~/components/ui/input";
import type { SettingsSectionProps } from "~/components/settings/settings-registry";
import { AgentBotAuditSection } from "~/components/settings/experiments/agent-bot-audit";

const DEFAULT_SETTINGS: AgentLoopSettings = {
  enabled: false,
  transportRetry: true,
  transportRetryDelaySeconds: 1,
  maxReplans: 2,
  stallRepeatLimit: 3,
  sameErrorLimit: 3,
  requireVerifiedCompletion: true,
  schedulingEnabled: false,
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 失焦 / 回车提交的数字输入：避免每敲一个数字就发一次设置请求。 */
function NumberField({
  value,
  min,
  max,
  disabled,
  ariaLabel,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  ariaLabel: string;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = React.useState(String(value));
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  const commit = () => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, Math.round(parsed)));
    setText(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <Input
      className="w-24 text-right tabular-nums"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={text}
      disabled={disabled}
      onChange={(event) => setText(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function AgentBotSection({ settings, onSettings }: SettingsSectionProps) {
  const { t } = useTranslation();
  const current = settings.agentLoop ?? DEFAULT_SETTINGS;

  const patch = async (partial: Partial<AgentLoopSettings>) => {
    const previous = settings.agentLoop ?? DEFAULT_SETTINGS;
    try {
      const response = await api.post<{ agentLoop: AgentLoopSettings }>(
        "settings/agent-loop",
        partial,
      );
      onSettings({ ...settings, agentLoop: response.agentLoop });
    } catch (err) {
      onSettings({ ...settings, agentLoop: previous });
      // 404 = 后端压根没有这个接口：界面是新的、程序是旧的（只换了前端没换 exe）。
      // 报 "Not found" 用户无法自救，这里直接说清是版本错配。
      toast.error(
        isApiNotFound(err)
          ? t("settings:experiments.agent_bot.stale_backend")
          : errorText(err),
      );
    }
  };

  const off = !current.enabled;
  // 板块折叠状态由本页持有：切走再回来复位为收起（与其他设置页的高级区一致）。
  const [loopOpen, setLoopOpen] = React.useState(false);
  const [auditOpen, setAuditOpen] = React.useState(false);

  return (
    <SettingsStack>
      <div className="flex gap-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4 py-3">
        <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--ds-text-tertiary)]" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-[var(--ds-text-primary)]">
            {t("settings:experiments.agent_bot.notice_title")}
          </p>
          <p className="text-xs text-[var(--ds-text-secondary)]">
            {t("settings:experiments.agent_bot.notice_desc")}
          </p>
        </div>
      </div>

      <SettingsGroup
        title={t("settings:experiments.agent_bot.master_title")}
        description={t("settings:experiments.agent_bot.master_desc")}
      >
        <SettingsRows>
          <SettingsSwitchRow
            label={t("settings:experiments.agent_bot.enable")}
            description={t("settings:experiments.agent_bot.enable_desc")}
            checked={current.enabled}
            onCheckedChange={(checked) => void patch({ enabled: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:experiments.agent_bot.transport_retry")}
            description={t("settings:experiments.agent_bot.transport_retry_desc")}
            checked={current.transportRetry}
            onCheckedChange={(checked) => void patch({ transportRetry: checked })}
          />
          <SettingsRow
            label={t("settings:experiments.agent_bot.transport_retry_delay")}
            description={t("settings:experiments.agent_bot.transport_retry_delay_desc")}
            control={
              <NumberField
                value={current.transportRetryDelaySeconds}
                min={1}
                max={30}
                disabled={!current.transportRetry}
                ariaLabel={t("settings:experiments.agent_bot.transport_retry_delay")}
                onCommit={(value) => void patch({ transportRetryDelaySeconds: value })}
              />
            }
          />
          <SettingsSwitchRow
            label={t("settings:experiments.agent_bot.scheduling")}
            description={t("settings:experiments.agent_bot.scheduling_desc")}
            checked={current.schedulingEnabled}
            disabled={!current.enabled}
            onCheckedChange={(checked) => void patch({ schedulingEnabled: checked })}
          />
        </SettingsRows>
      </SettingsGroup>

      {/* 自主循环只是 AgentBot 的一个板块：折叠成一块，收起时标题行仍露出阈值摘要，
          总开关关闭时摘要直接写「未启用」，不必点开就知道现状。 */}
      <SettingsFold
        id="agent-bot-loop"
        title={t("settings:experiments.agent_bot.fold_loop")}
        description={t("settings:experiments.agent_bot.fold_loop_desc")}
        summary={
          off
            ? t("settings:experiments.agent_bot.fold_loop_off")
            : t("settings:experiments.agent_bot.fold_loop_summary", {
                maxReplans: current.maxReplans,
                stallRepeatLimit: current.stallRepeatLimit,
                sameErrorLimit: current.sameErrorLimit,
              })
        }
        open={loopOpen}
        onOpenChange={setLoopOpen}
      >
        <SettingsRows>
          <SettingsSwitchRow
            label={t("settings:experiments.agent_bot.require_verified")}
            description={t("settings:experiments.agent_bot.require_verified_desc")}
            checked={current.requireVerifiedCompletion}
            disabled={off}
            onCheckedChange={(checked) => void patch({ requireVerifiedCompletion: checked })}
          />
          <SettingsRow
            label={t("settings:experiments.agent_bot.max_replans")}
            description={t("settings:experiments.agent_bot.max_replans_desc")}
            control={
              <NumberField
                value={current.maxReplans}
                min={0}
                max={10}
                disabled={off}
                ariaLabel={t("settings:experiments.agent_bot.max_replans")}
                onCommit={(value) => void patch({ maxReplans: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.agent_bot.stall_repeat_limit")}
            description={t("settings:experiments.agent_bot.stall_repeat_limit_desc")}
            control={
              <NumberField
                value={current.stallRepeatLimit}
                min={2}
                max={20}
                disabled={off}
                ariaLabel={t("settings:experiments.agent_bot.stall_repeat_limit")}
                onCommit={(value) => void patch({ stallRepeatLimit: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.agent_bot.same_error_limit")}
            description={t("settings:experiments.agent_bot.same_error_limit_desc")}
            control={
              <NumberField
                value={current.sameErrorLimit}
                min={2}
                max={20}
                disabled={off}
                ariaLabel={t("settings:experiments.agent_bot.same_error_limit")}
                onCommit={(value) => void patch({ sameErrorLimit: value })}
              />
            }
          />
        </SettingsRows>
      </SettingsFold>

      {/* 生命周期 L4:运行审计(跨会话只读)。与运行面板同源,不复制详情模型。 */}
      <SettingsFold
        id="agent-bot-audit"
        title={t("settings:experiments.agent_bot.audit_title")}
        description={t("settings:experiments.agent_bot.audit_desc")}
        summary={t("settings:experiments.agent_bot.audit_summary")}
        open={auditOpen}
        onOpenChange={setAuditOpen}
      >
        <AgentBotAuditSection />
      </SettingsFold>
    </SettingsStack>
  );
}
