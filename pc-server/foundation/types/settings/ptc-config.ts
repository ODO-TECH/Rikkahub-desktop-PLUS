// foundation/types/settings/ptc-config.ts — PTC 程序化工具面(PC 专属,仅工作区)
//
// 参照 dsh-flash-presets 的 `tool-presentation: ptc`:模型面只暴露一个 `run_code`,
// 其余工作区/上下文工具在程序里以 `tools.*` 调用。程序跑在 QuickJS/WASM 硬沙箱里
// (见 inference-engine/quickjs-sandbox.ts),宿主 API 一律不可见。
//
// 纪律:
//  - **默认开**(用户明确要求),但保留总开关:关闭时工具面与系统段逐字节回到引入前。
//  - 仅工作区(pi)会话生效:聊天通路没有 bash 与工作区工具,没有折叠收益。
//  - 每次调用一个全新 VM,变量不跨程序保留(不做 REPL 常驻)。
//  - PC-only:导出安卓时整块剥离;加载侧宽容,坏字段逐项回落。

export interface PtcConfig {
  /** 总开关。关闭 = 直连工具面(与引入前一致)。 */
  enabled: boolean;
  /** 单个程序的墙钟上限(毫秒,5_000–600_000)。CPU 死循环由 VM 内 deadline 打断。 */
  timeoutMs: number;
}

export const PTC_TIMEOUT_MIN = 5_000;
export const PTC_TIMEOUT_MAX = 600_000;

export function defaultPtcConfig(): PtcConfig {
  return { enabled: true, timeoutMs: 60_000 };
}

/** 加载侧归一化:非对象/损坏字段逐项回落默认,永不抛错。 */
export function normalizePtcConfig(raw: unknown): PtcConfig {
  const defaults = defaultPtcConfig();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaults;
  const input = raw as Record<string, unknown>;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : defaults.enabled,
    timeoutMs:
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? Math.min(PTC_TIMEOUT_MAX, Math.max(PTC_TIMEOUT_MIN, Math.floor(input.timeoutMs)))
        : defaults.timeoutMs,
  };
}
