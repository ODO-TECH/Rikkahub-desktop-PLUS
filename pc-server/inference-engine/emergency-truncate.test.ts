// inference-engine/emergency-truncate.test.ts — 常开应急截断契约测试(压缩 v2 · S4)
//
// 锁定:
//   - 触发线双向:94% 不动手、95% 动手(含恰好等于阈值的边界);
//   - 从最大的旧工具输出开始截,截到释放线就停(不是一刀全截);
//   - 最近 3 条 / error / pending / 钉住 / 摘要行一律逐字保留;
//   - 替换必须严格更短(头尾重叠时跳过,绝不把上下文推得更大);
//   - latch:后续轮逐字节重放,与本轮是否仍超阈值无关;钉住后摘除 key 恢复原文;
//   - 工具配对不变量:output 仍非空、toolCallId 不变、非文本条目原样保留;
//   - enrichMessages 接入:**不受 contextBudget 开关门控**,不传窗口则逐字节旧行为。
//
// token 口径:input 固定 "{}"(2 个 ASCII 字符),CJK 输出 N 字 → estimateTokens("{}"+N字)
// = ceil(N + 0.5) = N + 1;纯文本消息 N 字 → N。下面所有期望值都按这个口径手算。

import { beforeEach, describe, expect, test, beforeAll } from "bun:test";
import type { Assistant, Conversation, Message, State, ToolOutputEntry, ToolPart } from "../foundation/types";
import { message, textFromParts } from "../foundation/utils";
import { setState } from "../persistence/json-store";
import { contextTokensOf } from "./context-budget";
import {
  EMERGENCY_KEEP_CHARS,
  EMERGENCY_MIN_PART_TOKENS,
  EMERGENCY_PROTECT_RECENT,
  EMERGENCY_TARGET_RATIO,
  EMERGENCY_TRIGGER_RATIO,
  emergencyTruncateToolOutputs,
  resetEmergencyTruncateLatch,
} from "./emergency-truncate";
import { enrichMessages } from "./message-enrichment";

beforeAll(() => {
  setState({
    settings: {
      displaySetting: { userNickname: "Test User" },
      lorebooks: [],
      modeInjections: [],
      chatModelId: "m1",
    },
  } as unknown as State);
});

beforeEach(() => resetEmergencyTruncateLatch());

function textMsg(role: "USER" | "ASSISTANT", text: string): Message {
  return message(role, [{ type: "text", text }]);
}

function toolPart(callId: string, output: ToolOutputEntry[]): ToolPart {
  return {
    type: "tool",
    toolCallId: callId,
    toolName: "read_file",
    input: "{}",
    output,
    approvalState: { type: "auto" },
  };
}

function toolMsg(callId: string, text: string, annotations?: Message["annotations"]): Message {
  const msg = message("ASSISTANT", [toolPart(callId, [{ type: "text", text }])]);
  return annotations ? { ...msg, annotations } : msg;
}

function rawToolMsg(callId: string, output: ToolOutputEntry[]): Message {
  return message("ASSISTANT", [toolPart(callId, output)]);
}

function firstTool(msg: Message): ToolPart {
  const part = msg.parts.find((item) => item.type === "tool");
  if (!part) throw new Error("message has no tool part");
  return part as ToolPart;
}

function outputText(msg: Message): string {
  return firstTool(msg).output
    .map((entry) => (entry.type === "text" ? String(entry.text ?? "") : ""))
    .join("");
}

function totalOf(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + contextTokensOf(msg, { reasoning: true }), 0);
}

const MARKER = "[truncated for context space — original ~";

describe("常量口径", () => {
  test("95% 触发 / 90% 释放 / ≥1000 token / 保护最近 3 条 / 头尾各 2000 字符", () => {
    expect(EMERGENCY_TRIGGER_RATIO).toBe(0.95);
    expect(EMERGENCY_TARGET_RATIO).toBe(0.9);
    expect(EMERGENCY_MIN_PART_TOKENS).toBe(1000);
    expect(EMERGENCY_PROTECT_RECENT).toBe(3);
    expect(EMERGENCY_KEEP_CHARS).toBe(2000);
  });
});

describe("触发线(双向边界)", () => {
  // 2 + (N+1) + 1 + 2 + 2 = N + 8;窗口 100000 → 触发线 95000。
  const build = (n: number) => [
    textMsg("USER", "开始"),
    toolMsg("big", "字".repeat(n)),
    textMsg("USER", "问"),
    textMsg("USER", "再问"),
    textMsg("USER", "三问"),
  ];

  test("94% → 原样返回(同一数组引用,零改动)", () => {
    const messages = build(93_992);
    expect(totalOf(messages)).toBe(94_000);
    const result = emergencyTruncateToolOutputs(messages, { windowTokens: 100_000 });
    expect(result.messages).toBe(messages);
    expect(result.truncatedParts).toBe(0);
    expect(result.newlyTruncatedParts).toBe(0);
    expect(result.savedTokens).toBe(0);
  });

  test("恰好 95% → 触发,截到释放线以下", () => {
    const messages = build(94_992);
    expect(totalOf(messages)).toBe(95_000);
    const result = emergencyTruncateToolOutputs(messages, { windowTokens: 100_000 });
    expect(result.truncatedParts).toBe(1);
    expect(result.newlyTruncatedParts).toBe(1);
    expect(result.savedTokens).toBeGreaterThan(0);
    expect(totalOf(result.messages)).toBeLessThan(95_000);
    expect(totalOf(result.messages)).toBeLessThanOrEqual(Math.floor(100_000 * EMERGENCY_TARGET_RATIO));
    expect(outputText(result.messages[1]!)).toContain(MARKER);
    // 原文对象零改动。
    expect(outputText(messages[1]!)).toBe("字".repeat(94_992));
  });

  test("窗口 ≤0 / 空序列 → 不参与(不猜)", () => {
    const messages = build(94_992);
    expect(emergencyTruncateToolOutputs(messages, { windowTokens: 0 }).messages).toBe(messages);
    expect(emergencyTruncateToolOutputs(messages, { windowTokens: -1 }).messages).toBe(messages);
    expect(emergencyTruncateToolOutputs([], { windowTokens: 100 }).messages).toEqual([]);
  });
});

describe("截断顺序与范围", () => {
  test("从最大的开始,截到释放线就停(第二大不动)", () => {
    const messages = [
      textMsg("USER", "始"),
      toolMsg("a", "字".repeat(30_000)),
      toolMsg("b", "字".repeat(20_000)),
      textMsg("USER", "a"),
      textMsg("USER", "b"),
      textMsg("USER", "c"),
    ];
    expect(totalOf(messages)).toBe(50_006);
    // 触发线 49400、释放线 46800:截掉 30000 那一块就够,20000 那块不该被碰。
    const result = emergencyTruncateToolOutputs(messages, { windowTokens: 52_000 });
    expect(result.truncatedParts).toBe(1);
    expect(outputText(result.messages[1]!)).toContain(MARKER);
    expect(outputText(result.messages[2]!)).toBe("字".repeat(20_000));
  });

  test("最近 3 条消息一律不动(即使它最大且已超线)", () => {
    const messages = [
      textMsg("USER", "始"),
      toolMsg("big", "字".repeat(60_000)),
      textMsg("USER", "x"),
      textMsg("USER", "y"),
    ];
    expect(totalOf(messages)).toBe(60_004);
    const result = emergencyTruncateToolOutputs(messages, { windowTokens: 60_000 });
    expect(result.messages).toBe(messages);
    expect(result.truncatedParts).toBe(0);
  });

  test("替换必须严格更短:头尾重叠的小输出跳过(1500 token 也≥门槛)", () => {
    const messages = [
      textMsg("USER", "字".repeat(50_000)),
      toolMsg("small", "字".repeat(1_500)),
      textMsg("USER", "a"),
      textMsg("USER", "b"),
      textMsg("USER", "c"),
    ];
    expect(totalOf(messages)).toBe(51_504);
    expect(contextTokensOf(messages[1]!, { reasoning: true })).toBeGreaterThan(EMERGENCY_MIN_PART_TOKENS);
    const result = emergencyTruncateToolOutputs(messages, { windowTokens: 52_000 });
    // 头 1500 + 尾 500 + 标记 > 原文 1500 → 截了反而更长,必须跳过。
    expect(result.messages).toBe(messages);
    expect(result.truncatedParts).toBe(0);
  });

  test("低于 1000 token 的输出不截(即使窗口极度紧张)", () => {
    const messages = [
      textMsg("USER", "字".repeat(50_000)),
      toolMsg("tiny", "字".repeat(900)),
      textMsg("USER", "a"),
      textMsg("USER", "b"),
      textMsg("USER", "c"),
    ];
    const result = emergencyTruncateToolOutputs(messages, { windowTokens: 10_000 });
    expect(result.truncatedParts).toBe(0);
    expect(outputText(result.messages[1]!)).toBe("字".repeat(900));
  });
});

describe("豁免对象(error / pending / 钉住 / 摘要行)", () => {
  test("error 与 pending 条目逐字保留,钉住消息原文不动,只截普通结果", () => {
    const err = rawToolMsg("err", [{ error: "boom: upstream 500" }]);
    const pending = rawToolMsg("pending", [{ pending: true, questions: [] }]);
    const pinned = toolMsg("pinned", "字".repeat(60_000), [{ type: "pinned" }]);
    const normal = toolMsg("ok", "字".repeat(60_000));
    const messages = [
      textMsg("USER", "始"),
      err,
      pending,
      pinned,
      normal,
      textMsg("USER", "a"),
      textMsg("USER", "b"),
      textMsg("USER", "c"),
    ];
    const result = emergencyTruncateToolOutputs(messages, { windowTokens: 120_000 });
    expect(result.truncatedParts).toBe(1);
    expect(firstTool(result.messages[1]!).output[0]).toEqual({ error: "boom: upstream 500" });
    expect((firstTool(result.messages[2]!).output[0] as { pending?: unknown }).pending).toBe(true);
    expect(outputText(result.messages[3]!)).toBe("字".repeat(60_000));
    expect(outputText(result.messages[4]!)).toContain(MARKER);
  });

  test("混合输出:error/图片条目原样保留,只换文本条目", () => {
    const image: ToolOutputEntry = { type: "image", url: "data:image/png;base64,AAAA" } as ToolOutputEntry;
    const mixed = rawToolMsg("mixed", [image, { type: "text", text: "字".repeat(60_000) }]);
    const messages = [textMsg("USER", "始"), mixed, textMsg("USER", "a"), textMsg("USER", "b"), textMsg("USER", "c")];
    const result = emergencyTruncateToolOutputs(messages, { windowTokens: 60_000 });
    const part = firstTool(result.messages[1]!);
    expect(part.output.length).toBe(2);
    expect(part.output[0]).toBe(image); // 同一引用:非文本条目零改动
    expect(String((part.output[1] as { text?: unknown }).text)).toContain(MARKER);
    // 工具配对不变量:output 仍非空(executed 语义不变)、toolCallId 不变。
    expect(part.output.length).toBeGreaterThan(0);
    expect(part.toolCallId).toBe("mixed");
  });

  test("摘要行(含工具 part)整条豁免", () => {
    const summary = message("USER", [
      { type: "text", text: `<context_summary>\n${"字".repeat(200)}\n</context_summary>` },
      toolPart("in-summary", [{ type: "text", text: "字".repeat(60_000) }]),
    ]);
    const messages = [summary, textMsg("USER", "a"), textMsg("USER", "b"), textMsg("USER", "c")];
    const result = emergencyTruncateToolOutputs(messages, { windowTokens: 1_000 });
    expect(result.messages).toBe(messages);
    expect(result.truncatedParts).toBe(0);
  });
});

describe("latch:逐字节重放与钉住摘除", () => {
  const round1Messages = () => [
    textMsg("USER", "始"),
    toolMsg("big", "字".repeat(60_000)),
    textMsg("USER", "a"),
    textMsg("USER", "b"),
    textMsg("USER", "c"),
  ];

  test("后续轮即使不再超阈值,也重放同一份截断(前缀逐字节稳定)", () => {
    const messages = round1Messages();
    const first = emergencyTruncateToolOutputs(messages, { windowTokens: 60_000 });
    expect(first.newlyTruncatedParts).toBe(1);
    const truncatedText = outputText(first.messages[1]!);

    // 追加一条新消息 + 换成极大窗口(本轮完全不超线)。
    const next = [...messages, textMsg("USER", "新一轮")];
    const second = emergencyTruncateToolOutputs(next, { windowTokens: 1_000_000 });
    expect(second.newlyTruncatedParts).toBe(0);
    expect(second.truncatedParts).toBe(1);
    expect(outputText(second.messages[1]!)).toBe(truncatedText);
    // 新追加的消息不受影响。
    expect(textFromParts(second.messages[5]!.parts)).toBe("新一轮");
  });

  test("同一轮重复调用产物逐字节相同(幂等)", () => {
    const messages = round1Messages();
    const first = emergencyTruncateToolOutputs(messages, { windowTokens: 60_000 });
    const again = emergencyTruncateToolOutputs(messages, { windowTokens: 60_000 });
    expect(again.newlyTruncatedParts).toBe(0);
    expect(JSON.stringify(again.messages)).toBe(JSON.stringify(first.messages));
  });

  test("用户钉住该消息 → 摘除 latch key,原文恢复", () => {
    const messages = round1Messages();
    const first = emergencyTruncateToolOutputs(messages, { windowTokens: 60_000 });
    expect(first.truncatedParts).toBe(1);
    const pinned = { ...messages[1]!, annotations: [{ type: "pinned" }] as Message["annotations"] };
    const next = [messages[0]!, pinned, ...messages.slice(2)];
    const second = emergencyTruncateToolOutputs(next, { windowTokens: 60_000 });
    expect(second.truncatedParts).toBe(0);
    expect(outputText(second.messages[1]!)).toBe("字".repeat(60_000));
  });

  test("原文被编辑变短后旧截断不再成立 → 摘除 key,不产出更长的替换", () => {
    const messages = round1Messages();
    emergencyTruncateToolOutputs(messages, { windowTokens: 60_000 });
    // 同 id 同 callId,但原文只剩 100 字(用户编辑过)。
    const edited = { ...messages[1]!, parts: [toolPart("big", [{ type: "text", text: "字".repeat(100) }])] };
    const next = [messages[0]!, edited, ...messages.slice(2)];
    const result = emergencyTruncateToolOutputs(next, { windowTokens: 60_000 });
    expect(outputText(result.messages[1]!)).toBe("字".repeat(100));
    expect(result.truncatedParts).toBe(0);
  });
});

describe("enrichMessages 接入(常开,不受预算开关门控)", () => {
  const assistant = {
    id: "a1",
    chatModelId: null,
    name: "A",
    systemPrompt: "",
    contextMessageLimit: 0,
    messageTemplate: "{{ message }}",
    enableTimeReminder: false,
    allowConversationPromptInjection: false,
    modeInjectionIds: [],
    lorebookIds: [],
    enabledSkills: [],
    mcpServers: [],
    localTools: [],
  } as unknown as Assistant;
  const conversation = {
    id: "conv-1",
    assistantId: "a1",
    messages: [],
    modeInjectionIds: [],
    lorebookIds: [],
    engineCompactions: null,
  } as unknown as Conversation;
  const model = { id: "m1" } as never;

  const fixture = () => [
    textMsg("USER", "始"),
    toolMsg("big", "字".repeat(60_000)),
    textMsg("USER", "a"),
    textMsg("USER", "b"),
    textMsg("USER", "c"),
  ];

  test("不传预算/老化,只传应急窗口 → 仍然截断(D6 闭合)", () => {
    const messages = fixture();
    const result = enrichMessages(messages, {
      conversation,
      assistant,
      model,
      emergencyWindowTokens: 60_000,
    });
    expect(result.emergencyTruncatedParts).toBe(1);
    expect(result.emergencySavedTokens).toBeGreaterThan(0);
    expect(result.agedToolParts).toBe(0);
    expect(result.windowStart).toBe(0);
    expect(textFromParts(result.messages[1]!.parts)).toBe("");
    expect(outputText(result.messages[1]!)).toContain(MARKER);
    // 原文零改动。
    expect(outputText(messages[1]!)).toBe("字".repeat(60_000));
  });

  test("不传应急窗口 → 逐字节旧行为(计数全 0)", () => {
    const messages = fixture();
    const result = enrichMessages(messages, { conversation, assistant, model });
    expect(result.emergencyTruncatedParts).toBe(0);
    expect(result.emergencySavedTokens).toBe(0);
    expect(outputText(result.messages[1]!)).toBe("字".repeat(60_000));
  });

  test("老化在前、应急截断在后:两者同时开启不互相污染", () => {
    const messages = fixture();
    const result = enrichMessages(messages, {
      conversation,
      assistant,
      model,
      toolAging: { keepTurns: 0, excerptChars: 20 },
      emergencyWindowTokens: 60_000,
    });
    // 老化已把 60000 字折成短占位 → 应急截断不再把它当候选(严格更短不成立)。
    expect(result.agedToolParts).toBe(1);
    expect(result.emergencyTruncatedParts).toBe(0);
    expect(outputText(result.messages[1]!)).toContain("[tool output omitted:");
  });
});

// S4b(2026-11-20 实机验收纠正):预算头切必须跑在应急截断**之后**。
// 头切删的是整条消息,截断只把超大工具输出缩成头尾 + 标记。先头切时,一条本可缩到
// 几千 token 的工具消息会被整条丢掉(连同为凑预算而牺牲的更早历史);先截断则同样
// 占用下保住全部消息。下面用"预算 10000 / 原始 60005 token / 截断后约 4055 token"
// 把这条例外钉成断言:旧顺序窗口只剩 3 条且工具行消失,新顺序 5 条全在。
describe("S4b 应急截断先于预算头切", () => {
  const assistant = {
    id: "a1",
    chatModelId: null,
    name: "A",
    systemPrompt: "",
    contextMessageLimit: 0,
    messageTemplate: "{{ message }}",
    enableTimeReminder: false,
    allowConversationPromptInjection: false,
    modeInjectionIds: [],
    lorebookIds: [],
    enabledSkills: [],
    mcpServers: [],
    localTools: [],
  } as unknown as Assistant;
  const conversation = {
    id: "conv-1",
    assistantId: "a1",
    messages: [],
    modeInjectionIds: [],
    lorebookIds: [],
    engineCompactions: null,
  } as unknown as Conversation;
  const model = { id: "m1" } as never;

  const fixture = () => [
    textMsg("USER", "始"),
    toolMsg("big", "字".repeat(60_000)),
    textMsg("USER", "a"),
    textMsg("USER", "b"),
    textMsg("USER", "c"),
  ];

  test("预算装得下截断产物、装不下原文 → 五条全保,工具行带标记留在原位", () => {
    const messages = fixture();
    const result = enrichMessages(messages, {
      conversation,
      assistant,
      model,
      contextBudget: { tokens: 10_000 },
      emergencyWindowTokens: 60_000,
    });
    expect(result.emergencyTruncatedParts).toBe(1);
    expect(result.windowStart).toBe(0);
    expect(result.messages.length).toBe(5);
    expect(outputText(result.messages[1]!)).toContain(MARKER);
    expect(totalOf(result.messages)).toBeLessThanOrEqual(10_000);
    // 原文零改动(只增不删红线)。
    expect(outputText(messages[1]!)).toBe("字".repeat(60_000));
  });

  test("预算连截断产物也装不下 → 头切照常兜底,不会为了保消息而越预算", () => {
    const messages = fixture();
    const result = enrichMessages(messages, {
      conversation,
      assistant,
      model,
      contextBudget: { tokens: 1_000 },
      emergencyWindowTokens: 60_000,
    });
    expect(result.emergencyTruncatedParts).toBe(1);
    expect(result.windowStart).toBe(2);
    expect(result.messages.length).toBe(3);
    expect(totalOf(result.messages)).toBeLessThanOrEqual(1_000);
  });

  test("老化 → 截断 → 头切 三级同开:老化已折叠则截断不参与,预算按折叠后体积裁决", () => {
    const messages = fixture();
    const result = enrichMessages(messages, {
      conversation,
      assistant,
      model,
      toolAging: { keepTurns: 0, excerptChars: 20 },
      contextBudget: { tokens: 10_000 },
      emergencyWindowTokens: 60_000,
    });
    expect(result.agedToolParts).toBe(1);
    expect(result.emergencyTruncatedParts).toBe(0);
    expect(result.windowStart).toBe(0);
    expect(result.messages.length).toBe(5);
    expect(outputText(result.messages[1]!)).toContain("[tool output omitted:");
  });

  test("压缩锚之前的历史不抬高占用:锚后只有三条短消息 → 不触发截断", () => {
    const messages = fixture();
    const result = enrichMessages(messages, {
      conversation,
      assistant,
      model,
      windowStartMessageId: messages[2]!.id,
      contextBudget: { tokens: 10_000 },
      emergencyWindowTokens: 60_000,
    });
    // 全量 60005 token 远超 95% 触发线,但锚已把那条巨型工具输出排除在结构窗口外。
    expect(result.emergencyTruncatedParts).toBe(0);
    expect(result.windowStart).toBe(2);
    expect(result.messages.length).toBe(3);
    expect(outputText(messages[1]!)).toBe("字".repeat(60_000));
  });
});