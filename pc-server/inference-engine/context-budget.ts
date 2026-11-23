// inference-engine/context-budget.ts — 上下文预算窗口与工具输出老化(两引擎共享的纯函数层)
//
// 目的:长会话的体积不住在"消息条数"上,而住在工具输出与历史 reasoning 里。按条数切片
// (assistant.contextMessageLimit)在工具型会话上几乎无效,本模块补上按 token 的护栏:
//
//   budgetStartFor  从尾向前累加到预算为止,给出窗口起点;超预算时回撤到 90% 预算,
//                   给后续追加留 10% 余量——避免每轮都挪起点导致前缀缓存整体失效。
//   ageToolOutputs  把"距今超过 K 个工具往返"的结果折叠成占位;占位仍写在 output 数组里,
//                   toolPartExecuted 判定不变(工具配对不变量由 alignContextStart 兜底)。
//
// 纪律:
//   - 不读 state.settings、不写库。原文改动为零,关闭开关立即回到逐字节旧行为。
//     唯一 I/O 例外:媒体计费只读**已有缓存**——图片读头部字节取尺寸(image-tokens),
//     文档读旁车抽取全文(document-tokens),两者都有 memoize、永不抛错、绝不触发抽取。
//     尺寸与正文在存储态都不存在,不读就只能计 0(比读几个字节/一份缓存危险得多)。
//   - 不老化 error 输出(pending/error 是用户与模型都要看的事实),不老化被钉住的消息。
//   - reasoning 不在此处老化:Anthropic 工具链要求 thinking 块随 tool_use 回传,折叠会 400。
//   - 本模块的两条护栏都由调用方按开关传入(默认关)。常开的防 400 护栏在
//     emergency-truncate.ts:老化是用户可选的体积管理,应急截断是不受开关门控的兜底。
//   - token 估算是近似值(CJK 1/字 + 其他 /4 + 图片 tile),误差由预留 token 吸收;
//     真实防线是发送前硬闸。

import type { ImagePart, Message, MessagePart, ToolOutputEntry, ToolPart } from "../foundation/types";
import { estimateTokens, isRecord, textFromParts } from "../foundation/utils";
import { documentTokensForPart } from "./document-tokens";
import { isPinnedMessage } from "./engine-compaction";
import { imageTokensForUrl } from "./image-tokens";

/** 窗口回撤比例:超预算时一次多切 10%,给后续追加留头(滞回,防前缀抖动)。 */
export const BUDGET_HYSTERESIS_RATIO = 0.1;

export interface ContextTokenOptions {
  /** 历史 reasoning 是否计入。预算裁决恒按 true 计(宁可高估),UI 口径按自身语义传 false。 */
  reasoning?: boolean;
}

/** 工具 parts 的输入 + 输出文本体积(与 conversations/helpers.toolPartsTextVolume 同口径)。 */
function toolPartsText(parts: MessagePart[]): string {
  let volume = "";
  for (const part of parts) {
    if (!isRecord(part) || part.type !== "tool") continue;
    volume += String((part as ToolPart).input ?? "");
    const output = (part as ToolPart).output;
    if (!Array.isArray(output)) continue;
    for (const entry of output) {
      if (!isRecord(entry)) continue;
      const errorText = (entry as { error?: unknown }).error;
      if (entry.type === "text") volume += String(entry.text ?? "");
      else if (typeof errorText === "string") volume += errorText;
    }
  }
  return volume;
}

/** 非 text part 在请求构建期展开成的体积:图片按 tile 计费,文档按旁车抽取全文计费,
 *  OCR 旁注按文本计。原先这三样都计 0——图片/文档/OCR 文本要到
 *  message-builder.contentPartsForApi 才展开,存储态只有一个 url,计费层看不见,
 *  于是贴图/贴文档的会话自动压缩永不触发。
 *  工具输出里的图片与文档同样计入(ToolOutputEntry 也是 MessagePart)。
 *  注意:不支持 IMAGE 输入的模型会把图片换成 OCR 文本,此时这里会同时计两份而偏高;
 *  偏高只是提前压缩,偏低是请求被拒,取安全方向。 */
function mediaTokensOf(parts: MessagePart[]): number {
  let total = 0;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type === "image") {
      total += imageTokensForUrl(String((part as ImagePart).url ?? ""));
    } else if (part.type === "document") {
      total += documentTokensForPart(part as Record<string, unknown>);
    } else if (part.type === "tool") {
      const output = (part as ToolPart).output;
      if (Array.isArray(output)) total += mediaTokensOf(output as MessagePart[]);
    }
    const metadata = (part as { metadata?: unknown }).metadata;
    if (isRecord(metadata)) {
      const ocrText = String(metadata.ocrText ?? "");
      if (ocrText) total += estimateTokens(ocrText);
    }
  }
  return total;
}

/** 单条消息在模型视野里的近似 token:正文 + 工具输入/输出 + 图片/OCR(+ 可选 reasoning)。 */
export function contextTokensOf(msg: Message, options: ContextTokenOptions = {}): number {
  const text = textFromParts(msg.parts);
  const toolText = toolPartsText(msg.parts);
  let total = (text ? estimateTokens(text) : 0) + (toolText ? estimateTokens(toolText) : 0) + mediaTokensOf(msg.parts);
  if (options.reasoning) {
    for (const part of msg.parts) {
      if (!isRecord(part) || part.type !== "reasoning") continue;
      const reasoning = String((part as { reasoning?: unknown }).reasoning ?? "");
      if (reasoning) total += estimateTokens(reasoning);
    }
  }
  return total;
}

/** 会话全量(选中路径)的近似 token,供导入体检与预算共用。 */
export function conversationTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) total += contextTokensOf(msg, { reasoning: true });
  return total;
}

/**
 * 预算窗口起点。返回 0 = 全量都在预算内(或预算无效);返回 n = 保留 messages[n..]。
 * 与条数滞回同一思路:先按 90% 预算算出超额,再把"丢弃量"量化到 10% 预算的整步长——
 * 追加消息只要没多出一个步长,起点不变(前缀缓存友好);一次跨步才前移约一个步长。
 * 保留量上限 = 90% + 10% = 100% 预算,不会越过硬线。
 * 至少保留最后一条消息:单条就超预算时窗口无法再小,交给发送前硬闸报可操作错误。
 */
export function budgetStartFor(messages: Message[], budgetTokens: number): number {
  if (!(budgetTokens > 0) || messages.length === 0) return 0;
  const tokens = messages.map((msg) => contextTokensOf(msg, { reasoning: true }));
  const total = tokens.reduce((sum, value) => sum + value, 0);
  const target = budgetTokens * (1 - BUDGET_HYSTERESIS_RATIO);
  if (total <= target) return 0;
  const excess = total - target;
  const stride = Math.max(1, Math.ceil(target * BUDGET_HYSTERESIS_RATIO));
  const quantized = Math.floor(excess / stride) * stride;
  let dropped = 0;
  let start = 0;
  while (start < messages.length - 1 && dropped < quantized) {
    dropped += tokens[start]!;
    start += 1;
  }
  return start;
}

export interface ToolAgingOptions {
  /** 保留最近多少个「含已执行工具」的消息轮次不老化。 */
  keepTurns: number;
  /** 占位保留的输出前缀字符数;0 = 纯占位。 */
  excerptChars: number;
}

export interface ToolAgingResult {
  messages: Message[];
  /** 被折叠的 tool part 数(0 = 原样返回,调用方可据此跳过徽标)。 */
  agedParts: number;
  /** 折叠掉的文本字节数(UTF-8)。 */
  agedBytes: number;
}

function hasExecutedTool(msg: Message): boolean {
  return msg.parts.some((part) => part.type === "tool" && Array.isArray((part as ToolPart).output) && (part as ToolPart).output.length > 0);
}

/** 工具输出里的纯文本(按条目顺序拼接)。应急截断(emergency-truncate)共用同一口径,
 *  两处不允许各写一份——否则"多大算大"在两条护栏里会得出不同的数。 */
export function toolOutputText(part: ToolPart): string {
  let text = "";
  for (const entry of part.output) {
    if (!isRecord(entry)) continue;
    if (entry.type === "text") text += String(entry.text ?? "");
  }
  return text;
}

/** 含未完成条目(审批/提问):result 尚未来,任何护栏都不能伪造或改写它。 */
export function hasPendingOutput(part: ToolPart): boolean {
  return part.output.some((entry) => isRecord(entry) && (entry as { pending?: unknown }).pending === true);
}

/** 折叠单个 tool part 的输出文本:保留 error 条目逐字,文本条目换成一枚占位。 */
function ageToolPart(part: ToolPart, excerptChars: number): { part: ToolPart; bytes: number } | null {
  if (!Array.isArray(part.output) || part.output.length === 0) return null;
  if (hasPendingOutput(part)) return null; // 未完成的审批/提问:result 尚未来,不能伪造
  const textEntries = part.output.filter((entry) => isRecord(entry) && entry.type === "text");
  if (textEntries.length === 0) return null; // 只有 error / 图片:保持原样
  const text = toolOutputText(part);
  const bytes = Buffer.byteLength(text, "utf8");
  const excerpt = excerptChars > 0 ? text.slice(0, excerptChars) : "";
  const header = `[tool output omitted: ${part.toolName || "tool"} · ${bytes} bytes · aged by context budget]`;
  const placeholder: ToolOutputEntry = { type: "text", text: excerpt ? `${header}\n${excerpt}${text.length > excerpt.length ? "…" : ""}` : header };
  const output: ToolOutputEntry[] = [];
  for (const entry of part.output) {
    if (isRecord(entry) && entry.type === "text") continue; // 文本换占位;error/图片原样保留
    output.push(entry as ToolOutputEntry);
  }
  output.push(placeholder);
  return { part: { ...part, output }, bytes };
}

/**
 * 工具输出老化:只作用于编码产物,原文不动。距最新 K 个工具往返以内的消息、
 * 被钉住的消息、含 pending/仅 error 输出的 part 一律保持原样。
 */
export function ageToolOutputs(messages: Message[], options: ToolAgingOptions): ToolAgingResult {
  const keepTurns = Math.max(0, Math.floor(options.keepTurns));
  const excerptChars = Math.max(0, Math.floor(options.excerptChars));
  const protectedIndexes = new Set<number>();
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!hasExecutedTool(messages[index]!)) continue;
    seen += 1;
    if (seen <= keepTurns) protectedIndexes.add(index);
  }
  let agedParts = 0;
  let agedBytes = 0;
  let changed = false;
  const result = messages.map((msg, index) => {
    if (protectedIndexes.has(index) || !hasExecutedTool(msg)) return msg;
    if (isPinnedMessage(msg)) return msg;
    let messageChanged = false;
    const parts = msg.parts.map((part) => {
      if (part.type !== "tool") return part;
      const aged = ageToolPart(part as ToolPart, excerptChars);
      if (!aged) return part;
      agedParts += 1;
      agedBytes += aged.bytes;
      messageChanged = true;
      return aged.part;
    });
    if (!messageChanged) return msg;
    changed = true;
    return { ...msg, parts };
  });
  return changed ? { messages: result, agedParts, agedBytes } : { messages, agedParts: 0, agedBytes: 0 };
}

/** 预算口径的可用上限:窗口减去压缩预留。供预算窗口/诊断使用。
 *  注意:发送前硬闸(S4 起)**不**用它——硬闸按原生窗口判定,预留只在请求参数层面
 *  由 reserveTokensFor/planOutputCap 执行。拿预留当硬线会误杀估算偏大的正常请求。 */
export function hardLimitFor(contextWindow: number, reserveTokens: number): number {
  return Math.max(1, contextWindow - reserveTokens);
}

/** 供 UI/诊断用的轻量格式化(不做单位换算以外的事)。 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(Math.max(0, Math.round(tokens)));
}
