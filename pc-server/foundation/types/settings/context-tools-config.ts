// foundation/types/settings/context-tools-config.ts — 模型驱动的上下文工具面(PC 专属,仅工作区)
//
// 纪律:总开关默认关——关闭时工作区会话**一个工具都不注入**、系统提示词不加压缩哲学段、
// 不产生 nudge,出站请求与引入前逐字节一致。开启后也只影响工作区(pi)会话:聊天路径的
// 压缩仍由用户手动/自动压缩裁决,模型拿不到这些工具。
//
// 为什么只给工作区:聊天会话的增量以人类文本为主,模型自己写摘要的收益远小于编码式
// 会话(一次 read 就能塞进几千 token 工具输出)。参照项目 billion-context 的工具面
// (compress/decompress/search_context/acp_status)也是代理场景产物。
//
// 无损纪律:compress 只追加压缩记录,decompress 只翻 active 位,**原文一条不删**——
// 时间线/搜索索引/导出/备份始终看得到全量历史。read_original 直接从 SQLite 选中路径取原文。
//
// 跨端:导出安卓时整块剥离(backup/export.ts 的 stripPcOnly 块 + backup/import.ts 的
// PC_ONLY_SETTINGS_PRESERVED_ON_ANDROID_IMPORT);pc-backup(PC→PC)保留。
//
// 加载侧宽容原则(与 contextBudget/workspaceTools 同款):存量 state 无此键或字段损坏 →
// 逐字段回落默认,永不因一个坏字段让 state 起不来。

export interface ContextToolsConfig {
  /** 总开关:关闭时工具面完全消失(注入数组为空),系统提示词与 nudge 也不参与。 */
  enabled: boolean;
  /** 效率提示(nudge)子开关,受总开关门控。默认开:打开总开关即得到完整 S7 面。
   *  措辞纪律见 pi-engine/context-tools.ts——不报填充比例、带真实尺寸、临时尾部消息不落库。 */
  nudgeEnabled: boolean;
  /** 增速门控:自上次压缩以来新增原文 token 达到此值才提示一次(500–200000)。
   *  不照搬参照项目的平坦 50K——那是 CLI 编码代理的量级。rdp 工作区一次 read 约
   *  4–6K token,8000 ≈ 两次大读取,值得提一句又不至于每轮唠叨。 */
  nudgeGrowthTokens: number;
  /** read_original 单次返回的 token 上限(500–100000)。超出时**明确告知**哪几条没给、
   *  各自多大,让模型自己分批复取,绝不静默丢弃。 */
  readOriginalMaxTokens: number;
}

export function defaultContextToolsConfig(): ContextToolsConfig {
  return {
    enabled: false,
    nudgeEnabled: true,
    nudgeGrowthTokens: 8000,
    readOriginalMaxTokens: 8000,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** 加载侧归一化:非对象/损坏字段逐项回落默认,永不抛错。 */
export function normalizeContextToolsConfig(raw: unknown): ContextToolsConfig {
  const defaults = defaultContextToolsConfig();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaults;
  const input = raw as Record<string, unknown>;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : defaults.enabled,
    nudgeEnabled: typeof input.nudgeEnabled === "boolean" ? input.nudgeEnabled : defaults.nudgeEnabled,
    nudgeGrowthTokens: clampInt(input.nudgeGrowthTokens, defaults.nudgeGrowthTokens, 500, 200_000),
    readOriginalMaxTokens: clampInt(input.readOriginalMaxTokens, defaults.readOriginalMaxTokens, 500, 100_000),
  };
}