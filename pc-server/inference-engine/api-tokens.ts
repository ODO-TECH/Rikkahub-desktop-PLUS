// inference-engine/api-tokens.ts — 出线请求体的本地 prompt 估算(S2 校准的"本地"一侧)
//
// 为什么按 ApiMessage[] 估而不是按内部 Message[]:校准样本要拿我们的估算去和上游回报的
// promptTokens 比,两边必须是**同一份东西**。ApiMessage[] 是三家方言转换前的最后一站,
// 系统提示词、注入、摘要、工具往返、OCR 展开、文档抽取文本都已经落定,估它最贴近真实。
//
// 图片必须走 tile 计费:出线 content 里的 image_url 常常是兆级 data URL,按字符数估会
// 把一张图算成几十万 token,校准环会被这种样本彻底带坏(准入区间也拦不住——它是稳定偏差)。

import type { ApiMessage } from "../foundation/types";
import { estimateTokens, isRecord } from "../foundation/utils";
import { imageTokensForUrl } from "./image-tokens";

function contentTokens(content: unknown): number {
  if (typeof content === "string") return content ? estimateTokens(content) : 0;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = String(part.type ?? "");
    if (type === "text" || type === "input_text") {
      const text = String(part.text ?? "");
      if (text) total += estimateTokens(text);
      continue;
    }
    if (type === "image_url" || type === "input_image") {
      const image = isRecord(part.image_url) ? part.image_url : null;
      const url = String(image?.url ?? part.image_url ?? part.url ?? "");
      total += imageTokensForUrl(url);
      continue;
    }
    // 其余形态(音频/文件/未知扩展):按 JSON 体积近似,宁可高估也不计 0。
    total += estimateTokens(JSON.stringify(part));
  }
  return total;
}

/** 出线消息序列的本地 prompt 估算。不含工具声明——那部分由 toolDeclarationTokens 单独给,
 *  两者相加才是完整的 prompt(与上游 promptTokens 同口径)。 */
export function apiMessagesTokens(items: readonly ApiMessage[]): number {
  let total = 0;
  for (const item of items) {
    if (!isRecord(item)) continue;
    total += contentTokens(item.content);
    const reasoning = item.reasoning_content;
    if (typeof reasoning === "string" && reasoning) total += estimateTokens(reasoning);
    // tool_calls / function_call 是结构化载荷,上游按序列化后的文本计费。
    if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
      total += estimateTokens(JSON.stringify(item.tool_calls));
    }
    if (item.function_call) total += estimateTokens(JSON.stringify(item.function_call));
  }
  return total;
}