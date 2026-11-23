// components/settings/data/debug-port.tsx — 数据管理 › Web 服务 › 调试端口
//
// 后端能力见 pc-server/debug/server.ts:默认关闭、只绑 127.0.0.1、可随时开关(即时生效)。
// 这里是给用户/排障者的一键入口:开关、端口、可选令牌、运行状态与调试台链接。
// 端口与令牌只在点「保存」时提交;开关本身立即保存——用户预期"拨过去就该通"。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Notice } from "~/components/ui/notice";
import { StatusBadge } from "~/components/ui/status-badge";
import api from "~/services/api";
import { patchSettingsLocal } from "~/lib/settings-patch";
import {
  PasswordInput,
  SettingsField,
  SettingsGroup,
  SettingsRow,
  SettingsRows,
  SettingsSwitchRow,
} from "~/components/settings/shared";
import type { Settings } from "~/types";

interface DebugRuntime {
  running: boolean;
  port: number | null;
  error: string | null;
}

interface DebugSettingsResponse {
  debugServer?: { enabled: boolean; port: number; token: string };
  runtime?: DebugRuntime;
}

export function DebugPortSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const saved = settings.debugServer ?? { enabled: false, port: 17456, token: "" };
  const portId = React.useId();
  const tokenId = React.useId();

  const [portDraft, setPortDraft] = React.useState(String(saved.port));
  const [tokenDraft, setTokenDraft] = React.useState(saved.token ?? "");
  const [saving, setSaving] = React.useState(false);
  const [runtime, setRuntime] = React.useState<DebugRuntime | null>(null);

  // 设置被其他端/其他页面改动时回填；正在输入的文本框不回推。
  React.useEffect(() => {
    if (document.activeElement?.id !== portId) setPortDraft(String(saved.port));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.port]);
  React.useEffect(() => {
    if (document.activeElement?.id !== tokenId) setTokenDraft(saved.token ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.token]);

  const submit = React.useCallback(
    async (patch: { enabled?: boolean; port?: number; token?: string }): Promise<boolean> => {
      setSaving(true);
      try {
        const body = {
          enabled: patch.enabled ?? saved.enabled,
          port: patch.port ?? saved.port,
          token: patch.token ?? saved.token ?? "",
        };
        const result = await api.post<DebugSettingsResponse>("settings/debug-server", body);
        const next = result.debugServer ?? { ...body };
        onSettings({ ...settings, debugServer: next });
        patchSettingsLocal({ debugServer: next });
        if (result.runtime) {
          setRuntime(result.runtime);
          if (!result.runtime.running) {
            toast.error(result.runtime.error || t("settings:data.debug_start_failed"));
          }
        }
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("settings:data.debug_save_failed"));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [saved, settings, onSettings, t],
  );

  const saveFields = React.useCallback(async () => {
    const port = Number(portDraft.trim());
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      toast.error(t("settings:data.debug_port_invalid"));
      return;
    }
    if (await submit({ port, token: tokenDraft.trim() })) {
      toast.success(t("settings:data.debug_saved"));
    }
  }, [portDraft, tokenDraft, submit, t]);

  const activePort = runtime?.port ?? saved.port;
  // 页面初次加载没有运行时探针:开关已保存视为运行中(bootstrap 会拉起),
  // 保存后以接口返回的 runtime 为准。
  const running = runtime ? runtime.running : saved.enabled;
  const debugUrl = `http://127.0.0.1:${activePort}/debug${saved.token ? `?token=${encodeURIComponent(saved.token)}` : ""}`;

  return (
    <SettingsGroup
      title={t("settings:data.debug_title")}
      description={t("settings:data.debug_desc")}
      action={
        <StatusBadge tone={saved.enabled && running ? "success" : "neutral"}>
          {saved.enabled && running
            ? t("settings:data.debug_running")
            : t("settings:data.debug_stopped")}
        </StatusBadge>
      }
    >
      <SettingsRows className="mt-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4">
        <SettingsSwitchRow
          label={t("settings:data.debug_switch")}
          description={t("settings:data.debug_switch_hint")}
          checked={saved.enabled}
          disabled={saving}
          onCheckedChange={(checked) => void submit({ enabled: checked })}
        />
        <SettingsRow
          label={t("settings:data.debug_port")}
          htmlFor={portId}
          description={t("settings:data.debug_port_hint")}
          control={
            <Input
              id={portId}
              className="w-28 font-mono tabular-nums"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              disabled={saving}
              value={portDraft}
              onChange={(event) => setPortDraft(event.target.value.replace(/\D/g, "").slice(0, 5))}
            />
          }
        />
      </SettingsRows>

      <SettingsField
        className="mt-4"
        label={t("settings:data.debug_token")}
        htmlFor={tokenId}
        description={t("settings:data.debug_token_hint")}
        trailing={
          <Button
            type="button"
            size="compact"
            variant="tertiary"
            disabled={saving}
            onClick={() => void saveFields()}
          >
            {saving ? <Loader2 className="animate-spin" /> : null}
            {t("settings:data.debug_save")}
          </Button>
        }
      >
        <PasswordInput
          id={tokenId}
          value={tokenDraft}
          onChange={setTokenDraft}
          placeholder=""
        />
      </SettingsField>

      {saved.enabled && running ? (
        <div className="mt-3 space-y-2">
          <Button asChild size="compact" variant="tertiary">
            <a href={debugUrl} target="_blank" rel="noreferrer">
              <ExternalLink />
              {t("settings:data.debug_open")}
            </a>
          </Button>
          <p className="break-all font-mono text-xs text-[var(--ds-text-secondary)]">
            {t("settings:data.debug_endpoints")}
          </p>
        </div>
      ) : null}
      {runtime?.error ? (
        <Notice className="mt-3" tone="warning">
          {runtime.error}
        </Notice>
      ) : null}
    </SettingsGroup>
  );
}
