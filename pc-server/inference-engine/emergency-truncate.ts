// inference-engine/emergency-truncate.ts — 常开应急截断(上下文压缩方案 v2 · S4)
//
// 定位:最后一道**自动生效**的护栏,不是压缩的替代。压缩要调模型、要用户开开关、要有
// 可摘要的原文;而一次上游 400 只需要一个塞满工具输出的长会话。参考实现 billion-context
// 的做法是:占用逼近窗口时无条件把最大的旧工具结果截短。本模块把同一裁决搬进富化层,
// 出厂设置(上下文预算关、自动压缩关)下也生效——D6「没有常开溢出保护」由此闭合。
//
// 纪律(与 context-budget 同一套):
//   - 不读 state.settings、不写库。原文改动为零,截断只发生在编码产物上;关掉调用方
//     传参立即回到逐字节旧行为。
//   - 不截 error / pending 输出(用户与模型都要看的事实),不截被钉住的消息(用户明示
//     要逐字保留),不截最近 N 条(本轮工具链正在用),不截摘要行(它已是压缩产物)。
//   - 占位仍写在 output 数组里 → toolPartExecuted 语义不变,工具 call/result 配对不变量
//     不变(截断只改文本长度,不删条目、不动 toolCallId),不会制造孤儿 result。
//   - 替换必须**严格更短**,否则跳过:头尾各 2000 字符 + 标记 ≈ 4060 字符,比这短的
//     输出截了反而更长(CJK 1000 token = 1000 字符,正好落在这一档)。
//   - reasoning 不截:Anthropic 工具链要求 thinking 块随 tool_use 回传,折叠会 400。
//
// 唯一的模块级状态是 latch(见下),它是前缀缓存稳定性的必要条件,不是配置缓存:
//   一旦某个 part 被截过,后续轮**逐字节重放**同一份替换,与"本轮是否仍超阈值"无关。
//   否则占用在阈值附近抖动时同一个 part 会一会儿全量一会儿截断,前缀缓存整体失效,
//   且压缩/编辑让窗口变化后还会反复横跳。latch 只存 key 不存文本——替换由原文 + 常量
//   确定性重算,内存与原文体积无关。用户钉住该消息时 key 被摘除(明示意图优先于稳定性)。

import type { Message, MessagePart, ToolOutputEntry, ToolPart } from "../foundation/types";
import { estimateTokens, isRecord, textFromParts } from "../foundation/utils";
import { contextTokensOf, hasPendingOutput, toolOutputText } from "./context-budget";
import { isPinnedMessage } from "./engine-compaction";

/** 触发线:占用 ≥ 有效窗口的 95% 才动手(留 5% 给估算误差,不提前误伤)。 */
export const EMERGENCY_TRIGGER_RATIO = 0.95;
/** 释放线:一旦触发就截到 90%,多让出 5% —— 与预算窗口同一滞回思路,避免每轮都截一刀。 */
export const EMERGENCY_TARGET_RATIO = 0.9;
/** 只截 ≥ 此 token 的工具输出:小结果截了省不下什么,还丢掉模型正在用的事实。 */
export const EMERGENCY_MIN_PART_TOKENS = 1000;
/** 最近 N 条消息一律不动(本轮工具链的现场)。 */
export const EMERGENCY_PROTECT_RECENT = 3;
/** 头/尾各保留的字符数。 */
export const EMERGENCY_KEEP_CHARS = 2000;
/** latch 上限:超出按插入序淘汰最旧的 key(淘汰只会让该 part 恢复全量,由发送前硬闸兜底)。 */
const LATCH_LIMIT = 4096;

const truncatedLatch = new Set<string>();

/** 测试隔离/诊断用:清空 latch。生产路径不调用——清空即意味着下一轮前缀抖动。 */
export function resetEmergencyTruncateLatch(): void {
  truncatedLatch.clear();
}

/** latch 键:消息 id + 工具调用 id。两者都是 UUID/上游 id,跨会话不会撞。 */
function latchKey(messageId: string, part: ToolPart): string {
  return `${messageId}::${String(part.toolCallId ?? "")}`;
}

function isSummaryLine(msg: Message): boolean {
  return textFromParts(msg.parts).trimStart().startsWith("<context_summary>");
}

/** 截断替换文本:头 + 标记 + 尾。标记里的 token 数是**原文**的估算,让模型知道丢了多少。 */
function truncatedText(text: string, originalTokens: number, keepChars: number): string {
  const head = text.slice(0, keepChars);
  const tail = text.slice(text.length - keepChars);
  return `${head}\n\n[truncated for context space — original ~${originalTokens} tokens]\n\n${tail}`;
}

/** 折叠单个 tool part 的文本条目:error/图片等非文本条目逐字保留,文本换成一条截断占位。
 *  与 context-budget.ageToolPart 同一形状(占位追加在 output 末尾),两条护栏不会打架。 */
function truncateToolPart(part: ToolPart, replacement: string): ToolPart {
  const output: ToolOutputEntry[] = [];
  for (const entry of part.output) {
    if (isRecord(entry) && entry.type === "text") continue;
    output.push(entry as ToolOutputEntry);
  }
  output.push({ type: "text", text: replacement });
  return { ...part, output };
}

export interface EmergencyTruncateOptions {
  /** 有效窗口(模型窗口 − 本轮预留)。≤0/缺省 = 不参与,行为与引入前逐字节一致。 */
  windowTokens: number;
  /** 覆盖触发比例(测试/诊断用;生产不传)。 */
  triggerRatio?: number;
  /** 覆盖头尾保留字符数(测试/诊断用;生产不传)。 */
  keepChars?: number;
}

export interface EmergencyTruncateResult {
  messages: Message[];
  /** 产物里带截断占位的 tool part 数(含 latch 重放;0 = 原样返回)。 */
  truncatedParts: number;
  /** 本轮新截断的 part 数(0 = 只重放了旧截断,或根本没触发)。 */
  newlyTruncatedParts: number;
  /** 相对原文省下的估算 token。 */
  savedTokens: number;
}

interface Candidate {
  messageIndex: number;
  partIndex: number;
  key: string;
  tokens: number;
  text: string;
  /** 只挡住"新截断";latch 重放不受此限(它被截时本来就在窗口外)。 */
  recentProtected: boolean;
}

/**
 * 应急截断:占用 ≥95% 有效窗口时,按 token 从大到小截断旧工具输出,直到回落到 90%。
 * 纯函数(除 latch 外无副作用),不改入参对象;未触发且无 latch 命中时原样返回同一数组。
 */
export function emergencyTruncateToolOutputs(
  messages: Message[],
  options: EmergencyTruncateOptions,
): EmergencyTruncateResult {
  const unchanged: EmergencyTruncateResult = {
    messages,
    truncatedParts: 0,
    newlyTruncatedParts: 0,
    savedTokens: 0,
  };
  const windowTokens = options.windowTokens;
  if (!(windowTokens > 0) || messages.length === 0) return unchanged;
  const keepChars = Math.max(1, Math.floor(options.keepChars ?? EMERGENCY_KEEP_CHARS));
  const triggerRatio = options.triggerRatio ?? EMERGENCY_TRIGGER_RATIO;
  const trigger = Math.floor(windowTokens * triggerRatio);
  const target = Math.floor(windowTokens * EMERGENCY_TARGET_RATIO);
  const protectFrom = Math.max(0, messages.length - EMERGENCY_PROTECT_RECENT);

  // 1. 收集候选并顺手摘掉被钉住/摘要行的 latch key(用户明示要逐字保留 → 恢复原文)。
  const candidates: Candidate[] = [];
  const seenKeys = new Set<string>();
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const msg = messages[messageIndex]!;
    // 没有工具 part 的消息直接跳过:isSummaryLine 要 join 全文,长会话里每条都 join
    // 一遍是白花的钱(本护栏每轮都跑,不像预算路只在开关打开时跑)。
    if (!msg.parts.some((part) => part.type === "tool")) continue;
    if (isPinnedMessage(msg) || isSummaryLine(msg)) {
      for (const part of msg.parts) {
        if (part.type === "tool") truncatedLatch.delete(latchKey(msg.id, part as ToolPart));
      }
      continue;
    }
    for (let partIndex = 0; partIndex < msg.parts.length; partIndex += 1) {
      const part = msg.parts[partIndex]!;
      if (!isRecord(part) || part.type !== "tool") continue;
      const tool = part as ToolPart;
      if (!Array.isArray(tool.output) || tool.output.length === 0) continue;
      if (hasPendingOutput(tool)) continue; // 审批/提问尚未来 result,不能伪造
      const text = toolOutputText(tool);
      if (!text) continue; // 只有 error / 图片:事实逐字保留
      const key = latchKey(msg.id, tool);
      // 同一条消息里 toolCallId 重复/缺失时只认第一个:键必须唯一,否则重放会串位。
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      candidates.push({
        messageIndex,
        partIndex,
        key,
        tokens: estimateTokens(text),
        text,
        recentProtected: messageIndex >= protectFrom,
      });
    }
  }
  if (candidates.length === 0) return unchanged;

  // 2. 先重放 latch(与本轮是否超阈值无关),再按需要新增截断。
  const replacements = new Map<string, { text: string; saved: number }>();
  let savedTokens = 0;
  let truncatedParts = 0;
  const applyCandidate = (candidate: Candidate, replacement: string) => {
    const after = estimateTokens(replacement);
    // 严格更短是硬不变量:不满足就不截(否则"截断"反而把上下文推得更大)。
    if (replacement.length >= candidate.text.length || after >= candidate.tokens) return false;
    replacements.set(candidate.key, { text: replacement, saved: candidate.tokens - after });
    savedTokens += candidate.tokens - after;
    truncatedParts += 1;
    return true;
  };

  let total = messages.reduce((sum, msg) => sum + contextTokensOf(msg, { reasoning: true }), 0);
  for (const candidate of candidates) {
    if (!truncatedLatch.has(candidate.key)) continue;
    const replacement = truncatedText(candidate.text, candidate.tokens, keepChars);
    if (applyCandidate(candidate, replacement)) total -= replacements.get(candidate.key)!.saved;
    else truncatedLatch.delete(candidate.key); // 原文变短了(编辑过):旧截断不再成立
  }

  // 3. 仍超触发线 → 从最大的未截断候选开始,截到释放线为止。
  let newlyTruncatedParts = 0;
  if (total >= trigger) {
    const fresh = candidates
      .filter((candidate) => !candidate.recentProtected && !replacements.has(candidate.key) && candidate.tokens >= EMERGENCY_MIN_PART_TOKENS)
      .sort((a, b) => b.tokens - a.tokens);
    for (const candidate of fresh) {
      if (total <= target) break;
      const replacement = truncatedText(candidate.text, candidate.tokens, keepChars);
      if (!applyCandidate(candidate, replacement)) continue;
      total -= replacements.get(candidate.key)!.saved;
      truncatedLatch.add(candidate.key);
      newlyTruncatedParts += 1;
      if (truncatedLatch.size > LATCH_LIMIT) {
        const oldest = truncatedLatch.values().next().value;
        if (oldest !== undefined) truncatedLatch.delete(oldest);
      }
    }
  }

  if (replacements.size === 0) return unchanged;

  // 4. 按 (messageIndex, partIndex) 重建产物;入参对象零改动。
  const byMessage = new Map<number, Map<number, string>>();
  for (const candidate of candidates) {
    const hit = replacements.get(candidate.key);
    if (!hit) continue;
    let parts = byMessage.get(candidate.messageIndex);
    if (!parts) {
      parts = new Map();
      byMessage.set(candidate.messageIndex, parts);
    }
    parts.set(candidate.partIndex, hit.text);
  }
  const result = messages.map((msg, messageIndex) => {
    const parts = byMessage.get(messageIndex);
    if (!parts) return msg;
    const nextParts: MessagePart[] = msg.parts.map((part, partIndex) => {
      const replacement = parts.get(partIndex);
      return replacement === undefined ? part : truncateToolPart(part as ToolPart, replacement);
    });
    return { ...msg, parts: nextParts };
  });
  return { messages: result, truncatedParts, newlyTruncatedParts, savedTokens };
}