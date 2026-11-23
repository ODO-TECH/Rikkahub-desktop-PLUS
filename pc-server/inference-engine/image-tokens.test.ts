// inference-engine/image-tokens.test.ts — 图片计费契约测试
//
// 锁定:
//   - tile 公式(短边升 768 / 长边封 2048 / 85+170×块数 / 上限 2805);
//   - 五种容器头解析(PNG / JPEG / GIF / WebP 三形态 / BMP),只喂头部字节;
//   - 解析不出 → tile 上限兜底(不是参照项目的 16384 毒丸值);
//   - 远端 URL 不下载,取固定保守值;本地文件走 state.files 且只读头部;
//   - 任何畸形输入都不抛(计费不该让生成挂掉)。

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../foundation/types";
import { setState } from "../persistence/json-store";
import {
  IMAGE_TOKENS_MAX,
  IMAGE_TOKENS_REMOTE,
  IMAGE_TOKENS_UNPARSABLE,
  imageSizeFromHead,
  imageTokensForUrl,
  imageTokensFromDimensions,
  resetImageTokenCache,
} from "./image-tokens";

const scratch = mkdtempSync(join(tmpdir(), "rdp-image-tokens-"));

beforeEach(() => {
  resetImageTokenCache();
  setState({ files: [] } as unknown as State);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** 造一个只有 IHDR 的 PNG 头(解析尺寸只需前 24 字节)。 */
function pngHead(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  head[0] = 0x89;
  head.write("PNG", 1, "latin1");
  head.write("\r\n\x1a\n", 4, "latin1");
  head.writeUInt32BE(13, 8); // IHDR 长度
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

/** 造 JPEG 头:SOI + APP0(JFIF) + SOF0。刻意带前置段,验证 marker 行走。 */
function jpegHead(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(18);
  app0.writeUInt8(0xff, 0);
  app0.writeUInt8(0xe0, 1);
  app0.writeUInt16BE(16, 2);
  app0.write("JFIF", 4, "latin1");
  const sof = Buffer.alloc(19);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4); // 精度
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9); // 分量数
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function gifHead(width: number, height: number): Buffer {
  const head = Buffer.alloc(13);
  head.write("GIF89a", 0, "latin1");
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return head;
}

function bmpHead(width: number, height: number): Buffer {
  const head = Buffer.alloc(54);
  head.write("BM", 0, "latin1");
  head.writeInt32LE(width, 18);
  head.writeInt32LE(height, 22);
  return head;
}

function webpHead(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
  const head = Buffer.alloc(40);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(32, 4);
  head.write("WEBP", 8, "latin1");
  head.write(chunk, 12, "latin1");
  head.writeUInt32LE(20, 16);
  if (chunk === "VP8 ") {
    head[23] = 0x9d;
    head[24] = 0x01;
    head[25] = 0x2a;
    head.writeUInt16LE(width & 0x3fff, 26);
    head.writeUInt16LE(height & 0x3fff, 28);
  } else if (chunk === "VP8L") {
    head[20] = 0x2f;
    const w = width - 1;
    const h = height - 1;
    head[21] = w & 0xff;
    head[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
    head[23] = (h >> 2) & 0xff;
    head[24] = (h >> 10) & 0x0f;
  } else {
    const w = width - 1;
    const h = height - 1;
    head[24] = w & 0xff;
    head[25] = (w >> 8) & 0xff;
    head[26] = (w >> 16) & 0xff;
    head[27] = h & 0xff;
    head[28] = (h >> 8) & 0xff;
    head[29] = (h >> 16) & 0xff;
  }
  return head;
}

function dataUrl(head: Buffer): string {
  return `data:image/png;base64,${head.toString("base64")}`;
}

describe("imageTokensFromDimensions(tile 公式)", () => {
  test("小图先升到短边 768:100×100 → 768×768 = 4 块", () => {
    expect(imageTokensFromDimensions(100, 100)).toBe(85 + 170 * 4);
  });

  test("短边已达 768 不再放大:768×768 = 4 块", () => {
    expect(imageTokensFromDimensions(768, 768)).toBe(85 + 170 * 4);
  });

  test("长边封 2048:4096×4096 等比缩到 2048×2048 = 16 块 = 上限", () => {
    expect(imageTokensFromDimensions(4096, 4096)).toBe(IMAGE_TOKENS_MAX);
    expect(IMAGE_TOKENS_MAX).toBe(85 + 170 * 16);
  });

  test("极端长条图:短边升 768 后长边被封顶,不会算出天文数字", () => {
    const tokens = imageTokensFromDimensions(20000, 100);
    expect(tokens).toBeLessThanOrEqual(IMAGE_TOKENS_MAX);
    expect(tokens).toBeGreaterThan(0);
  });

  test("非正数/非有限尺寸 → 兜底上限,不返回 0(0 会让图片重新隐身)", () => {
    expect(imageTokensFromDimensions(0, 100)).toBe(IMAGE_TOKENS_UNPARSABLE);
    expect(imageTokensFromDimensions(-5, 100)).toBe(IMAGE_TOKENS_UNPARSABLE);
    expect(imageTokensFromDimensions(Number.NaN, 100)).toBe(IMAGE_TOKENS_UNPARSABLE);
    expect(imageTokensFromDimensions(Number.POSITIVE_INFINITY, 100)).toBe(IMAGE_TOKENS_UNPARSABLE);
  });
});

describe("imageSizeFromHead(容器头解析)", () => {
  test("PNG IHDR", () => {
    expect(imageSizeFromHead(pngHead(1024, 512))).toEqual({ width: 1024, height: 512 });
  });

  test("JPEG SOF0(前面有 APP0 段)", () => {
    expect(imageSizeFromHead(jpegHead(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  test("GIF 逻辑屏幕描述符", () => {
    expect(imageSizeFromHead(gifHead(320, 240))).toEqual({ width: 320, height: 240 });
  });

  test("BMP(负高度取绝对值)", () => {
    expect(imageSizeFromHead(bmpHead(800, 600))).toEqual({ width: 800, height: 600 });
    expect(imageSizeFromHead(bmpHead(800, -600))).toEqual({ width: 800, height: 600 });
  });

  test("WebP 三形态 VP8 / VP8L / VP8X", () => {
    expect(imageSizeFromHead(webpHead("VP8 ", 640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSizeFromHead(webpHead("VP8L", 640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSizeFromHead(webpHead("VP8X", 640, 480))).toEqual({ width: 640, height: 480 });
  });

  test("空/畸形/不认识的头 → null", () => {
    expect(imageSizeFromHead(Buffer.alloc(0))).toBeNull();
    expect(imageSizeFromHead(Buffer.from("not an image at all"))).toBeNull();
    expect(imageSizeFromHead(Buffer.from([0x89, 0x50]))).toBeNull(); // PNG 签名截断
    expect(imageSizeFromHead(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull(); // JPEG 直接 EOI
  });
});

describe("imageTokensForUrl(端到端与降级)", () => {
  test("data URL 走头部解析,与直接喂尺寸同值", () => {
    expect(imageTokensForUrl(dataUrl(pngHead(1024, 1024)))).toBe(imageTokensFromDimensions(1024, 1024));
  });

  test("空 url 计 0(没有图就没有成本)", () => {
    expect(imageTokensForUrl("")).toBe(0);
  });

  test("远端 http(s) 不下载,取固定保守值", () => {
    expect(imageTokensForUrl("https://example.com/a.png")).toBe(IMAGE_TOKENS_REMOTE);
    expect(imageTokensForUrl("http://example.com/a.png")).toBe(IMAGE_TOKENS_REMOTE);
    expect(IMAGE_TOKENS_REMOTE).toBeLessThan(IMAGE_TOKENS_MAX);
  });

  test("解析不出尺寸 → tile 上限兜底(不是 16384 毒丸值)", () => {
    expect(imageTokensForUrl("data:image/png;base64,AAAA")).toBe(IMAGE_TOKENS_UNPARSABLE);
    expect(imageTokensForUrl("/api/files/999/content")).toBe(IMAGE_TOKENS_UNPARSABLE);
    expect(IMAGE_TOKENS_UNPARSABLE).toBe(2805);
  });

  test("本地文件按 state.files 解析,只写头部也能算出尺寸", () => {
    const path = join(scratch, "head-only.png");
    writeFileSync(path, Buffer.concat([pngHead(1024, 768), Buffer.alloc(64)]));
    setState({ files: [{ id: 7, path, mime: "image/png" }] } as unknown as State);
    expect(imageTokensForUrl("/api/files/7/content")).toBe(imageTokensFromDimensions(1024, 768));
  });

  test("同一 url 命中 memoize;不同尺寸不撞键", () => {
    const a = dataUrl(pngHead(512, 512));
    const b = dataUrl(pngHead(2048, 2048));
    const first = imageTokensForUrl(a);
    expect(imageTokensForUrl(a)).toBe(first);
    expect(imageTokensForUrl(b)).not.toBe(first);
  });

  test("兆级 data URL 只解头部,结果与小图一致", () => {
    const head = pngHead(800, 600);
    const huge = dataUrl(Buffer.concat([head, Buffer.alloc(1024 * 1024, 0x41)]));
    expect(imageTokensForUrl(huge)).toBe(imageTokensFromDimensions(800, 600));
  });

  test("缓存溢出整体清空后仍算得对(不返回陈旧/错值)", () => {
    const expected = imageTokensFromDimensions(512, 512);
    for (let index = 0; index < 600; index += 1) {
      const url = `${dataUrl(pngHead(512, 512))}#${index}`;
      expect(imageTokensForUrl(url)).toBe(expected);
    }
  });

  test("畸形输入一律不抛", () => {
    expect(() => imageTokensForUrl("data:")).not.toThrow();
    expect(() => imageTokensForUrl("data:image/png;base64,")).not.toThrow();
    expect(() => imageTokensForUrl("/api/files/not-a-number/content")).not.toThrow();
    expect(() => imageTokensForUrl("file:///etc/passwd")).not.toThrow();
    expect(imageTokensForUrl("file:///etc/passwd")).toBe(IMAGE_TOKENS_UNPARSABLE);
  });
});