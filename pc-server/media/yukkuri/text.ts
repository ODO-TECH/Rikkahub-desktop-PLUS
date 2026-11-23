// media/yukkuri/text.ts — 进引擎之前的文本改写(数字读法 + 中文转假名)
// 移植自 reference/dsh-yukkuli 的 text/numbers.js + text/zh2jp.js。
//
// 为什么这两步非做不可:
// 1) AqKanji2Koe 遇到阿拉伯数字会输出 <NUMK VAL="8080"> 这样的标签,AQTK10 按**日语**规则读
//    —— 中文回复里的 8080 会被念成「はっせんはちじゅう」。所以中文文本进合成之前,
//    先把数字换成本来该有的中文读法。
// 2) 中文句子没有假名,AQTK10 念不了 CJK 汉字(它只认日文汉字表)。所以纯汉字文本先转拼音、
//    再按拼音音节映射成日式假名 —— 本质是「用日语的音去读中文」,油库里中文语音的通行做法。

import { pinyinToKana } from "./pinyin-kana";

/** 汉字(中日共用这一段码位) */
const HAN = /[一-龥]/;
/** 平假名 + 片假名 */
const KANA = /[぀-ゟ゠-ヿ]/;
/** CJK 标点 + 全角形式(转写时要当分隔符处理,不能并进拼音音节) */
const PUNCT = /[　-〿＀-￯]/;

const DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const UNITS = ["", "十", "百", "千"];
const BIG_UNITS = ["", "万", "亿"];

/** 逐位读:2026 → 二零二六 */
export function digitByDigit(s: string): string {
  return [...s].map((ch) => DIGITS[Number(ch)] ?? ch).join("");
}

/** 四位数以内按中文自然读法 */
function naturalBelow10000(s: string): string {
  const n = Number(s);
  if (n === 0) return "零";

  const digits = s.padStart(4, "0").split("").map(Number);
  let out = "";
  let zeroPending = false;

  for (let i = 0; i < 4; i++) {
    const d = digits[i]!;
    const unit = UNITS[3 - i]!;
    if (d === 0) {
      zeroPending = out.length > 0;
      continue;
    }
    if (zeroPending) {
      out += "零";
      zeroPending = false;
    }
    out += DIGITS[d]! + unit;
  }

  // 「一十三」→「十三」:中文里十位是 1 时不读「一」
  if (out.startsWith("一十")) out = out.slice(1);
  return out;
}

/** 按万/亿分组读 */
export function naturalInteger(s: string): string {
  const clean = s.replace(/^0+/, "");
  if (!clean) return "零";
  if (clean.length <= 4) return naturalBelow10000(clean);

  // 从右往左每四位一组
  const groups: string[] = [];
  let rest = clean;
  while (rest.length > 0) {
    groups.unshift(rest.slice(-4));
    rest = rest.slice(0, -4);
  }

  let out = "";
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const n = Number(g);
    const big = BIG_UNITS[groups.length - 1 - i] ?? "";
    if (n === 0) {
      // 整组为零:只在后面还有非零组时补一个零
      const hasNonZeroAfter = groups.slice(i + 1).some((x) => Number(x) !== 0);
      if (out && hasNonZeroAfter && !out.endsWith("零")) out += "零";
      continue;
    }
    // 组内不足四位且前面有内容时补零(例如 10005 → 一万零五)
    if (out && g.length < 4 && g[0] === "0" && !out.endsWith("零")) out += "零";
    out += naturalBelow10000(g) + big;
  }

  return out;
}

/**
 * 替换文本里的数字为中文读法。
 *
 * 读法按中文习惯,不是逐位死读:
 * - 整体读:123 → 一百二十三
 * - 逐位读:年份(2026年)、前导零(007)、5 位以上非整数末尾的(10086、8080 这类端口/ID)
 * - 小数:逐位 + 每个点都念出来(1.3.3 → 一点三点三,不是 一点三三)
 * - 百分号:50% → 百分之五十
 */
export function toChineseNumerals(text: string): string {
  if (!text) return text ?? "";

  // 小数允许 1.3.3 这种多段(版本号),所以是 (?:\.\d+)+ 而不是单段
  return text.replace(
    /(-?)(\d+)((?:\.\d+)+)?(%?)/g,
    (match, neg: string, intPart: string, decPart: string | undefined, pct: string, offset: number, whole: string) => {
      if (decPart) {
        const head = digitByDigit(intPart);
        const decText = digitByDigit(decPart.slice(1).replace(/\./g, "点"));
        return `${neg ? "负" : ""}${head}点${decText}${pct ?? ""}`;
      }

      // 看后面紧跟着的字(跳过空格)判断语境
      const tail = whole.slice(offset + match.length).replace(/^\s+/, "");
      const isYear = tail.slice(0, 1) === "年";

      // 语境:端口号、编号、密码这类要一位一位念
      const before = whole.slice(Math.max(0, offset - 8), offset);
      const looksLikeCode = /端口|编号|代号|密码|验证码|账号|工号|学号|电话|手机号|[Ii][Dd]$/.test(before);

      const hasLeadingZero = intPart.length > 1 && intPart[0] === "0";
      // 5 位以上:整数末尾有多个零的(10000、12000)按自然读,其余多半是端口/ID,逐位读更像话
      const isRound = /0{3,}$/.test(intPart);
      const tooLong = intPart.length >= 5 && !isRound;

      const body =
        isYear || hasLeadingZero || tooLong || (looksLikeCode && intPart.length >= 3)
          ? digitByDigit(intPart)
          : naturalInteger(intPart);

      if (pct) return `百分之${body}`;
      return `${neg ? "负" : ""}${body}`;
    },
  );
}

/**
 * 这段文本要不要走中文拼音路线?
 *
 * 判据是「有没有假名」而不是「有没有汉字」:日文汉字(虐待、天気)不该被当成中文拼音读。
 * 含假名 = 日文,直通 AqKanji2Koe;纯汉字 = 中文,先转假名。
 */
export function hasChinese(text: string): boolean {
  if (!HAN.test(text)) return false;
  return !KANA.test(text);
}

type PinyinFn = (value: string, options: { toneType: "none"; type: "array" }) => string[];

let pinyinFn: PinyinFn | null = null;

/** pinyin-pro 带着百万级词库,只在真的遇到中文时才 import。 */
async function loadPinyin(): Promise<PinyinFn> {
  if (pinyinFn) return pinyinFn;
  try {
    const mod = await import("pinyin-pro");
    pinyinFn = mod.pinyin as unknown as PinyinFn;
    return pinyinFn;
  } catch (err) {
    // 依赖缺失(定制构建剔了 node_modules 之类)要说人话,而不是让调用方看见一串模块名。
    throw new Error(`中文转拼音需要 pinyin-pro,当前加载失败:${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 中文 → 日语假名。逐字取音(不带词组上下文,多音字按 pinyin-pro 的单字默认读音),
 * 标点两侧留空格保证音节 token 化,最后交给对照表。
 */
export async function zh2jp(text: string): Promise<string> {
  if (!text) return "";
  const pinyin = await loadPinyin();

  const parts: string[] = [];
  for (const ch of [...text]) {
    if (HAN.test(ch)) {
      parts.push(`${pinyin(ch, { toneType: "none", type: "array" })[0] ?? ch} `);
    } else if (PUNCT.test(ch)) {
      parts.push(` ${ch} `);
    } else {
      parts.push(ch);
    }
  }

  return pinyinToKana(parts.join("")).replace(/\s+/g, " ").trim();
}

/**
 * 合成前的最后一道文本处理:中文走「数字转中文读法 → 拼音假名」,日文/纯假名原样返回。
 *
 * 日文保持原样是因为日语读数字本来就读对了(<NUMK> 标签按日语念正是想要的)。
 */
export async function prepareText(text: string): Promise<string> {
  if (!hasChinese(text)) return text;
  return zh2jp(toChineseNumerals(text));
}
