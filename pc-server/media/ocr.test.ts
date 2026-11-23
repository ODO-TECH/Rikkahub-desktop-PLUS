// media/ocr.test.ts — DeepSeek 官方 OCR(POST /v1/tools/ocr)协议行为锁。
// 端点是**编译期常量**(用户拍板:官方服务,不给中转地址),所以本地 stub 靠
// 重写 globalThis.fetch 把出网请求按原路径转回本机(仓内既有做法),不打真实接口。
// 逐条锁官方文档语义:
//   · multipart 只允许 file + purpose 两个字段(多发字段官方直接 400)
//   · purpose 默认取设置值,值域外归一为 text_recognition
//   · 识别期失败仍是 HTTP 200 + { error } ——必须认出来,不能当空结果吞掉
//   · 保活换行(响应体前导 \n)不影响整体按 JSON 解析
//   · pages[].text 按页序拼接;finish_reason=length 的页要标出来
//   · 100 MiB 上限与「开关开但 Key 没填」都在**发出请求之前**拦下(不烧配额)
// 纪律:不用 mock.module 桩依赖。实测 bun 1.4.2 的 mock.module 是**进程级注册表**,会泄漏到
// 之后的测试文件(media/asr-mimo.test.ts 就把自己桩过的 api/logs 带进了本文件),所以本文件
// 不假设 addLog 是真的还是被别人换成空函数:日志留痕的断言放在
// conversations/auxiliary-ocr-fallback.test.ts(那条链路没人桩),这里只锁协议与烧钱闸门。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-ocr-test-"));

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 注意:`state` 是 json-store 的 `export let`,动态导入解构会**快照当时的值**(bootstrap
// 还没跑 → undefined)。所以取当前状态走命名空间引用,不解构 state。
const { setState } = await import("../persistence/json-store");
const {
  DEEPSEEK_OCR_MAX_BYTES,
  deepSeekOcrImageExtension,
  isDeepSeekOcrConfigured,
  isDeepSeekOcrDocument,
  isDeepSeekOcrRequested,
  normalizeDeepSeekOcrPurpose,
  recognizeDataUrlImageWithDeepSeekOcr,
  recognizeFileWithDeepSeekOcr,
  recognizeWithDeepSeekOcr,
} = await import("./ocr");

/** 出网尝试次数(用于证明「超限/缺 Key 不发请求」)。 */
let attempts = 0;
/** 落到 stub 的每一单请求的报文形状。 */
const requests: Array<{ path: string; fields: string[]; purposes: string[]; names: string[]; types: string[]; auth: string; bytes: number }> = [];
/** 下一次响应的状态码与正文(可含前导保活换行)。 */
let nextStatus = 200;
let nextBody = "{}";

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const form = await request.formData();
    const entries = [...form.entries()];
    const filePart: unknown = entries.find(([key]) => key === "file")?.[1];
    const file = filePart instanceof File || filePart instanceof Blob ? filePart : null;
    requests.push({
      path: new URL(request.url).pathname,
      fields: entries.map(([key]) => key).sort(),
      purposes: entries.filter(([key]) => key === "purpose").map(([, value]) => String(value)),
      names: filePart instanceof File ? [filePart.name] : [],
      types: file ? [file.type] : [],
      auth: request.headers.get("authorization") ?? "",
      bytes: file ? (await file.arrayBuffer()).byteLength : 0,
    });
    return new Response(nextBody, { status: nextStatus, headers: { "Content-Type": "application/json" } });
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  attempts += 1;
  // 保留原路径:既验 endpoint 常量是 /v1/tools/ocr,又不需要把地址做成可配置项。
  return realFetch(`http://127.0.0.1:${server.port}${new URL(url).pathname}`, init as RequestInit);
}) as typeof fetch;

afterAll(async () => {
  globalThis.fetch = realFetch;
  server.stop(true);
  // addLog 走节流落盘:等它写完再删临时数据目录,否则会在测试结束后喷一条 ENOENT 噪声。
  await new Promise((resolve) => setTimeout(resolve, 260));
  rmSync(process.env.RIKKAHUB_PC_DATA_DIR!, { recursive: true, force: true });
});

function configure(overrides: Record<string, unknown> = {}) {
  // stats/logs 手写最小形状(不调 api/logs 的 defaultRequestStats:那个导出可能被别的
  // 测试文件的 mock.module 换成不存在的键),让真实 addLog 无论是否被桩都不会炸。
  setState({
    logs: [],
    stats: { totalRequests: 0, failedRequests: 0, byProvider: {}, byGroup: {} },
    settings: {
      deepseekOcrEnabled: true,
      deepseekOcrApiKey: "sk-ocr-test",
      deepseekOcrPurpose: "text_recognition",
      ...overrides,
    },
  } as any);
  attempts = 0;
  requests.length = 0;
  nextStatus = 200;
  nextBody = JSON.stringify({ page_count: 1, pages: [{ index: 0, text: "文字", finish_reason: "stop" }] });
}

test("就绪判定:开关与 Key 缺一都不算就绪,但只有「开关开 + 无 Key」要走报错档", () => {
  configure({ deepseekOcrEnabled: false, deepseekOcrApiKey: "" });
  expect(isDeepSeekOcrRequested()).toBe(false);
  expect(isDeepSeekOcrConfigured()).toBe(false);
  configure({ deepseekOcrEnabled: true, deepseekOcrApiKey: "   " });
  expect(isDeepSeekOcrRequested()).toBe(true);
  expect(isDeepSeekOcrConfigured()).toBe(false);
  configure({ deepseekOcrEnabled: true, deepseekOcrApiKey: "sk-x" });
  expect(isDeepSeekOcrRequested()).toBe(true);
  expect(isDeepSeekOcrConfigured()).toBe(true);
});

test("purpose 白名单:官方两值保留,其余一律 text_recognition", () => {
  expect(normalizeDeepSeekOcrPurpose("rich_layout_recognition")).toBe("rich_layout_recognition");
  expect(normalizeDeepSeekOcrPurpose("text_recognition")).toBe("text_recognition");
  // 值两端空白按 trim 后精确比对。
  expect(normalizeDeepSeekOcrPurpose("  rich_layout_recognition  ")).toBe("rich_layout_recognition");
  for (const junk of ["", "ocr", "RICH_LAYOUT_RECOGNITION", "text-recognition", undefined, null, 0]) {
    // 大小写变体与自定义值官方都不接受 → 归一到默认档。
    expect(normalizeDeepSeekOcrPurpose(junk as unknown)).toBe("text_recognition");
  }
});

test("报文:multipart 只有 file + purpose 两字段,Bearer 认证,文件名照传", async () => {
  configure();
  // 前导换行 = 官方识别期间的保活字节,整体仍须能按 JSON 解析。
  nextBody = "\n\n\n" + JSON.stringify({
    id: "ocr-1",
    object: "ocr.result",
    created: 1762790000,
    purpose: "text_recognition",
    page_count: 2,
    pages: [
      { index: 0, text: "第一页文字", finish_reason: "stop" },
      { index: 1, text: "第二页被截断", finish_reason: "length" },
    ],
    usage: { input_tokens: 1536, output_tokens: 412, total_tokens: 1948 },
  });
  const result = await recognizeWithDeepSeekOcr({ source: new Uint8Array(1024), fileName: "scan.pdf", bytes: 1024 });
  expect(attempts).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0].path).toBe("/v1/tools/ocr");
  expect(requests[0].fields).toEqual(["file", "purpose"]);
  expect(requests[0].purposes).toEqual(["text_recognition"]);
  expect(requests[0].names).toEqual(["scan.pdf"]);
  expect(requests[0].auth).toBe("Bearer sk-ocr-test");
  expect(requests[0].bytes).toBe(1024);
  // 页序保留、页间空行拼接(与本地 PDF 提取一致),截断页要被点名。
  expect(result.text).toBe("第一页文字\n\n第二页被截断");
  expect(result.pageCount).toBe(2);
  expect(result.truncatedPages).toEqual([1]);
  expect(result.usage).toEqual({ input_tokens: 1536, output_tokens: 412, total_tokens: 1948 });
});

test("purpose 跟随设置:rich_layout_recognition 原样下发", async () => {
  configure({ deepseekOcrPurpose: "rich_layout_recognition" });
  const result = await recognizeWithDeepSeekOcr({ source: new Uint8Array(16), fileName: "a.png", bytes: 16 });
  expect(requests[0].purposes).toEqual(["rich_layout_recognition"]);
  expect(result.text).toBe("文字");
  expect(result.truncatedPages).toEqual([]);
});

test("识别期失败:HTTP 已是 200,但响应体是 error 对象 → 必须抛出而不是当空结果", async () => {
  configure();
  nextBody = JSON.stringify({ error: { message: "OCR did not finish in time", type: "gateway_timeout_error", param: null, code: "gateway_timeout_error" } });
  await expect(recognizeWithDeepSeekOcr({ source: new Uint8Array(8), fileName: "a.pdf", bytes: 8 }))
    .rejects.toThrow(/DeepSeek OCR failed: OCR did not finish in time/);
});

test("上传阶段失败:非 2xx 带上状态码与官方 error.message", async () => {
  configure();
  nextStatus = 413;
  nextBody = JSON.stringify({ error: { message: "file is too large: max 100 MiB" } });
  await expect(recognizeWithDeepSeekOcr({ source: new Uint8Array(8), fileName: "a.pdf", bytes: 8 }))
    .rejects.toThrow(/DeepSeek OCR failed \(413\): file is too large: max 100 MiB/);
});

test("空结果:pages 全为空文本时 text 为空串,不抛错(交给调用方判扫描件)", async () => {
  configure();
  nextBody = JSON.stringify({ page_count: 3, pages: [{ index: 0, text: "  " }, { index: 1, text: "" }] });
  const result = await recognizeWithDeepSeekOcr({ source: new Uint8Array(8), fileName: "a.pdf", bytes: 8 });
  expect(result.text).toBe("");
  // pages 缺项时以官方 page_count 为准(计费口径)。
  expect(result.pageCount).toBe(3);
});

test("100 MiB 上限在发出请求前挡下(零出网,不烧配额)", async () => {
  configure();
  await expect(recognizeWithDeepSeekOcr({
    source: new Uint8Array(8),
    fileName: "huge.pdf",
    bytes: DEEPSEEK_OCR_MAX_BYTES + 1,
  })).rejects.toThrow(/不能超过 100 MiB/);
  expect(attempts).toBe(0);
});

test("Key 未填时调用侧自守:零出网 + 人话错误", async () => {
  configure({ deepseekOcrApiKey: "" });
  await expect(recognizeWithDeepSeekOcr({ source: new Uint8Array(8), fileName: "a.pdf", bytes: 8 }))
    .rejects.toThrow(/未填写 DeepSeek API Key/);
  expect(attempts).toBe(0);
});

test("图片通道:官方六种图片格式按 mime 换成带扩展名的文件名,格式外一律拒绝", async () => {
  configure();
  const base64 = Buffer.from("fake image bytes").toString("base64");
  const result = await recognizeDataUrlImageWithDeepSeekOcr("image/png", base64, "message-image");
  expect(result.text).toBe("文字");
  expect(requests[0].names).toEqual(["image.png"]);
  expect(requests[0].types).toEqual(["image/png"]);
  expect(requests[0].fields).toEqual(["file", "purpose"]);
  await expect(recognizeDataUrlImageWithDeepSeekOcr("image/heic", base64, "x"))
    .rejects.toThrow(/不支持 image\/heic 图片格式/);
  expect(requests).toHaveLength(1);
  expect(deepSeekOcrImageExtension("IMAGE/JPEG")).toBe("jpg");
  expect(deepSeekOcrImageExtension("image/svg+xml")).toBeNull();
});

test("文件通道:文件不在位时给人话错误,不抛 ENOENT,也不出网", async () => {
  configure();
  await expect(recognizeFileWithDeepSeekOcr("D:/__definitely_missing__/scan.pdf", "scan.pdf"))
    .rejects.toThrow(/找不到文件：scan\.pdf/);
  expect(attempts).toBe(0);
});

test("文档白名单:PDF/Word/PPT 系列可升级,EPUB 与纯文本、图片永不走这条判定", () => {
  expect(isDeepSeekOcrDocument("论文.pdf", "application/pdf")).toBe(true);
  expect(isDeepSeekOcrDocument("旧文档.doc", "application/msword")).toBe(true);
  expect(isDeepSeekOcrDocument("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
  expect(isDeepSeekOcrDocument("a.ppt", "")).toBe(true);
  expect(isDeepSeekOcrDocument("a.pptx", "")).toBe(true);
  // 官方格式表里没有 EPUB;图片归图片通道管,不在这条(文档)判定里。
  expect(isDeepSeekOcrDocument("book.epub", "application/epub+zip")).toBe(false);
  expect(isDeepSeekOcrDocument("notes.txt", "text/plain")).toBe(false);
  expect(isDeepSeekOcrDocument("photo.png", "image/png")).toBe(false);
  expect(isDeepSeekOcrDocument("", "")).toBe(false);
});
