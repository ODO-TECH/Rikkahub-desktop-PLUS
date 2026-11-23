// media/yukkuri/text.test.ts — 数字读法与中文转假名(进引擎前的两步改写)
// 锁的是移植口径:reference/dsh-yukkuli 的 numbers.js / zh2jp.js 行为一致,
// 且「日文不被当中文读」这条判据不能被后来的重构悄悄改掉。

import { expect, test } from "bun:test";
import { digitByDigit, hasChinese, naturalInteger, prepareText, toChineseNumerals, zh2jp } from "./text";
import { pinyinToKana, PINYIN_SYLLABLE_COUNT } from "./pinyin-kana";

test("中文数字按中文习惯读,不是逐位死读", () => {
  expect(toChineseNumerals("123")).toBe("一百二十三");
  expect(toChineseNumerals("10000")).toBe("一万");
  expect(toChineseNumerals("50%")).toBe("百分之五十");
  expect(toChineseNumerals("-3")).toBe("负三");
  // 与上游逐字一致:整组补零那条只在组内不足四位时触发,所以是「一万五」而不是「一万零五」
  expect(naturalInteger("10005")).toBe("一万五");
  expect(naturalInteger("1005")).toBe("一千零五");
});

test("5 位以上非整千整万的数字按「多半是端口/ID」逐位读(上游实测口径)", () => {
  expect(toChineseNumerals("10005")).toBe("一零零零五");
  expect(toChineseNumerals("10086")).toBe("一零零八六");
});

test("年份 / 前导零逐位读,编号语境也逐位", () => {
  expect(toChineseNumerals("2026年")).toBe("二零二六年");
  expect(toChineseNumerals("007")).toBe("零零七");
  expect(toChineseNumerals("端口 8080")).toBe("端口 八零八零");
});

test("版本号这类多段小数逐位带点读", () => {
  expect(toChineseNumerals("1.3.3")).toBe("一点三点三");
  expect(toChineseNumerals("0.1.6")).toBe("零点一点六");
});

test("naturalInteger 与 digitByDigit 单独可测(供上层复用时不回归)", () => {
  expect(digitByDigit("2026")).toBe("二零二六");
  expect(naturalInteger("1234")).toBe("一千二百三十四");
  expect(naturalInteger("0")).toBe("零");
});

test("有假名就是日文,不走拼音路线", () => {
  expect(hasChinese("你好，世界")).toBe(true);
  expect(hasChinese("こんにちは、世界")).toBe(false);
  // 日文汉字(虐待/天気)里没有假名时会走拼音 —— 上游同口径,含假名的正常日文句子不会命中
  expect(hasChinese("今日は良い天気ですね。")).toBe(false);
  expect(hasChinese("hello world")).toBe(false);
});

test("拼音对照表 408 条音节,查不到的原样留着", () => {
  expect(PINYIN_SYLLABLE_COUNT).toBe(408);
  expect(pinyinToKana("ni hao")).toBe("ニーハオ");
  expect(pinyinToKana("，")).toBe("、");
  expect(pinyinToKana("unknown_syllable")).toBe("unknown_syllable");
});

test("中文整句转假名后不再有汉字,且带原有标点", async () => {
  const kana = await zh2jp("你好，世界");
  expect(kana).toStartWith("ニーハオ");
  expect(/[一-龥]/.test(kana)).toBe(false);
  expect(kana).toContain("、");
});

test("prepareText:日文原样返回,中文先换数字读法再转假名", async () => {
  expect(await prepareText("こんにちは、世界。")).toBe("こんにちは、世界。");
  const chinese = await prepareText("版本 1.3.3 发布了。");
  // 关键不是念法好不好听,而是:不留汉字、不留下会被 AQTK10 按日语念的 <NUMK> 标签
  expect(/[一-龥]/.test(chinese)).toBe(false);
  expect(chinese).not.toContain("<NUMK");
  expect(chinese).toContain("ディエン");
});
