// foundation/types/settings/context-budget-config.ts — 上下文预算与工具输出老化(PC 专属)
//
// 纪律:所有开关默认关——关闭时请求逐字节保持引入前形态,任何旧会话/旧备份升级后无感。
// 开启后只影响聊天引擎的编码产物:窗口起点按 token 预算裁决、过旧的工具输出折叠为占位,
// 数据库原文与压缩记录一个字节都不改(与手动压缩同一非破坏性纪律)。
// 跨端:导出安卓时整块剥离(backup/export.ts 的 stripPcOnly 块 + backup/import.ts
// 的 PC_ONLY_SETTINGS_PRESERVED_ON_ANDROID_IMPORT);pc-backup(PC→PC)保留。
//
// 加载侧宽容原则(与 workspaceTools/subagent 同款):存量 state 无此键或字段损坏 →
// 逐字段回落默认,永不因一个坏字段让 state 起不来。

export interface ContextBudgetConfig {
  /** 总开关:关闭时预算窗口与工具老化都不参与编码(产物与引入前逐字节一致)。 */
  enabled: boolean;
  /** 工具输出老化子开关,受总开关门控。 */
  toolAgingEnabled: boolean;
  /** 保留最近多少个「含已执行工具」的消息轮次不老化(1–16)。 */
  toolAgingKeepTurns: number;
  /** 老化占位里保留的输出前缀字符数(0–2000);0 = 纯占位。 */
  toolAgingExcerptChars: number;
}

export function defaultContextBudgetConfig(): ContextBudgetConfig {
  return {
    enabled: false,
    toolAgingEnabled: false,
    toolAgingKeepTurns: 2,
    toolAgingExcerptChars: 200,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** 加载侧归一化:非对象/损坏字段逐项回落默认,永不抛错。 */
export function normalizeContextBudgetConfig(raw: unknown): ContextBudgetConfig {
  const defaults = defaultContextBudgetConfig();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaults;
  const input = raw as Record<string, unknown>;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : defaults.enabled,
    toolAgingEnabled: typeof input.toolAgingEnabled === "boolean" ? input.toolAgingEnabled : defaults.toolAgingEnabled,
    toolAgingKeepTurns: clampInt(input.toolAgingKeepTurns, defaults.toolAgingKeepTurns, 1, 16),
    toolAgingExcerptChars: clampInt(input.toolAgingExcerptChars, defaults.toolAgingExcerptChars, 0, 2000),
  };
}
