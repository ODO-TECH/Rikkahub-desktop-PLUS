import * as React from "react";
import { Bot } from "lucide-react";
import { toast } from "sonner";
import api from "~/services/api";
import type { AgentLoopSettings } from "~/types";
import type { SettingsSectionProps } from "~/components/settings/settings-registry";
import {
  SettingsFold,
  SettingsGroup,
  SettingsRows,
  SettingsRow,
  SettingsStack,
  SettingsSwitchRow,
} from "~/components/settings/shared";
import { WorkspaceToolsSection } from "~/components/settings/extensions/workspace";
import { Input } from "~/components/ui/input";
import { AgentBotAuditSection } from "./agent-bot-audit";

const defaults: AgentLoopSettings = {
  enabled: true,
  transportRetry: true,
  transportRetryDelaySeconds: 1,
  maxReplans: 2,
  stallRepeatLimit: 3,
  sameErrorLimit: 3,
  requireVerifiedCompletion: true,
  roundBudgetTokens: 0,
  schedulingEnabled: false,
};
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
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      disabled={disabled}
      aria-label={ariaLabel}
      className="w-24"
      onFocus={() => setFocused(true)}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

export function AgentBotSection({ settings, onSettings }: SettingsSectionProps) {
  const current = settings.agentLoop ?? defaults;
  const [audit, setAudit] = React.useState(false);
  const patch = async (partial: Partial<AgentLoopSettings>) => {
    try {
      const response = await api.post<{ agentLoop: AgentLoopSettings }>("settings/agent-loop", {
        ...partial,
        enabled: true,
      });
      onSettings({ ...settings, agentLoop: response.agentLoop });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <SettingsStack>
      <div className="flex items-start gap-3 py-2">
        <Bot className="mt-1 size-5 text-primary" />
        <div>
          <p className="font-medium">Agent⑨</p>
          <p className="mt-1 text-sm text-muted-foreground">
            新对话默认使用 Agent。同一会话可切换纯对话，历史与附件保留。工具执行沿用现有审批规则。
          </p>
        </div>
      </div>
      <SettingsGroup title="运行" description="轻量内核统一管理有限重试、上下文压缩和子任务。">
        <SettingsRows>
          <SettingsSwitchRow
            label="网络失败重试"
            description="仅在尚未输出内容时重试，最多两次。"
            checked={current.transportRetry}
            onCheckedChange={(v) => void patch({ transportRetry: v })}
          />
          <SettingsRow
            label="重试等待间隔"
            description="1–30 秒；第二次重试翻倍。服务端建议等待更久时优先等待，短值不会覆盖设置。"
            control={
              <NumberField
                value={current.transportRetryDelaySeconds ?? 1}
                min={1}
                max={30}
                disabled={!current.transportRetry}
                ariaLabel="重试等待间隔（秒）"
                onCommit={(value) => void patch({ transportRetryDelaySeconds: value })}
              />
            }
          />
          <SettingsSwitchRow
            label="验证计划完成"
            description="任务计划中还有未完成或缺少证据的步骤时，要求 Agent 继续核实。"
            checked={current.requireVerifiedCompletion}
            onCheckedChange={(v) => void patch({ requireVerifiedCompletion: v })}
          />
          <SettingsSwitchRow
            label="定时任务"
            description="允许已创建的定时任务启动 Agent；每项任务仍可单独停用。"
            checked={current.schedulingEnabled}
            onCheckedChange={(v) => void patch({ schedulingEnabled: v })}
          />
        </SettingsRows>
        <p className="pt-3 text-xs text-muted-foreground">
          每次运行最多 48 步，共享最多 96
          次模型请求；子任务默认一层、最多两个同时运行。重复失败会停止并保留结果。
        </p>
      </SettingsGroup>
      <SettingsFold
        id="agent-audit"
        title="运行记录"
        description="查看状态、失败原因和任务来源。"
        open={audit}
        onOpenChange={setAudit}
      >
        <AgentBotAuditSection />
      </SettingsFold>
      {/* 原「拓展 › 工作区工具」整页并入 Agent(2026-11-23 用户反馈)。 */}
      <SettingsGroup
        title="工作区工具"
        description="程序化工具（PTC）与工具契约开关；改动即时保存。"
      >
        <div className="pt-3">
          <WorkspaceToolsSection settings={settings} onSettings={onSettings} />
        </div>
      </SettingsGroup>
    </SettingsStack>
  );
}
