// 设置 › Agent › 工作区工具(2026-11-23 从「拓展」整页并入 Agent)。
//
// 这一页是 PC 工作区引擎的"面"级开关:程序化工具(PTC)与六个工具契约开关。
// 纪律:
//  - PTC 默认开(用户要求):模型面只剩一个 run_code,可折叠工具在程序里以 tools.*
//    调用;关闭时工具面/激活名/系统段逐字回到引入前。
//  - 契约开关沿用后端默认(全关):单个契约的语义在 workspace-tools-config.ts 里逐个
//    写明,这里只给开关与一句人话,不复述实现。
//  - 所有改动走独立端点即时保存(与上下文预算/AgentBot 同款),不做草稿。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { SquareTerminal } from "lucide-react";
import { toast } from "sonner";

import api from "~/services/api";
import type { Settings } from "~/types";
import type { PtcConfig } from "@server/foundation/types/settings";
import type { WorkspaceToolsConfig } from "@server/foundation/types/settings";
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

const PTC_TIMEOUT_MIN_S = 5;
const PTC_TIMEOUT_MAX_S = 600;

const DEFAULT_PTC: PtcConfig = { enabled: true, timeoutMs: 60_000 };
const DEFAULT_WORKSPACE_TOOLS: WorkspaceToolsConfig = {
  readContract: false,
  readDedup: false,
  searchCoverage: false,
  toolDiscovery: false,
  resumableOutput: false,
  mcpDescriptionCap: false,
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 失焦/回车提交的数字输入(与 AgentBot 页同一个交互口径)。 */
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
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

export function WorkspaceToolsSection({ settings, onSettings }: SettingsSectionProps) {
  const { t } = useTranslation();
  const ptc = settings.ptc ?? DEFAULT_PTC;
  const workspaceTools = settings.workspaceTools ?? DEFAULT_WORKSPACE_TOOLS;
  const [contractsOpen, setContractsOpen] = React.useState(false);

  const patchPtc = async (partial: Partial<PtcConfig>) => {
    const previous = settings.ptc ?? DEFAULT_PTC;
    const next = { ...previous, ...partial };
    // 乐观写入:失败回滚(与 AgentBot 页同一路径)。
    onSettings({ ...settings, ptc: next });
    try {
      const response = await api.post<{ ptc: PtcConfig }>("settings/ptc", partial);
      onSettings({ ...settings, ptc: response.ptc });
    } catch (error) {
      onSettings({ ...settings, ptc: previous });
      toast.error(errorText(error));
    }
  };

  const patchWorkspaceTools = async (partial: Partial<WorkspaceToolsConfig>) => {
    const previous = settings.workspaceTools ?? DEFAULT_WORKSPACE_TOOLS;
    const next = { ...previous, ...partial };
    onSettings({ ...settings, workspaceTools: next });
    try {
      const response = await api.post<{ workspaceTools: WorkspaceToolsConfig }>(
        "settings/workspace-tools",
        partial,
      );
      onSettings({ ...settings, workspaceTools: response.workspaceTools });
    } catch (error) {
      onSettings({ ...settings, workspaceTools: previous });
      toast.error(errorText(error));
    }
  };

  const enabledContracts = Object.values(workspaceTools).filter(Boolean).length;
  const totalContracts = Object.keys(DEFAULT_WORKSPACE_TOOLS).length;

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings:workspace.ptc_title")}
        description={t("settings:workspace.ptc_desc")}
      >
        <SettingsRows>
          <SettingsSwitchRow
            label={t("settings:workspace.ptc_enable")}
            description={t("settings:workspace.ptc_enable_desc")}
            checked={ptc.enabled}
            onCheckedChange={(checked) => void patchPtc({ enabled: checked })}
          />
          <SettingsRow
            label={t("settings:workspace.ptc_timeout")}
            description={t("settings:workspace.ptc_timeout_desc")}
            control={
              <div className="flex items-center gap-1.5 text-xs text-[var(--ds-text-tertiary)]">
                <NumberField
                  value={Math.round(ptc.timeoutMs / 1000)}
                  min={PTC_TIMEOUT_MIN_S}
                  max={PTC_TIMEOUT_MAX_S}
                  disabled={!ptc.enabled}
                  ariaLabel={t("settings:workspace.ptc_timeout")}
                  onCommit={(seconds) => void patchPtc({ timeoutMs: seconds * 1000 })}
                />
                <span>s</span>
              </div>
            }
          />
        </SettingsRows>
      </SettingsGroup>

      {/* 契约默认全关:每个开关只改变一条读/搜工具的输出形态。收起的摘要直接写
          "已启用 N/6",不点开也知道现状。 */}
      <SettingsFold
        id="workspace-tools-contracts"
        title={t("settings:workspace.contracts_title")}
        description={t("settings:workspace.contracts_desc")}
        summary={t("settings:workspace.contracts_summary", {
          enabled: enabledContracts,
          total: totalContracts,
        })}
        open={contractsOpen}
        onOpenChange={setContractsOpen}
      >
        <SettingsRows>
          <SettingsSwitchRow
            label={t("settings:workspace.read_contract")}
            description={t("settings:workspace.read_contract_desc")}
            checked={workspaceTools.readContract}
            onCheckedChange={(checked) => void patchWorkspaceTools({ readContract: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:workspace.read_dedup")}
            description={t("settings:workspace.read_dedup_desc")}
            checked={workspaceTools.readDedup}
            onCheckedChange={(checked) => void patchWorkspaceTools({ readDedup: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:workspace.search_coverage")}
            description={t("settings:workspace.search_coverage_desc")}
            checked={workspaceTools.searchCoverage}
            onCheckedChange={(checked) => void patchWorkspaceTools({ searchCoverage: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:workspace.tool_discovery")}
            description={t("settings:workspace.tool_discovery_desc")}
            checked={workspaceTools.toolDiscovery}
            onCheckedChange={(checked) => void patchWorkspaceTools({ toolDiscovery: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:workspace.resumable_output")}
            description={t("settings:workspace.resumable_output_desc")}
            checked={workspaceTools.resumableOutput}
            onCheckedChange={(checked) => void patchWorkspaceTools({ resumableOutput: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:workspace.mcp_description_cap")}
            description={t("settings:workspace.mcp_description_cap_desc")}
            checked={workspaceTools.mcpDescriptionCap}
            onCheckedChange={(checked) => void patchWorkspaceTools({ mcpDescriptionCap: checked })}
          />
        </SettingsRows>
      </SettingsFold>

      <div className="flex gap-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4 py-3">
        <SquareTerminal
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-[var(--ds-text-tertiary)]"
        />
        <p className="min-w-0 text-xs text-[var(--ds-text-secondary)]">
          {t("settings:workspace.notice")}
        </p>
      </div>
    </SettingsStack>
  );
}

/** 供设置注册表校准:Settings 里这些字段是 PC-only,老后端(只换前端没换 exe)可能缺。 */
export type WorkspaceSettingsFields = Pick<Settings, "ptc" | "workspaceTools">;
