// files/extraction-ocr-escalation.test.ts — 「扫描件才走 OCR」的判据锁(用户追加口径:
// 纯文本的直接发模型就能读,不需要 OCR;OCR 只在本地解析读不出来时升级,且是付费接口)。
// 这里只测决策函数本身(纯函数、零出网、零落盘),升级队列与子进程编排在 extraction.ts
// 父侧,真实跑起来要孵化子进程 + 打计费接口,不在单测里碰。
import { describe, expect, test } from "bun:test";

// 纪律:这里不桩 api/logs 与 model-providers——实测 bun 1.4.2 的 mock.module 是进程级注册表、
// 会泄漏到后续测试文件(把别人的 addLog 变成空函数,合跑时假失败)。真实模块能正常导入,
// 而本文件只调纯判据函数,根本不产生日志。
const { setState } = await import("../persistence/json-store");
const { DEEPSEEK_OCR_SPARSE_CHARS_PER_PAGE, deepSeekOcrEscalationFor } = await import("./extraction");

function configured(on = true, apiKey = "sk-test") {
  setState({ settings: { deepseekOcrEnabled: on, deepseekOcrApiKey: apiKey } } as any);
}

/** 造一段"N 页 × 每页 charsPerPage 个非空白字符"的假全文。 */
function textFor(pages: number, charsPerPage: number) {
  return Array.from({ length: pages }, () => "字".repeat(charsPerPage)).join("\n\n");
}

describe("deepSeekOcrEscalationFor 的三档判定", () => {
  test("开关关:哪怕全文为空也不升级(默认关 = 行为与引入前一致,一次都不花)", () => {
    configured(false);
    expect(deepSeekOcrEscalationFor({ fileName: "scan.pdf", mime: "application/pdf" }, "", 10)).toBeNull();
  });

  test("开关开但 Key 没填:同样不升级", () => {
    configured(true, "   ");
    expect(deepSeekOcrEscalationFor({ fileName: "scan.pdf", mime: "application/pdf" }, "", 10)).toBeNull();
  });

  test("本地读出一个字都没有 → empty 档", () => {
    configured();
    expect(deepSeekOcrEscalationFor({ fileName: "scan.pdf", mime: "application/pdf" }, "", 12)).toBe("empty");
    // 只有空白字符也算空(扫描件常见的整页空白)。
    expect(deepSeekOcrEscalationFor({ fileName: "scan.pdf", mime: "application/pdf" }, "  \n\t  \n", 12)).toBe("empty");
  });

  test("带水印/页码的扫描件:非空白字符密度低于阈值 → sparse 档", () => {
    configured();
    // 100 页、每页只剩水印与页码十几个字。
    expect(deepSeekOcrEscalationFor({ fileName: "scan.pdf", mime: "application/pdf" }, textFor(100, 12), 100)).toBe("sparse");
  });

  test("正常排版的中文 PDF:每页数百字 → 不升级(这就是「纯文本直接发模型」那一档)", () => {
    configured();
    expect(deepSeekOcrEscalationFor({ fileName: "book.pdf", mime: "application/pdf" }, textFor(100, 600), 100)).toBeNull();
    // 阈值边界:每页字数恰好等于阈值(非空白总数 = 阈值 × 页数)不升级,少一个字才升级。
    expect(deepSeekOcrEscalationFor({ fileName: "edge.pdf", mime: "application/pdf" }, textFor(10, DEEPSEEK_OCR_SPARSE_CHARS_PER_PAGE), 10)).toBeNull();
    expect(deepSeekOcrEscalationFor({ fileName: "edge.pdf", mime: "application/pdf" }, textFor(10, DEEPSEEK_OCR_SPARSE_CHARS_PER_PAGE - 1), 10)).toBe("sparse");
  });

  test("页数未知:不做稀疏判定,只认全空(避免把「不知道多少页」误判成扫描件)", () => {
    configured();
    expect(deepSeekOcrEscalationFor({ fileName: "unknown.pdf", mime: "application/pdf" }, textFor(50, 3), null)).toBeNull();
    expect(deepSeekOcrEscalationFor({ fileName: "unknown.pdf", mime: "application/pdf" }, "", null)).toBe("empty");
    expect(deepSeekOcrEscalationFor({ fileName: "unknown.pdf", mime: "application/pdf" }, textFor(50, 3), 0)).toBeNull();
  });

  test("官方格式表之外(EPUB/纯文本/图片)永不升级——即使本地一个字都没读到", () => {
    configured();
    for (const entry of [
      { fileName: "book.epub", mime: "application/epub+zip" },
      { fileName: "notes.md", mime: "text/markdown" },
      { fileName: "notes.txt", mime: "text/plain" },
      { fileName: "photo.png", mime: "image/png" },
      { fileName: "archive.zip", mime: "application/zip" },
    ]) {
      expect(deepSeekOcrEscalationFor(entry, "", 20)).toBeNull();
    }
  });

  test("官方吃但本地不解析的老格式(DOC/PPT):空文本即升级——它们是净收益档", () => {
    configured();
    expect(deepSeekOcrEscalationFor({ fileName: "lecture.doc", mime: "application/msword" }, "", null)).toBe("empty");
    expect(deepSeekOcrEscalationFor({ fileName: "lecture.ppt", mime: "" }, "", null)).toBe("empty");
    // DOCX/PPTX 本地能解:只有真读不出来才走到这里,判据与 PDF 同档。
    expect(deepSeekOcrEscalationFor({ fileName: "a.docx", mime: "" }, textFor(30, 500), 30)).toBeNull();
    expect(deepSeekOcrEscalationFor({ fileName: "a.pptx", mime: "" }, "", 30)).toBe("empty");
  });

  test("文件名与 mime 任一侧命中官方格式即可(mime 缺失时靠扩展名)", () => {
    configured();
    expect(deepSeekOcrEscalationFor({ fileName: "无扩展名", mime: "application/pdf" }, "", 5)).toBe("empty");
    expect(deepSeekOcrEscalationFor({ fileName: "报告.PDF", mime: "" }, "", 5)).toBe("empty");
    expect(deepSeekOcrEscalationFor({ fileName: "报告.docx", mime: "" }, "", 5)).toBe("empty");
  });
});
