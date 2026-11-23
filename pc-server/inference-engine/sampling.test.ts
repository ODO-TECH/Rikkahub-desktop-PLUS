// inference-engine/sampling.test.ts — 采样参数 0 哨兵回归
//
// 背景:Kelivo / 部分安卓助手 JSON 用 0 表示未设置。原样出线时 top_p=0 / max_tokens=0
// 会被严格上游按字面值执行,SiliconFlow(Qwen3-VL)实测 200 + 空回复(界面显示
// "(empty response)")。这里锁住"0 一律视为未设置"的出线口径。
import { describe, expect, test } from "bun:test";
import { effectiveMaxTokens, effectiveTopP } from "./sampling";
import { googleGenerationConfig } from "./message-builder";
import { model } from "../model-providers";
import { defaultAssistant } from "../assistants";
import type { Assistant } from "../foundation/types";

describe("effectiveTopP / effectiveMaxTokens", () => {
  test("0 与负数、null、NaN 都是未设置", () => {
    expect(effectiveTopP(0)).toBeUndefined();
    expect(effectiveTopP(-0.5)).toBeUndefined();
    expect(effectiveTopP(null)).toBeUndefined();
    expect(effectiveTopP(undefined)).toBeUndefined();
    expect(effectiveTopP(Number.NaN)).toBeUndefined();
    expect(effectiveMaxTokens(0)).toBeUndefined();
    expect(effectiveMaxTokens(-1)).toBeUndefined();
    expect(effectiveMaxTokens(null)).toBeUndefined();
  });

  test("有效值原样保留,topP 越界(>1)也视为无效", () => {
    expect(effectiveTopP(0.7)).toBe(0.7);
    expect(effectiveTopP(1)).toBe(1);
    expect(effectiveTopP(1.2)).toBeUndefined();
    expect(effectiveMaxTokens(4096)).toBe(4096);
    expect(effectiveMaxTokens(12.9)).toBe(12);
  });
});

describe("Google generationConfig 出线", () => {
  const modelItem = model("gemini-2.5-flash");

  test("topP=0 / maxTokens=0 不写进 config", () => {
    const assistant = { ...defaultAssistant(), topP: 0, maxTokens: 0 } as Assistant;
    const config = googleGenerationConfig(modelItem, assistant);
    expect(config.topP).toBeUndefined();
    expect(config.maxOutputTokens).toBeUndefined();
  });

  test("有效值照常写入", () => {
    const assistant = { ...defaultAssistant(), topP: 0.9, maxTokens: 2048 } as Assistant;
    const config = googleGenerationConfig(modelItem, assistant);
    expect(config.topP).toBe(0.9);
    expect(config.maxOutputTokens).toBe(2048);
  });
});

describe("Kelivo 助手导入", () => {
  test("0 哨兵落成 null,正数保留", async () => {
    const { mapKelivoAssistantFields } = await import("../backup/kelivo/map-to-pc");
    const zero = mapKelivoAssistantFields(
      { name: "A", topP: 0, maxTokens: 0, temperature: 0.3 },
      () => null,
    );
    expect(zero.topP).toBeNull();
    expect(zero.maxTokens).toBeNull();
    expect(zero.temperature).toBe(0.3);
    const set = mapKelivoAssistantFields(
      { name: "B", topP: 0.8, maxTokens: 8192 },
      () => null,
    );
    expect(set.topP).toBe(0.8);
    expect(set.maxTokens).toBe(8192);
  });
});
