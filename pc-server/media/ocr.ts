// media/ocr.ts — DeepSeek 官方 OCR 工具 API（POST /v1/tools/ocr）
//
// 协议权威 = https://api-docs.deepseek.com/zh-cn/api/ocr 与 /zh-cn/guides/ocr，要点（2026-11-18 核对）：
//   · multipart/form-data **只有 file 与 purpose 两个字段**，传入其他字段直接 400
//   · file 需带文件名；格式由文件实际内容判断——PDF / DOC(DOCX) / PPT(PPTX) / 图片
//     (PNG、JPEG、WebP、GIF、BMP、TIFF)
//   · purpose：text_recognition（不含图片的 Word/PPT 直接提取文字，其余逐页识别）、
//     rich_layout_recognition（所有文件都逐页识别）
//   · 限制：单文件 100 MiB（超出 413）、1000 页、上传 120 秒内完成、总时长 180 秒
//   · 响应：识别期间服务端持续发换行符保活，完成后整体是一个 JSON（前导换行属空白，可直接解析）
//     { id, object:"ocr.result", created, purpose, page_count, pages:[{index,text,finish_reason}], usage }
//   · **识别期失败仍是 HTTP 200**，响应体是 { error:{ message,… } }——必须显式认 error
//   · 计费 1.5 元/1000 页（按识别成功的 page_count），客户端断开不会取消识别、完成的照常计费
//   · 限速：单账号同时 15 个识别，与对话模型分开计
//
// 凭据口径（用户拍板）：这是 DeepSeek 官方服务，只填官方 API Key，不接聊天供应商的 Key、
// 不给中转地址；没填 Key 就等于功能不可用（明确报错，不静默回落）。
//
// 纪律：本模块只负责「怎么调官方 OCR 接口」，不做引擎选择与回落编排——那在
// conversations/auxiliary.ts（图片通道）与 files/extraction.ts（文档通道）。

import { existsSync } from "node:fs";
import type { JsonValue } from "../foundation/types";
import { fetchWithTimeout } from "../foundation/net";
import { state } from "../persistence/json-store";
import { textBody } from "../model-providers";
import { addLog } from "../api/logs";

export const DEEPSEEK_OCR_BASE = "https://api.deepseek.com";
export const DEEPSEEK_OCR_ENDPOINT = `${DEEPSEEK_OCR_BASE}/v1/tools/ocr`;
/** 官方单文件上限 100 MiB（超出直接 413，我们在上传前挡下并给中文说明）。 */
export const DEEPSEEK_OCR_MAX_BYTES = 100 * 1024 * 1024;
/** 官方总时长 180 秒（含上传+识别+返回）；客户端再多留 20 秒余量判超时。 */
const DEEPSEEK_OCR_TIMEOUT_MS = 200_000;

export type DeepSeekOcrPurpose = "text_recognition" | "rich_layout_recognition";

export interface DeepSeekOcrResult {
  /** 各页文本按页序拼好的整篇（页间空行，与本地 PDF 提取的拼接方式一致）。 */
  text: string;
  pageCount: number;
  /** finish_reason === "length" 的页码（该页文本被输出上限截断，不完整）。 */
  truncatedPages: number[];
  /** usage 三个 Token 数（官方明说仅供参考、不用于计费）。 */
  usage: JsonValue | null;
}

const OCR_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tif",
};

/** 官方 OCR 图片白名单（按 mime）。 */
export function deepSeekOcrImageExtension(mime: string): string | null {
  return OCR_IMAGE_EXTENSIONS[String(mime || "").toLowerCase()] ?? null;
}

const OCR_DOCUMENT_NAME_RE = /\.(pdf|doc|docx|ppt|pptx)$/i;
const OCR_DOCUMENT_MIME_RE = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation))$/i;

/** 官方 OCR 文档白名单（按文件名或 mime）。EPUB/纯文本不在官方格式表里，永不走这条路。 */
export function isDeepSeekOcrDocument(fileName: string, mime: string): boolean {
  const name = String(fileName || "");
  if (OCR_DOCUMENT_NAME_RE.test(name)) return true;
  return OCR_DOCUMENT_MIME_RE.test(String(mime || "").toLowerCase());
}

export function normalizeDeepSeekOcrPurpose(value: unknown): DeepSeekOcrPurpose {
  return String(value ?? "").trim() === "rich_layout_recognition" ? "rich_layout_recognition" : "text_recognition";
}

/** 用户是否**点名**要用 DeepSeek OCR(开关状态,不看 Key)。
 *  「开关开但 Key 没填」要走报错档:明确告知,而不是悄悄用视觉模型顶上。 */
export function isDeepSeekOcrRequested(): boolean {
  return state.settings.deepseekOcrEnabled === true;
}

/** OCR 引擎就绪判定（唯一入口）：开关开 + Key 已填。Key 空 = 不可用，调用方据此报错或走视觉模型。 */
export function isDeepSeekOcrConfigured(): boolean {
  return state.settings.deepseekOcrEnabled === true && String(state.settings.deepseekOcrApiKey ?? "").trim().length > 0;
}

/** 未填 Key 时的人话错误（与「报错档」口径一致：不静默换引擎）。 */
export function deepSeekOcrMissingKeyMessage(): string {
  return "已开启 DeepSeek OCR，但未填写 DeepSeek API Key。请到「设置 → 模型 → 场景模型 → OCR」填写官方 API Key，或关闭该开关改用视觉模型 OCR";
}

function ocrFailureDetail(status: number, rawText: string): string {
  let message = "";
  try {
    const parsed = JSON.parse(rawText) as { error?: { message?: string } };
    message = String(parsed?.error?.message ?? "").trim();
  } catch {
    // 非 JSON 错误体：原文截断进错误信息
  }
  return message || rawText.slice(0, 300) || `HTTP ${status}`;
}

/**
 * 调一次官方 OCR。source 直接交给 FormData（Bun 的 file Blob 不上内存整份拷贝）；
 * bytes 只用于超限预检与日志。识别失败/超时也走这里抛错，返回的一定是有文本的结果。
 */
export async function recognizeWithDeepSeekOcr(input: {
  source: Blob | ArrayBuffer | Uint8Array;
  fileName: string;
  bytes?: number;
  label?: string;
  purpose?: DeepSeekOcrPurpose;
}): Promise<DeepSeekOcrResult> {
  const settings = state.settings;
  const apiKey = String(settings.deepseekOcrApiKey ?? "").trim();
  if (!apiKey) throw new Error(deepSeekOcrMissingKeyMessage());
  const size = input.bytes ?? (input.source instanceof Blob ? input.source.size : (input.source as ArrayBuffer | Uint8Array).byteLength);
  if (size > DEEPSEEK_OCR_MAX_BYTES) {
    throw new Error(`DeepSeek OCR 单文件不能超过 100 MiB（当前约 ${(size / 1024 / 1024).toFixed(1)} MiB）`);
  }
  const purpose = input.purpose ?? normalizeDeepSeekOcrPurpose(settings.deepseekOcrPurpose);
  const started = Date.now();
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  // 官方文档：表单只有 file + purpose 两个字段，传入其他字段返回 400。
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", input.source instanceof Blob ? input.source : new Blob([input.source instanceof Uint8Array ? new Uint8Array(input.source) : input.source]), input.fileName);
  const response = await fetchWithTimeout(DEEPSEEK_OCR_ENDPOINT, {
    method: "POST",
    headers,
    body: form,
    timeoutMs: DEEPSEEK_OCR_TIMEOUT_MS,
  });
  const rawText = await response.text();
  let raw: any = {};
  try {
    // 识别期间的保活换行属 JSON 前导空白，整体可直接解析。
    raw = rawText ? JSON.parse(rawText) : {};
  } catch {
    raw = {};
  }
  const pageCount = Number(raw?.page_count ?? (Array.isArray(raw?.pages) ? raw.pages.length : 0));
  addLog({
    providerId: "deepseek-ocr",
    providerName: "DeepSeek OCR",
    url: DEEPSEEK_OCR_ENDPOINT,
    ok: response.ok && !raw?.error,
    status: response.status,
    kind: "provider:ocr",
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: `multipart /v1/tools/ocr\npurpose=${purpose}\nfile=${input.label ?? input.fileName}\nblob=${size}B`,
    responseBody: textBody(rawText),
    error: response.ok && !raw?.error ? undefined : textBody(rawText),
  });
  if (!response.ok) throw new Error(`DeepSeek OCR failed (${response.status}): ${ocrFailureDetail(response.status, rawText)}`);
  // 识别开始后状态码已是 200：失败/超时体现在响应体的 error 里。
  if (raw?.error) {
    throw new Error(`DeepSeek OCR failed: ${String(raw.error?.message ?? raw.error).slice(0, 300)}`);
  }
  const pages = Array.isArray(raw?.pages) ? raw.pages : [];
  const truncatedPages: number[] = [];
  const texts: string[] = [];
  for (const page of pages) {
    const index = Number(page?.index ?? texts.length);
    const text = String(page?.text ?? "");
    if (String(page?.finish_reason ?? "") === "length") truncatedPages.push(index);
    if (text.trim()) texts.push(text);
  }
  return {
    text: texts.join("\n\n").trim(),
    // 官方按识别成功的页数计费；无 pages 时以 page_count 为准。
    pageCount: pageCount || texts.length,
    truncatedPages,
    usage: raw?.usage && typeof raw.usage === "object" ? (raw.usage as JsonValue) : null,
  };
}

/** 已存在的磁盘文件 → OCR（文档通道用；文件不在位时给人话错误，不抛 ENOENT）。
 *  Part 的 Content-Type 由 Bun.file 按扩展名推断，官方再看文件实际内容判断格式。 */
export async function recognizeFileWithDeepSeekOcr(path: string, fileName: string): Promise<DeepSeekOcrResult> {
  if (!existsSync(path)) throw new Error(`DeepSeek OCR 找不到文件：${fileName}`);
  const file = Bun.file(path);
  // Bun.file 本身就是 Blob：直接交给 FormData 流式上传，不把整份文件读进堆里
  // （提取迁到子进程的同一条理由——主进程不养大内存——在这里同样成立）。
  return recognizeWithDeepSeekOcr({
    source: file,
    fileName,
    bytes: file.size,
    label: fileName,
  });
}

/** data URL 图片 → OCR（图片通道用）。mime 不在官方白名单时返回 null，调用方回落视觉模型。 */
export async function recognizeDataUrlImageWithDeepSeekOcr(mime: string, base64Data: string, sourceLabel: string): Promise<DeepSeekOcrResult> {
  const extension = deepSeekOcrImageExtension(mime);
  if (!extension) {
    throw new Error(`DeepSeek OCR 不支持 ${mime || "未知"} 图片格式（官方支持 PNG、JPEG、WebP、GIF、BMP、TIFF）`);
  }
  const bytes = Buffer.from(base64Data, "base64");
  return recognizeWithDeepSeekOcr({
    source: new Blob([bytes], { type: mime }),
    fileName: `image.${extension}`,
    bytes: bytes.length,
    label: sourceLabel,
  });
}
