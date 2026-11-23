// inference-engine/api-tokens.test.ts — 出线请求体本地估算(S2 校准的"本地"一侧)
//
// 校准样本 = 本地估算 vs 上游真实 promptTokens,两边必须是同一份东西。这里锁定:
//   - 文本/思维链/工具调用都计入;
//   - 图片走 tile 计费而不是 base64 字符数(否则一张图算成几十万 token,校准环必坏);
//   - 空/畸形载荷不抛、不计噪声。

import { describe, expect, test } from "bun:test";
import type { ApiMessage } from "../foundation/types";
import { estimateTokens } from "../foundation/utils";
import { apiMessagesTokens } from "./api-tokens";
import { IMAGE_TOKENS_REMOTE, imageTokensFromDimensions } from "./image-tokens";

function pngDataUrl(width: number, height: number): string {
  const head = Buffer.alloc(24);
  head[0] = 0x89;
  head.write("PNG", 1, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return `data:image/png;base64,${head.toString("base64")}`;
}

describe("apiMessagesTokens", () => {
  test("字符串 content 按文本估", () => {
    const items: ApiMessage[] = [{ role: "user", content: "你好世界" }];
    expect(apiMessagesTokens(items)).toBe(estimateTokens("你好世界"));
  });

  test("数组 content 逐段累加", () => {
    const items: ApiMessage[] = [
      { role: "user", content: [{ type: "text", text: "abcd" }, { type: "text", text: "efgh" }] },
    ];
    expect(apiMessagesTokens(items)).toBe(estimateTokens("abcd") + estimateTokens("efgh"));
  });

  test("图片按 tile 计费,不按 base64 字符数", () => {
    const url = pngDataUrl(1024, 1024);
    const items: ApiMessage[] = [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }];
    expect(apiMessagesTokens(items)).toBe(imageTokensFromDimensions(1024, 1024));
    // 兆级 data URL 也必须落在 tile 上限内,而不是几十万。
    const huge = `${url.slice(0, -4)}${"A".repeat(400_000)}`;
    expect(apiMessagesTokens([{ role: "user", content: [{ type: "image_url", image_url: { url: huge } }] }]))
      .toBeLessThanOrEqual(2805);
  });

  test("Responses API 的 input_image / input_text 同样识别", () => {
    const items: ApiMessage[] = [
      { role: "user", content: [{ type: "input_text", text: "abcd" }, { type: "input_image", image_url: "https://x/a.png" }] },
    ];
    expect(apiMessagesTokens(items)).toBe(estimateTokens("abcd") + IMAGE_TOKENS_REMOTE);
  });

  test("思维链与 tool_calls 计入", () => {
    const calls = [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }];
    const base: ApiMessage[] = [{ role: "assistant", content: "正文" }];
    const withExtras: ApiMessage[] = [{ role: "assistant", content: "正文", reasoning_content: "想了很久", tool_calls: calls }];
    expect(apiMessagesTokens(withExtras) - apiMessagesTokens(base))
      .toBe(estimateTokens("想了很久") + estimateTokens(JSON.stringify(calls)));
  });

  test("空序列 / 空 content / 畸形条目不抛也不计噪声", () => {
    expect(apiMessagesTokens([])).toBe(0);
    expect(apiMessagesTokens([{ role: "user", content: "" }])).toBe(0);
    expect(apiMessagesTokens([{ role: "user" }])).toBe(0);
    expect(apiMessagesTokens([null as unknown as ApiMessage, { role: "user", content: [null] }])).toBe(0);
  });
});