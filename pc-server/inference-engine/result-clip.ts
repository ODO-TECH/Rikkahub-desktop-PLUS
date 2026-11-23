// inference-engine/result-clip.ts — 工具结果进上下文前的头尾裁剪(常开,可关)
//
// 参照 dsh-flash-presets 的 tool-result-pruner:单条结果超过阈值 → 头 headChars +
// 固定标记 + 尾 tailChars,中段丢弃。与应急截断(95% 窗口才触发、按 part token 选最大)
// 和工具老化(按"第几轮之前")都不同:本层按"这条有多长",与窗口余量、轮次都无关,
// 所以它能第一次就把 50 KB 的工具输出挡在请求之外。
//
// 纪律:
//  - 只作用于富化产物(发送面)。DB 原文、时间线、搜索索引、导出、备份逐字不动;
//    标记里写明用 read_original / read 的 offset 逐字取回。
//  - **阈值内逐字节不变**(直接返回原对象),前缀缓存稳定。
//  - 未完成(pending)的 part 不碰;error 条目原样保留(只裁文本条目)。
//  - 被钉住的消息跳过(钉住 = 用户要求逐字在场)。
//  - 防御性夹取:任何配置下都必须"裁完更短",否则不裁。

import type { Message, ToolOutputEntry, ToolPart } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import { isPinnedMessage } from "./engine-compaction";
import { hasPendingOutput } from "./context-budget";

export interface ResultClip {
  thresholdChars: number;
  headChars: number;
  tailChars: number;
}

export interface ResultClipResult {
  messages: Message[];
  /** 被裁剪的文本条目数(0 = 无变化,调用方应保持原数组引用)。 */
  clippedParts: number;
  /** 被丢弃的中段字符总数。 */
  clippedChars: number;
}

/** 标记的固定部分;实算长度另加 "k chars" 的数字位数。 */
const MARKER_PREFIX = "\n[... middle clipped: ";
const MARKER_SUFFIX = " chars — the original is still in the timeline; use read_original, or read with offset, to recover it ...]\n";

function markerFor(dropped: number): string {
  return `${MARKER_PREFIX}${dropped}${MARKER_SUFFIX}`;
}

/** 单条文本裁剪。返回 null = 不需要裁(调用方保留原对象)。 */
export function clipToolResultText(text: string, clip: ResultClip): string | null {
  const threshold = Math.max(1, Math.floor(clip.thresholdChars));
  if (text.length <= threshold) return null;
  const markerWorst = markerFor(text.length).length;
  // 防御性夹取:头尾之和必须给标记留够位置,否则宁可不裁。
  const tail = Math.max(0, Math.min(Math.floor(clip.tailChars), threshold - markerWorst - 1));
  const head = Math.max(0, Math.min(Math.floor(clip.headChars), threshold - markerWorst - tail - 1));
  if (head <= 0 && tail <= 0) return null;
  const dropped = text.length - head - tail;
  if (dropped <= 0) return null;
  return `${text.slice(0, head)}${markerFor(dropped)}${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

/** 富化层步骤:裁所有未钉住消息里的工具文本输出。纯函数,不改入参。 */
export function clipToolResults(messages: Message[], clip: ResultClip): ResultClipResult {
  let clippedParts = 0;
  let clippedChars = 0;
  let changed = false;
  const result = messages.map((msg) => {
    if (!msg.parts.some((part) => part.type === "tool")) return msg;
    if (isPinnedMessage(msg)) return msg;
    let messageChanged = false;
    const parts = msg.parts.map((part) => {
      if (part.type !== "tool") return part;
      const tool = part as ToolPart;
      if (!Array.isArray(tool.output) || tool.output.length === 0) return part;
      if (hasPendingOutput(tool)) return part;
      let partChanged = false;
      const output = tool.output.map((entry) => {
        if (!isRecord(entry) || entry.type !== "text") return entry as ToolOutputEntry;
        const text = String((entry as { text?: unknown }).text ?? "");
        const clipped = clipToolResultText(text, clip);
        if (clipped == null) return entry as ToolOutputEntry;
        partChanged = true;
        clippedParts += 1;
        clippedChars += text.length - clipped.length;
        return { ...(entry as Record<string, unknown>), text: clipped } as ToolOutputEntry;
      });
      if (!partChanged) return part;
      messageChanged = true;
      return { ...tool, output };
    });
    if (!messageChanged) return msg;
    changed = true;
    return { ...msg, parts };
  });
  return changed
    ? { messages: result, clippedParts, clippedChars }
    : { messages, clippedParts: 0, clippedChars: 0 };
}
