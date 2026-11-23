// media/yukkuri/readable.test.ts — 朗读前的文本清理与分段
// 这里锁两条最容易在重构里丢的东西:
// 1) 句末标点必须活着 —— 它是分段依据,被当成「装饰符号」删掉会把整轮朗读捏成一段,
//    引擎随即回 ERR 120/122(移植时实测踩过);
// 2) 中文段的预算要按「转假名会膨胀」收紧,不能按原始长度 100 算。

import { expect, test } from "bun:test";
import { extractReadableText } from "./readable";
import { countKana, segment, DEFAULT_MAX_KANA } from "./segment";

const MARKDOWN = "## 标题\n- 项目一\n- 项目二\n\n> 引用\n\n**加粗** 这一句结尾。";

test("代码块与表格不朗读,行内代码只脱反引号", () => {
  const text = extractReadableText("先看结论。\n\n```ts\nconst a = 1;\n```\n\n| 列 | 列 |\n| --- | --- |\n\n`npm i` 装好。");
  expect(text).not.toContain("const a");
  expect(text).not.toContain("| ---");
  expect(text).toContain("npm i");
  expect(text).toContain("先看结论。");
});

test("链接只留文字,裸 URL 与路径删掉", () => {
  const text = extractReadableText("参考 [萌娘百科](https://zh.moegirl.org.cn/x) 与 https://example.com 以及 D:\\Users\\x 下的文件。");
  expect(text).toContain("萌娘百科");
  expect(text).not.toContain("https");
  expect(text).not.toContain("D:\\");
});

test("Markdown 记号被去掉,粗体与标题不连带正文一起丢", () => {
  const text = extractReadableText(MARKDOWN);
  expect(text).not.toContain("##");
  expect(text).not.toContain("**");
  expect(text).not.toContain(">");
  expect(text).toContain("标题");
  expect(text).toContain("这一句结尾。");
});

test("emoji 与装饰符号删掉,句号不能跟着一起没了(回归)", () => {
  const text = extractReadableText("完成 ✅ → 100% 😀。");
  expect(text).not.toContain("✅");
  expect(text).not.toContain("→");
  expect(text).toContain("。");
});

test("没有可念内容时返回空串", () => {
  expect(extractReadableText("")).toBe("");
  expect(extractReadableText(null)).toBe("");
  expect(extractReadableText("```\n只有一整块代码\n```")).toBe("");
});

test("按句末标点切段,标点留在段尾", () => {
  expect(segment("第一句。第二句！第三句？")).toEqual(["第一句。", "第二句！", "第三句？"]);
});

test("中文段预算按假名膨胀收紧:每段不超过 maxKana / 2.5 个音节", () => {
  const units = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
  const pieces = segment([units, units, units].join("。"));
  expect(pieces.length).toBeGreaterThan(1);
  for (const piece of pieces) expect(countKana(piece)).toBeLessThanOrEqual(Math.ceil(DEFAULT_MAX_KANA / 2.5));
});

test("日文按原始 100 音预算切,长无标点串硬切不丢字", () => {
  const kana = "あ".repeat(250);
  const pieces = segment(kana);
  expect(pieces.length).toBeGreaterThanOrEqual(3);
  for (const piece of pieces) expect(countKana(piece)).toBeLessThanOrEqual(DEFAULT_MAX_KANA);
  expect(pieces.join("")).toBe(kana);
});

test("阈值 1 的含义:只有「零音节」碎片被并到前一段,正常短句各自成段", () => {
  // 上游把 minKana 定为 1,不是「1 音节以内都并掉」——实测三句正常中文不会被并成一段。
  expect(segment("嗯。好的。")).toEqual(["嗯。", "好的。"]);
  expect(segment("这是第一段话。这是第二段话。这是第三段话。")).toHaveLength(3);
  // 纯标点碎片(0 音节)才会被并进去
  expect(segment("好。！。行。")).toEqual(["好。！。", "行。"]);
});

test("空文本与纯空白不产出片段", () => {
  expect(segment("")).toEqual([]);
  expect(segment("   \n  ")).toEqual([]);
});
