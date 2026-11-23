// inference-engine/result-clip.test.ts — S-F1 工具结果头尾裁剪
//
// 钉住五条纪律:
//  ① 阈值内逐字节不变(调用方拿到 null → 保留原对象,前缀缓存稳定);
//  ② 超阈值 → 头 + 标记(含丢弃字符数)+ 尾,且结果严格更短;
//  ③ pending 的 part 不碰,error 条目原样保留(只裁文本条目);
//  ④ 钉住消息跳过;原文(入参数组)不被修改;
//  ⑤ 写入侧校验:头+标记+尾 > 阈值必须拒绝(否则"裁剪"会让结果更长)。
import { describe, expect, test } from "bun:test";

const { clipToolResultText, clipToolResults } = await import("./result-clip");
const { enrichMessages } = await import("./message-enrichment");
const { setState } = await import("../persistence/json-store");
const { defaultResultClipConfig, normalizeResultClipConfig, validateResultClipConfig, RESULT_CLIP_MARKER_RESERVE } =
  await import("../foundation/types/settings/result-clip-config");

import type { Assistant, Conversation, Message, MessagePart, Model, State } from "../foundation/types";

setState({ settings: { lorebooks: [], modeInjections: [], displaySetting: {} } } as unknown as State);

// 测试用配置必须自身合法:头 + 标记上界 + 尾 ≤ 阈值(写入侧同一条硬约束)。
const clip = { thresholdChars: 400, headChars: 200, tailChars: 60 };

function toolMessage(text: string, extra: { pinned?: boolean; pending?: boolean; withError?: boolean } = {}): Message {
  const output: unknown[] = [{ type: "text", text }];
  if (extra.withError) output.push({ type: "error", error: "boom", message: "命令失败" });
  if (extra.pending) output.push({ type: "text", text: "waiting", pending: true });
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    role: "ASSISTANT",
    parts: [
      { type: "tool", toolCallId: "c1", toolName: "bash", input: '{"command":"ls"}', output, approvalState: "auto" },
    ] as unknown as MessagePart[],
    annotations: extra.pinned ? [{ type: "pinned" }] : [],
    createdAt: new Date().toISOString(),
    finishedAt: null,
    translation: null,
  } as unknown as Message;
}

function toolText(msg: Message): string {
  const part = msg.parts.find((item) => item.type === "tool") as unknown as { output: Array<{ text?: string }> };
  return part.output.map((entry) => entry.text ?? "").join("\n");
}

describe("S-F1 clipToolResultText", () => {
  test("阈值内原样返回 null(逐字节不变)", () => {
    expect(clipToolResultText("short output", clip)).toBeNull();
    expect(clipToolResultText("x".repeat(400), clip)).toBeNull();
  });

  test("超阈值 → 头 + 标记 + 尾,严格更短,标记带丢弃字符数", () => {
    const source = `${"A".repeat(300)}MIDDLE${"B".repeat(300)}`;
    const clipped = clipToolResultText(source, clip)!;
    expect(clipped).not.toBeNull();
    expect(clipped.length).toBeLessThan(source.length);
    expect(clipped.startsWith("A".repeat(200))).toBe(true);
    expect(clipped.endsWith("B".repeat(60))).toBe(true);
    expect(clipped).toContain("middle clipped");
    expect(clipped).toContain(String(source.length - 200 - 60));
    expect(clipped).toContain("read_original");
    expect(clipped).not.toContain("MIDDLE");
  });

  test("防御性夹取:头尾配置超过阈值时不裁(宁可不裁也不变长)", () => {
    const bad = { thresholdChars: 100, headChars: 90, tailChars: 40 };
    expect(clipToolResultText("x".repeat(500), bad)).toBeNull();
  });
});

describe("S-F1 clipToolResults", () => {
  test("无工具消息 → 返回原数组引用(零拷贝)", () => {
    const messages: Message[] = [{ id: "u1", role: "USER", parts: [{ type: "text", text: "hi" }], annotations: [], createdAt: "", finishedAt: null, translation: null } as unknown as Message];
    const result = clipToolResults(messages, clip);
    expect(result.messages).toBe(messages);
    expect(result.clippedParts).toBe(0);
    expect(result.clippedChars).toBe(0);
  });

  test("超阈值结果被裁,计数正确;原文数组不被修改", () => {
    const longText = "L".repeat(600);
    const messages = [toolMessage(longText)];
    const snapshot = JSON.stringify(messages);
    const result = clipToolResults(messages, clip);
    expect(result.clippedParts).toBe(1);
    expect(result.clippedChars).toBeGreaterThan(0);
    expect(JSON.stringify(messages)).toBe(snapshot);
    const text = toolText(result.messages[0]!);
    expect(text.length).toBeLessThan(600);
    expect(text).toContain("middle clipped");
  });

  test("pending part 不碰(结果还没来,不能伪造)", () => {
    const messages = [toolMessage("P".repeat(600), { pending: true })];
    const result = clipToolResults(messages, clip);
    expect(result.messages).toBe(messages);
    expect(result.clippedParts).toBe(0);
  });

  test("error 条目原样保留,只裁文本条目", () => {
    const messages = [toolMessage("E".repeat(600), { withError: true })];
    const result = clipToolResults(messages, clip);
    const part = result.messages[0]!.parts.find((item) => item.type === "tool") as unknown as {
      output: Array<{ type: string; text?: string; message?: string; error?: string }>;
    };
    const error = part.output.find((entry) => entry.type === "error");
    expect(error).toEqual({ type: "error", error: "boom", message: "命令失败" });
    const textEntry = part.output.find((entry) => entry.type === "text")!;
    expect(textEntry.text!.length).toBeLessThan(600);
  });

  test("钉住消息跳过(钉住 = 用户要求逐字在场)", () => {
    const messages = [toolMessage("X".repeat(600), { pinned: true })];
    const result = clipToolResults(messages, clip);
    expect(result.messages).toBe(messages);
    expect(result.clippedParts).toBe(0);
  });
});

describe("S-F1 富化层集成", () => {
  const assistant = {
    id: "a1",
    name: "T",
    systemPrompt: "",
    contextMessageLimit: 0,
    messageTemplate: "{{ message }}",
    enableTimeReminder: false,
    promptInjections: [],
    lorebookIds: [],
    modeInjectionIds: [],
  } as unknown as Assistant;
  const conversation = { id: "c1", assistantId: "a1", messages: [] } as unknown as Conversation;
  const model = { modelId: "test-model", inputModalities: ["TEXT"] } as unknown as Model;

  test("传 resultClip → 工具结果被裁,计数器如实上报", () => {
    const messages = [toolMessage("Z".repeat(2000))];
    const enriched = enrichMessages(messages, { conversation, assistant, model, resultClip: clip });
    expect(enriched.clippedToolParts).toBe(1);
    expect(enriched.clippedToolChars).toBeGreaterThan(0);
    expect(toolText(enriched.messages[0]!).length).toBeLessThan(2000);
    // 原文不动。
    expect(toolText(messages[0]!).length).toBe(2000);
  });

  test("不传 resultClip → 逐字节保留(关掉开关与引入前一致)", () => {
    const messages = [toolMessage("Z".repeat(2000))];
    const enriched = enrichMessages(messages, { conversation, assistant, model });
    expect(enriched.clippedToolParts).toBe(0);
    expect(toolText(enriched.messages[0]!).length).toBe(2000);
  });
});

describe("S-F1 配置:默认值与写入侧校验", () => {
  test("默认开,8192 / 4096 / 1024", () => {
    expect(defaultResultClipConfig()).toEqual({ enabled: true, thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
  });

  test("默认值满足硬约束;越界组合被拒绝", () => {
    expect(validateResultClipConfig(defaultResultClipConfig())).toBeNull();
    const bad = { enabled: true, thresholdChars: 4000, headChars: 3900, tailChars: 200 };
    expect(bad.headChars + RESULT_CLIP_MARKER_RESERVE + bad.tailChars).toBeGreaterThan(bad.thresholdChars);
    expect(validateResultClipConfig(bad)).toContain("must not exceed");
  });

  test("加载侧归一化:缺键/损坏逐项回落默认,越界钳制", () => {
    expect(normalizeResultClipConfig(undefined)).toEqual(defaultResultClipConfig());
    expect(normalizeResultClipConfig({ enabled: false, thresholdChars: 1 })).toEqual({
      enabled: false,
      thresholdChars: 1000,
      headChars: 4096,
      tailChars: 1024,
    });
  });
});
