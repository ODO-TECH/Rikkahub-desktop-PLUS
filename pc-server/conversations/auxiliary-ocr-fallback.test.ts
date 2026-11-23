// conversations/auxiliary-ocr-fallback.test.ts — 图片 OCR 三档引擎编排的行为锁。
// 口径(用户拍板):OCR 是"报错档"能力,但 DeepSeek 官方 OCR 失败时**自动回落**视觉模型,
// 且回落不静默(错误中心留痕);「开关开但 Key 没填」不能被悄悄换引擎,必须直接报错。
// 两条通道都以 fetch 出网,所以整个测试只有一个 globalThis.fetch 桩(按路径分流),
// 不用 mock.module——后者在本仓会跨文件泄漏(实测),把别的测试文件带崩。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-ocr-aux-test-"));

import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `state` 是 json-store 的 `export let`:动态导入解构只能快照当下值(bootstrap 未跑 =
// undefined),需要读当前状态时用命名空间引用。
const store = await import("../persistence/json-store");
const { setState } = store;
const { defaultSettings } = await import("../app-config/defaults");
// api/logs 只用来给 addLog 落 stats/logs:stats 手写最小形状,不调它的
// defaultRequestStats——那个导出可能被别的测试文件的 mock.module 换掉(实测会跨文件泄漏)。
const { clearAppErrors, recentAppErrors } = await import("../observability/app-errors");
const { attachOcrToImageParts } = await import("./auxiliary");
const { deepSeekOcrMissingKeyMessage } = await import("../media/ocr");

const DATA_URL = "data:image/png;base64,aWNvbg==";
/** 每条出网请求的路径(用来数「这条通道到底调没调」)。 */
let calls: string[] = [];
let ocrStatus = 200;
let ocrBody: unknown = { page_count: 1, pages: [{ index: 0, text: "DeepSeek 读出的文字", finish_reason: "stop" }] };
let visionBody: unknown = { choices: [{ message: { content: "视觉模型读出的文字" } }] };

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push(path);
    if (path === "/v1/tools/ocr") {
      return new Response(typeof ocrBody === "string" ? ocrBody : JSON.stringify(ocrBody), { status: ocrStatus });
    }
    return Response.json(visionBody, { status: 200 });
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return realFetch(`http://127.0.0.1:${server.port}${new URL(url).pathname}`, init as RequestInit);
}) as typeof fetch;

afterAll(async () => {
  globalThis.fetch = realFetch;
  server.stop(true);
  // 同上:等节流落盘写完再删临时数据目录。
  await new Promise((resolve) => setTimeout(resolve, 260));
  rmSync(process.env.RIKKAHUB_PC_DATA_DIR!, { recursive: true, force: true });
});

/** 文本模型(看不见图)与视觉 OCR 模型各一个,都指向本地 stub。 */
const TEXT_ONLY_MODEL = { id: "text-model", modelId: "gpt-4o-mini-text", name: "Text only", inputModalities: ["TEXT"] } as any;
const VISION_MODEL = { id: "vision-model", modelId: "gpt-4o", name: "Vision", inputModalities: ["TEXT", "IMAGE"] } as any;

function configure(opts: {
  ocrEnabled?: boolean;
  apiKey?: string;
  ocrModelId?: string | null;
} = {}) {
  calls = [];
  ocrStatus = 200;
  ocrBody = { page_count: 1, pages: [{ index: 0, text: "DeepSeek 读出的文字", finish_reason: "stop" }] };
  visionBody = { choices: [{ message: { content: "视觉模型读出的文字" } }] };
  const settings = {
    ...defaultSettings(),
    providers: [{
      id: "p1",
      type: "openai",
      name: "Stub",
      enabled: true,
      apiKey: "sk-stub",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      models: [TEXT_ONLY_MODEL, VISION_MODEL],
    }],
    chatModelId: "text-model",
    ocrModelId: opts.ocrModelId === null ? "" : "vision-model",
    deepseekOcrEnabled: opts.ocrEnabled ?? false,
    deepseekOcrApiKey: opts.apiKey ?? "",
    deepseekOcrPurpose: "text_recognition",
  };
  setState({ ...store.state, settings, logs: [], stats: { totalRequests: 0, failedRequests: 0, byProvider: {}, byGroup: {} } } as any);
  clearAppErrors();
}

function imagePart() {
  return [{ type: "image", url: DATA_URL, metadata: {} } as any];
}

async function ocrOne() {
  const parts = await attachOcrToImageParts(imagePart(), TEXT_ONLY_MODEL);
  return parts[0]!.metadata as Record<string, unknown>;
}

beforeEach(() => configure());

test("开关关(默认):与引入 DeepSeek 前逐字一致——只走视觉模型,一次官方请求都不发", async () => {
  const metadata = await ocrOne();
  expect(calls).toEqual(["/v1/chat/completions"]);
  expect(metadata.ocrText).toBe("视觉模型读出的文字");
  expect(metadata.ocrStatus).toBe("done");
});

test("开关开 + Key 已填:官方 OCR 为主引擎,视觉模型完全不参与", async () => {
  configure({ ocrEnabled: true, apiKey: "sk-ocr" });
  const metadata = await ocrOne();
  expect(calls).toEqual(["/v1/tools/ocr"]);
  expect(metadata.ocrText).toBe("DeepSeek 读出的文字");
  expect(metadata.ocrStatus).toBe("done");
  expect(recentAppErrors()).toHaveLength(0);
});

test("开关开 + 官方 OCR 报错:自动回落视觉模型,并在错误中心留下降级痕迹", async () => {
  configure({ ocrEnabled: true, apiKey: "sk-ocr" });
  ocrStatus = 402;
  ocrBody = { error: { message: "Insufficient Balance" } };
  const metadata = await ocrOne();
  expect(calls).toEqual(["/v1/tools/ocr", "/v1/chat/completions"]);
  expect(metadata.ocrText).toBe("视觉模型读出的文字");
  expect(metadata.ocrStatus).toBe("done");
  const fallback = recentAppErrors().find((entry) => entry.code === "deepseek_ocr_fallback");
  expect(fallback?.severity).toBe("info");
  expect(fallback?.message).toContain("已回落视觉模型");
});

test("开关开 + 官方 OCR 一个字都没识别出来:同样算失败,回落视觉模型而不是写空文本", async () => {
  configure({ ocrEnabled: true, apiKey: "sk-ocr" });
  ocrBody = { page_count: 2, pages: [{ index: 0, text: "  " }, { index: 1, text: "" }] };
  const metadata = await ocrOne();
  expect(calls).toEqual(["/v1/tools/ocr", "/v1/chat/completions"]);
  expect(metadata.ocrText).toBe("视觉模型读出的文字");
});

test("开关开但 Key 没填:直接给人话错误,不换引擎、不静默用视觉模型顶上", async () => {
  configure({ ocrEnabled: true, apiKey: "  " });
  const metadata = await ocrOne();
  expect(calls).toEqual([]);
  expect(metadata.ocrStatus).toBe("failed");
  expect(metadata.ocrError).toBe(deepSeekOcrMissingKeyMessage());
});

test("官方 OCR 失败且没有可回落的 OCR 模型:把两截原因一起说出来,别让人只看到「未配置」", async () => {
  configure({ ocrEnabled: true, apiKey: "sk-ocr", ocrModelId: null });
  ocrStatus = 413;
  ocrBody = { error: { message: "file is too large" } };
  const metadata = await ocrOne();
  expect(calls).toEqual(["/v1/tools/ocr"]);
  expect(metadata.ocrStatus).toBe("failed");
  expect(String(metadata.ocrError)).toContain("file is too large");
  expect(String(metadata.ocrError)).toContain("未配置可回落的 OCR 模型");
});

test("聊天模型自己看得见图:整条 OCR 链路不动(0 请求)", async () => {
  configure({ ocrEnabled: true, apiKey: "sk-ocr" });
  const parts = await attachOcrToImageParts(imagePart(), VISION_MODEL);
  expect(calls).toEqual([]);
  expect(parts[0]!.metadata).toEqual({});
});

test("已有 ocrText 的图片不重复识别(避免每次发送都烧一次配额)", async () => {
  configure({ ocrEnabled: true, apiKey: "sk-ocr" });
  const parts = [{ type: "image", url: DATA_URL, metadata: { ocrText: "上一次读过的文字", ocrStatus: "done" } } as any];
  const next = await attachOcrToImageParts(parts, TEXT_ONLY_MODEL);
  expect(calls).toEqual([]);
  expect(next[0]!.metadata).toEqual({ ocrText: "上一次读过的文字", ocrStatus: "done" });
});
