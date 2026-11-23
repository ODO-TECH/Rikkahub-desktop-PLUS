// inference-engine/image-tokens.ts — 图片 token 计费(参照 billion-context src/image-tokens.ts)
//
// 背景:contextTokensOf 原先只累加 text part,图片一律计 0。十张大图能占 2.8 万 token
// 却完全不在账上——图片多的会话自动压缩永不触发,直接撞上下文窗口吃 400。
//
// 口径:OpenAI high-detail tile 公式。短边不足 768 先等比升到 768,长边封 2048,再按
// 512×512 切块,85 + 170×块数,上限 2805。Anthropic 按 (w×h)/750、Gemini 按 768 tile,
// 三家口径不同;这里取偏大的一档——高估只是提前压缩,低估是整个请求被拒,两个方向的
// 代价不对等(与 model-limits.ts 的"宁小勿大"同一思路,只是这里错的方向相反)。
//
// 纪律:
//   - 只读容器头拿尺寸,不全量解码图片(PNG IHDR / JPEG SOF / GIF / WebP / BMP)。
//   - 本地文件只 readSync 头部若干字节,不把整张图读进内存。
//   - 结果按 url 指纹 memoize;data URL 的键用长度 + 三段采样哈希,避免把兆级字符串
//     当键留住,也避免"同长度同头部"的不同图片撞键。
//   - 解析不出尺寸 → tile 上限兜底。不用参照项目的 16384:那是给编码 agent 的毒丸值,
//     聊天应用粘十张图就虚增 16 万 token,会触发无意义压缩。
//   - 远端 http(s) URL 取不到字节(不该为计费去下载用户的图) → 固定保守值。
//   - 本模块是 context-budget 纯函数层里唯一被许可的 I/O 边界(读 state.files 与文件头),
//     与 message-builder.dataUrlForMessageUrl 同源;任何失败都降级为兜底值,绝不抛。

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { fileEntryFromApiUrl } from "./message-builder";

export const IMAGE_TILE_BASE = 85;
export const IMAGE_TILE_COST = 170;
export const IMAGE_TILE_EDGE = 512;
export const IMAGE_SHORT_SIDE_TARGET = 768;
export const IMAGE_LONG_SIDE_CAP = 2048;
/** tile 公式的天花板(2048×2048 = 16 块)。同时用作"尺寸解析不出"的兜底。 */
export const IMAGE_TOKENS_MAX = 2805;
export const IMAGE_TOKENS_UNPARSABLE = IMAGE_TOKENS_MAX;
/** 远端 URL:无法取字节,给一个中位保守值而不是上限(上限会让贴图会话虚高)。 */
export const IMAGE_TOKENS_REMOTE = 1600;

/** 只读这么多字节就够解析所有支持的容器头(JPEG 的 EXIF 段最长 64KB,SOF 在其后)。 */
const HEAD_BYTES = 256 * 1024;

/** 尺寸 → token。导出供测试与诊断直接验证公式,不必造图片字节。 */
export function imageTokensFromDimensions(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || !(width > 0) || !(height > 0)) {
    return IMAGE_TOKENS_UNPARSABLE;
  }
  let w = width;
  let h = height;
  const short = Math.min(w, h);
  if (short < IMAGE_SHORT_SIDE_TARGET) {
    const scale = IMAGE_SHORT_SIDE_TARGET / short;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const long = Math.max(w, h);
  if (long > IMAGE_LONG_SIDE_CAP) {
    const scale = IMAGE_LONG_SIDE_CAP / long;
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  const tiles = Math.ceil(w / IMAGE_TILE_EDGE) * Math.ceil(h / IMAGE_TILE_EDGE);
  return Math.min(IMAGE_TOKENS_MAX, IMAGE_TILE_BASE + IMAGE_TILE_COST * tiles);
}

function pngSize(head: Buffer): { width: number; height: number } | null {
  if (head.length < 24 || head[0] !== 0x89 || head.toString("latin1", 1, 4) !== "PNG") return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function gifSize(head: Buffer): { width: number; height: number } | null {
  if (head.length < 10 || head.toString("latin1", 0, 3) !== "GIF") return null;
  return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
}

function bmpSize(head: Buffer): { width: number; height: number } | null {
  if (head.length < 26 || head.toString("latin1", 0, 2) !== "BM") return null;
  // BMP 高度可为负(自顶向下存储),取绝对值。
  return { width: Math.abs(head.readInt32LE(18)), height: Math.abs(head.readInt32LE(22)) };
}

function webpSize(head: Buffer): { width: number; height: number } | null {
  if (head.length < 30) return null;
  if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = head.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    // 有损:3 字节帧标签 + 3 字节起始码(9D 01 2A) + 14 位宽/高。
    if (head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a) return null;
    return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (head[20] !== 0x2f) return null;
    const b0 = head[21]!;
    const b1 = head[22]!;
    const b2 = head[23]!;
    const b3 = head[24]!;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8X") {
    // 扩展格式:24 位画布宽/高,各存的是"实际值 − 1"。
    return {
      width: 1 + (head[24]! | (head[25]! << 8) | (head[26]! << 16)),
      height: 1 + (head[27]! | (head[28]! << 8) | (head[29]! << 16)),
    };
  }
  return null;
}

function jpegSize(head: Buffer): { width: number; height: number } | null {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= head.length) {
    if (head[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = head[offset + 1]!;
    // 无载荷的标记:SOI / TEM / RSTn。
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // EOI 或 SOS:再往后是熵编码数据,尺寸不可能在里面。
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = head.readUInt16BE(offset + 2);
    if (length < 2) return null;
    // SOF0–SOF15,排除 DHT(C4)/JPG(C8)/DAC(CC)——它们不是帧头。
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > head.length) return null;
      const height = head.readUInt16BE(offset + 5);
      const width = head.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/** 从容器头解析尺寸。纯函数,导出供测试直接喂字节。 */
export function imageSizeFromHead(head: Buffer): { width: number; height: number } | null {
  if (!head || head.length === 0) return null;
  return pngSize(head) ?? jpegSize(head) ?? gifSize(head) ?? webpSize(head) ?? bmpSize(head);
}

function headFromDataUrl(url: string): Buffer | null {
  const match = /^data:([^;,]*);base64,/i.exec(url);
  if (!match) return null;
  const start = match[0].length;
  // 每 4 个 base64 字符 = 3 字节;多取一组保证截断处仍能解出完整字节。
  const chars = Math.ceil(HEAD_BYTES / 3) * 4;
  const slice = url.slice(start, start + chars);
  if (!slice) return null;
  try {
    return Buffer.from(slice, "base64");
  } catch {
    return null;
  }
}

function headFromFile(url: string): Buffer | null {
  const entry = fileEntryFromApiUrl(url);
  if (!entry || !existsSync(entry.path)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(entry.path, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytes = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return bytes > 0 ? buffer.subarray(0, bytes) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不影响计费,忽略。
      }
    }
  }
}

const cache = new Map<string, number>();
const CACHE_MAX = 512;

/** data URL 可能兆级:键用长度 + 首/中/尾三段采样的 FNV-1a,既不留住整串,
 *  也不会让"同长度同头部"的两张不同图撞键。非 data URL 本身很短,直接当键。 */
function cacheKey(url: string): string {
  if (!url.startsWith("data:")) return url;
  let hash = 0x811c9dc5;
  const windows = [
    url.slice(0, 512),
    url.slice(Math.max(0, Math.floor(url.length / 2) - 256), Math.floor(url.length / 2) + 256),
    url.slice(-512),
  ];
  for (const window of windows) {
    for (let index = 0; index < window.length; index += 1) {
      hash ^= window.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `data:${url.length}:${hash.toString(16)}`;
}

function computeImageTokens(url: string): number {
  if (/^https?:\/\//i.test(url)) return IMAGE_TOKENS_REMOTE;
  const head = url.startsWith("data:") ? headFromDataUrl(url) : headFromFile(url);
  const size = head ? imageSizeFromHead(head) : null;
  return size ? imageTokensFromDimensions(size.width, size.height) : IMAGE_TOKENS_UNPARSABLE;
}

/** 一张图在模型视野里的近似 token。任何失败都降级为兜底值,绝不抛——计费不该让生成挂掉。 */
export function imageTokensForUrl(url: string): number {
  if (!url) return 0;
  try {
    const key = cacheKey(url);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const tokens = computeImageTokens(url);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, tokens);
    return tokens;
  } catch {
    return IMAGE_TOKENS_UNPARSABLE;
  }
}

/** 测试 seam:清空 memoize,避免跨用例串味。 */
export function resetImageTokenCache(): void {
  cache.clear();
}