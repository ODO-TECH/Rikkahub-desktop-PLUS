// media/yukkuri/segment.ts — 长文本切成引擎能稳定合成的片段
// 移植自 reference/dsh-yukkuli 的 text/segment.js,阈值来自那边的实测而非拍脑袋:
//   - 无标点连续 200 假名 → ERR 122(引擎内部缓冲溢出)
//   - 带标点分隔的 1000 假名 → OK
// 所以真正要控制的是「单个短语的长度」,不是整轮总长度。
//
// 与上游多出来的一条:中文要先经 zh2jp 转假名,长度会膨胀,分段预算必须按膨胀后的假名数算,
// 否则一段 90 个汉字的中文转完假名超过 200 音,直接撞 ERR 120/122。

import { hasChinese } from "./text";

export const DEFAULT_MAX_KANA = 100;
/**
 * 碎片合并阈值。中文句子天然很短:「第一句。」只有 3 音,「你好。」2 音。
 * 阈值定高了会把正常句子并成一段(上游实测 4 就会把三句话并成一句),
 * 1 的含义是:只有「一。」「嗯。」这类单音节碎片才考虑合并。
 */
export const DEFAULT_MIN_KANA = 1;

/** 中文 → 假名的实测膨胀倍数(拼音音节平均 2.3 音),留一点余量取 2.5。 */
const CHINESE_EXPANSION = 2.5;

/** 句末标点(强边界) */
const SENTENCE_END = /[。！？!?…]/;
/** 句中停顿(弱边界) */
const CLAUSE_BREAK = /[，、；：,;:]/;
const UNIT = /[぀-ヿ一-龥]/;

/**
 * 数一段文本里「要发音的字符」数量:假名 + 汉字各算 1。
 * 标点、空白、拉丁字母不算。
 */
export function countKana(text: string): number {
  if (!text) return 0;
  const matches = text.match(/[぀-ヿ一-龥]/g);
  return matches ? matches.length : 0;
}

/** 按句末标点切原子片段,边界标点留在段尾(语气停顿要念出来)。 */
function splitByPunctuation(text: string): string[] {
  const out: string[] = [];
  let buf = "";

  for (const ch of text) {
    buf += ch;
    if (SENTENCE_END.test(ch)) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf);

  return out;
}

/** 超长的一段先按逗号再切;逗号也切不开的(一长串没标点)按字符硬切。 */
function splitLong(piece: string, maxUnits: number): string[] {
  if (countKana(piece) <= maxUnits) return [piece];

  const parts: string[] = [];
  let buf = "";
  for (const ch of piece) {
    buf += ch;
    if (CLAUSE_BREAK.test(ch) && countKana(buf) >= maxUnits * 0.6) {
      parts.push(buf);
      buf = "";
    }
  }
  if (buf.trim()) parts.push(buf);

  const out: string[] = [];
  for (const p of parts) {
    if (countKana(p) <= maxUnits) {
      out.push(p);
      continue;
    }
    let chunk = "";
    let n = 0;
    for (const ch of p) {
      chunk += ch;
      if (UNIT.test(ch)) n += 1;
      if (n >= maxUnits) {
        out.push(chunk);
        chunk = "";
        n = 0;
      }
    }
    if (chunk.trim()) out.push(chunk);
  }
  return out;
}

/**
 * 把过短的相邻片段合并,避免出现「好。」「行。」这种单独成段的碎片。
 *
 * 两条约束缺一不可:
 *   1. 只合并「极短」的片段(< minKana),正常句子不参与
 *   2. 合并后仍然只是个小片段(上限 8)—— 否则宁可留成几段
 */
function mergeShort(pieces: string[], minKana: number, maxUnits: number): string[] {
  const out: string[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last === undefined) {
      out.push(p);
      continue;
    }

    const cur = countKana(p);
    const merged = countKana(last) + cur;
    const shouldMerge = cur < minKana && merged <= Math.min(maxUnits, 8);

    if (shouldMerge) out[out.length - 1] = last + p;
    else out.push(p);
  }
  return out;
}

/**
 * @param text 已经过 readable() 的文本
 * @param opts.maxKana 单段假名预算(默认 100)
 * @returns 片段数组(已去空、已合并过短片段)
 */
export function segment(text: string, opts: { maxKana?: number; minKana?: number } = {}): string[] {
  const maxKana = opts.maxKana ?? DEFAULT_MAX_KANA;
  const minKana = opts.minKana ?? DEFAULT_MIN_KANA;
  if (!text || !text.trim()) return [];

  // 纯汉字文本(会被 zh2jp 展开)按膨胀后的量收紧预算;
  // 含假名的日文交给 AqKanji2Koe,膨胀率低,沿用原始阈值(与上游实测一致)。
  const maxUnits = hasChinese(text) ? Math.ceil(maxKana / CHINESE_EXPANSION) : maxKana;

  const pieces: string[] = [];
  for (const sentence of splitByPunctuation(text)) {
    for (const piece of splitLong(sentence, maxUnits)) {
      if (piece.trim()) pieces.push(piece);
    }
  }

  return mergeShort(pieces, minKana, maxUnits)
    .map((s) => s.trim())
    .filter(Boolean);
}
