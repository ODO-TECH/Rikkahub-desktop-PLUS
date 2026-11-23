// foundation/types/settings/result-clip-config.ts — 工具结果进上下文前的常开裁剪(PC 专属)
//
// 参照 dsh-flash-presets 的 tool-result-pruner:单条工具结果超过阈值时只留头尾,
// 中段换成固定标记。与「工具老化」的区别是作用时机与判据——老化看"第几轮之前",
// 裁剪看"这条有多长",与轮次无关;两者可以叠加(先裁剪,后老化)。
//
// 纪律:
//  - **默认开**。裁剪只发生在富化层(发送面),DB 原文、时间线、搜索索引、导出、
//    备份逐字不动;被裁的中段可用 read_original / read 的 offset 逐字取回。
//  - **阈值内逐字节不变**:低于 thresholdChars 的结果原文进请求,保证前缀缓存稳定。
//  - 硬约束 `headChars + 标记 + tailChars ≤ thresholdChars`,不满足按配置错误拒绝写入
//    (照抄参照的校验,防"裁完反而更长")。
//  - PC-only:导出安卓时整块剥离(backup/export.ts + backup/import.ts)。
//  - 加载侧宽容:存量 state 无此键或字段损坏 → 逐字段回落默认,永不因一个坏字段让 state 起不来。

export interface ResultClipConfig {
  /** 总开关。关闭时富化层不做任何裁剪,请求与引入前逐字节一致。 */
  enabled: boolean;
  /** 单条工具结果超过这个字符数才裁(1000–1,000,000)。 */
  thresholdChars: number;
  /** 保留的输出前缀字符数(0–threshold)。 */
  headChars: number;
  /** 保留的输出后缀字符数(0–threshold)。 */
  tailChars: number;
}

/** 标记文本的保守长度上界(含 dropped 计数最多 7 位数字与固定措辞)。
 *  配置校验用上界而不是实算:任何合法配置下"裁完必然更短"。 */
export const RESULT_CLIP_MARKER_RESERVE = 200;

export function defaultResultClipConfig(): ResultClipConfig {
  return { enabled: true, thresholdChars: 8192, headChars: 4096, tailChars: 1024 };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** 加载侧归一化:非对象/损坏字段逐项回落默认,永不抛错。 */
export function normalizeResultClipConfig(raw: unknown): ResultClipConfig {
  const defaults = defaultResultClipConfig();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaults;
  const input = raw as Record<string, unknown>;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : defaults.enabled,
    thresholdChars: clampInt(input.thresholdChars, defaults.thresholdChars, 1000, 1_000_000),
    headChars: clampInt(input.headChars, defaults.headChars, 0, 1_000_000),
    tailChars: clampInt(input.tailChars, defaults.tailChars, 0, 1_000_000),
  };
}

/** 写入侧校验:返回 null = 合法,否则是给人看的错误文案。
 *  照参照的硬约束:头 + 标记 + 尾必须 ≤ 阈值,否则裁剪会变长。 */
export function validateResultClipConfig(config: ResultClipConfig): string | null {
  if (config.headChars + RESULT_CLIP_MARKER_RESERVE + config.tailChars > config.thresholdChars) {
    return `headChars (${config.headChars}) + marker (${RESULT_CLIP_MARKER_RESERVE}) + tailChars (${config.tailChars}) must not exceed thresholdChars (${config.thresholdChars}); otherwise clipping would make the result longer.`;
  }
  return null;
}
