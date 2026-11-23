// inference-engine/context-budget.test.ts — 上下文预算与工具输出老化契约测试
//
// 锁定:
//   - 单条/整会话 token 估算口径(正文 + 工具输入输出 + 可选 reasoning);
//   - 预算窗口起点:超预算才切、回撤 10% 留头(追加少量消息不抖)、至少留最后一条;
//   - 工具老化:只折叠过旧结果、占位仍在 output 内(executed 语义不变)、error/pending/
//     钉住消息逐字保留、原文对象零改动;
//   - enrichMessages 接入:预算起点与压缩锚/滞回取 max 后仍过 alignContextStart,
//     不产生"无 call 的孤儿 result";关闭时 windowStart/agedToolParts 全为 0。

import { describe, expect, test, beforeAll } from "bun:test";
import type { Assistant, Conversation, JsonValue, Message, State, ToolOutputEntry, ToolPart } from "../foundation/types";
import { estimateTokens, message, textFromParts } from "../foundation/utils";
import { setState } from "../persistence/json-store";
import { ageToolOutputs, budgetStartFor, contextTokensOf, conversationTokens } from "./context-budget";
import { alignContextStart, enrichMessages } from "./message-enrichment";
import { contextFitError } from "../conversations/auto-compaction";
import { IMAGE_TOKENS_REMOTE, imageTokensFromDimensions } from "./image-tokens";

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

function assistant(overrides: Partial<Assistant> = {}): Assistant {
  return {
    id: "a1",
    chatModelId: null,
    name: "Test Assistant",
    avatar: { type: "dummy" },
    useAssistantAvatar: false,
    tags: [],
    systemPrompt: "You are helpful.",
    temperature: null,
    topP: null,
    contextMessageLimit: 0,
    streamOutput: true,
    enableMemory: false,
    useGlobalMemory: false,
    enableRecentChatsReference: false,
    messageTemplate: "{{ message }}",
    presetMessages: [],
    quickMessageIds: [],
    regexes: [],
    reasoningLevel: "AUTO",
    maxTokens: null,
    customHeaders: [],
    customBodies: [],
    mcpServers: [],
    mcpToolOverrides: {},
    localTools: [],
    background: null,
    backgroundOpacity: 1,
    modeInjectionIds: [],
    lorebookIds: [],
    enabledSkills: [],
    enableTimeReminder: false,
    allowConversationSystemPrompt: false,
    allowConversationPromptInjection: false,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    assistantId: "a1",
    systemPrompt: null,
    title: "",
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    modeInjectionIds: [],
    lorebookIds: [],
    workspaceId: null,
    workspaceCwd: null,
    engineCompactions: null,
    ...overrides,
  };
}

function textMessage(role: "USER" | "ASSISTANT", text: string): Message {
  return message(role, [{ type: "text", text }]);
}

function toolMessage(options: {
  callId: string;
  output?: "text" | "error" | "pending" | "none";
  text?: string;
  /** 追加到 output 末尾的额外条目(图片等非文本结果)。 */
  extraOutput?: ToolOutputEntry[];
}): Message {
  const output: ToolOutputEntry[] = (() => {
    switch (options.output ?? "text") {
      case "none": return [];
      case "error": return [{ error: "boom: upstream 500" }];
      case "pending": return [{ pending: true, questions: [] }];
      default: return [{ type: "text" as const, text: options.text ?? "结果正文" }];
    }
  })();
  if (options.extraOutput) output.push(...options.extraOutput);
  return message("ASSISTANT", [
    {
      type: "tool",
      toolCallId: options.callId,
      toolName: "read_file",
      input: `{"path":"${options.callId}.txt"}`,
      output,
      approvalState: { type: "auto" },
    },
  ]);
}

function firstToolPart(msg: Message): ToolPart {
  const part = msg.parts.find((item) => item.type === "tool");
  if (!part) throw new Error("message has no tool part");
  return part as ToolPart;
}

describe("contextTokensOf", () => {
  test("统计正文 + 工具输入输出,reasoning 可选", () => {
    const msg = message("ASSISTANT", [
      { type: "text", text: "正文正文" },
      {
        type: "tool",
        toolCallId: "c1",
        toolName: "read_file",
        input: "x".repeat(400),
        output: [{ type: "text", text: "y".repeat(800) }],
        approvalState: { type: "auto" },
      },
      { type: "reasoning", reasoning: "z".repeat(400) },
    ]);
    const withoutReasoning = contextTokensOf(msg);
    const withReasoning = contextTokensOf(msg, { reasoning: true });
    expect(withoutReasoning).toBeGreaterThan(0);
    expect(withReasoning).toBeGreaterThan(withoutReasoning);
    expect(withReasoning - withoutReasoning).toBe(estimateTokens("z".repeat(400)));
  });

  test("conversationTokens 覆盖全部消息", () => {
    const messages = [textMessage("USER", "a".repeat(100)), toolMessage({ callId: "c1", text: "b".repeat(200) })];
    expect(conversationTokens(messages)).toBe(
      messages.reduce((sum, msg) => sum + contextTokensOf(msg, { reasoning: true }), 0),
    );
  });

  test("图片计入 tile 成本(旧口径计 0,贴图会话因此永不触发自动压缩)", () => {
    // 1×1 PNG 头:短边升 768 → 4 块 → 85+170×4。
    const png = Buffer.alloc(24);
    png[0] = 0x89;
    png.write("PNG", 1, "latin1");
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    const url = `data:image/png;base64,${png.toString("base64")}`;
    const withImage = message("USER", [{ type: "text", text: "看图" }, { type: "image", url }]);
    const textOnly = message("USER", [{ type: "text", text: "看图" }]);
    expect(contextTokensOf(withImage) - contextTokensOf(textOnly)).toBe(imageTokensFromDimensions(1, 1));
  });

  test("工具输出里的图片同样计入", () => {
    const url = "https://example.com/shot.png";
    const withImage = toolMessage({ callId: "c1", text: "ok", extraOutput: [{ type: "image", url }] });
    const plain = toolMessage({ callId: "c1", text: "ok" });
    expect(contextTokensOf(withImage) - contextTokensOf(plain)).toBe(IMAGE_TOKENS_REMOTE);
  });

  test("OCR 旁注计入(非视觉模型实际吃的就是这段文本)", () => {
    const ocrText = "识别出来的文字".repeat(10);
    const withOcr = message("USER", [
      { type: "image", url: "https://example.com/a.png", metadata: { ocrText } },
    ]);
    const plain = message("USER", [{ type: "image", url: "https://example.com/a.png" }]);
    expect(contextTokensOf(withOcr) - contextTokensOf(plain)).toBe(estimateTokens(ocrText));
  });
});

describe("budgetStartFor", () => {
  const build = (count: number, charCount: number) =>
    Array.from({ length: count }, (_, index) => textMessage(index % 2 === 0 ? "USER" : "ASSISTANT", "字".repeat(charCount)));

  test("预算无效或在预算内 → 0(全量)", () => {
    const messages = build(4, 100);
    expect(budgetStartFor(messages, 0)).toBe(0);
    expect(budgetStartFor(messages, 10_000_000)).toBe(0);
  });

  test("超预算时保留尾部且总量不超过预算", () => {
    const messages = build(30, 400); // 每条约 360 token
    const budget = 1200;
    const start = budgetStartFor(messages, budget);
    expect(start).toBeGreaterThan(0);
    const retained = messages.slice(start).reduce((sum, msg) => sum + contextTokensOf(msg, { reasoning: true }), 0);
    expect(retained).toBeLessThanOrEqual(budget);
  });

  test("回撤留头:追加少量消息不会每轮挪动起点", () => {
    const messages = build(30, 400);
    const budget = 1200;
    const start = budgetStartFor(messages, budget);
    // 追加约 5% 预算的新消息 → 起点不变(10% 滞回余量吸收)
    const appended = [...messages, textMessage("USER", "字".repeat(20))];
    expect(budgetStartFor(appended, budget)).toBe(start);
  });

  test("单条就超预算时至少保留最后一条", () => {
    const messages = [textMessage("USER", "字".repeat(4000)), textMessage("ASSISTANT", "字".repeat(4000))];
    expect(budgetStartFor(messages, 10)).toBe(1);
  });
});

describe("ageToolOutputs", () => {
  test("只老化最近 K 轮之外的结果,占位仍在 output 内", () => {
    const old = toolMessage({ callId: "old", text: "旧结果".repeat(500) });
    const recent = toolMessage({ callId: "recent", text: "新结果".repeat(10) });
    const messages = [textMessage("USER", "开始"), old, recent];
    const result = ageToolOutputs(messages, { keepTurns: 1, excerptChars: 50 });
    expect(result.agedParts).toBe(1);
    expect(result.agedBytes).toBeGreaterThan(0);

    const agedPart = firstToolPart(result.messages[1]!);
    expect(agedPart.output.length).toBe(1); // 仍非空:executed 语义不变
    expect(agedPart.output[0]!.type).toBe("text");
    const text = String((agedPart.output[0] as { text?: unknown }).text ?? "");
    expect(text).toContain("[tool output omitted: read_file");
    expect(text).toContain("bytes");

    const recentPart = firstToolPart(result.messages[2]!);
    expect(String((recentPart.output[0] as { text?: unknown }).text)).toBe("新结果".repeat(10));
    // 原文对象零改动
    expect(String((firstToolPart(old).output[0] as { text?: unknown }).text)).toBe("旧结果".repeat(500));
  });

  test("error / pending / 钉住消息逐字保留", () => {
    const withError = toolMessage({ callId: "err", output: "error" });
    const pending = toolMessage({ callId: "pending", output: "pending" });
    const pinned = toolMessage({ callId: "pinned", text: "钉住的结果" });
    pinned.annotations = [{ type: "pinned" } as JsonValue];
    const filler = toolMessage({ callId: "newest", text: "最新" });
    const result = ageToolOutputs([withError, pending, pinned, filler], { keepTurns: 1, excerptChars: 0 });
    expect(result.agedParts).toBe(0);
    expect(firstToolPart(result.messages[0]!).output[0]).toEqual({ error: "boom: upstream 500" });
    expect((firstToolPart(result.messages[1]!).output[0] as { pending?: unknown }).pending).toBe(true);
    expect(String((firstToolPart(result.messages[2]!).output[0] as { text?: unknown }).text)).toBe("钉住的结果");
  });

  test("纯 call(未执行)与无工具消息不受影响", () => {
    const pureCall = toolMessage({ callId: "call", output: "none" });
    const plain = textMessage("USER", "普通消息");
    const result = ageToolOutputs([pureCall, plain], { keepTurns: 0, excerptChars: 10 });
    expect(result.agedParts).toBe(0);
    expect(result.messages[0]).toBe(pureCall);
    expect(result.messages[1]).toBe(plain);
  });
});

describe("发送前硬闸(S4:常开 + 原生窗口口径)", () => {
  test("未超原生窗口 / 窗口未知 → 放行", () => {
    expect(contextFitError(1000, null)).toBeNull();
    expect(contextFitError(1000, 8192)).toBeNull();
    // 旧口径拿 window − 16384 当硬线,32768 窗口下 26000 就被误杀;现在放行。
    expect(contextFitError(26_000, 32_768)).toBeNull();
    // 边界:恰好等于窗口放行,多 1 才拒。
    expect(contextFitError(32_768, 32_768)).toBeNull();
    expect(contextFitError(32_769, 32_768)).not.toBeNull();
  });

  test("超原生窗口 → 返回含体积与建议动作的错误文案", () => {
    const message = contextFitError(50_000, 32_768);
    expect(message).not.toBeNull();
    expect(message).toContain("超过模型窗口上限");
    expect(message).toContain("50K");
    expect(message).toContain("33K");
    // 常开之后不该再让用户去开某个开关——建议动作必须是压缩/换模型。
    expect(message).toContain("手动压缩");
    expect(message).not.toContain("上下文预算");
  });
});

describe("enrichMessages 接入", () => {
  test("未传预算/老化时 windowStart 与 aged 全为 0(引入前行为)", () => {
    const messages = [textMessage("USER", "你好"), textMessage("ASSISTANT", "你好呀")];
    const result = enrichMessages(messages, { conversation: conversation(), assistant: assistant(), model: { id: "m1" } as never });
    expect(result.windowStart).toBe(0);
    expect(result.agedToolParts).toBe(0);
    expect(result.messages.map((msg) => textFromParts(msg.parts))).toEqual(["你好", "你好呀"]);
  });

  test("预算切点落在工具链中间时回退到调用发起处(不产生孤儿 result)", () => {
    // user → assistant(纯 call) → tool result(已执行) ×3 → user
    const call = message("ASSISTANT", [
      { type: "tool", toolCallId: "c1", toolName: "read_file", input: "{}", output: [], approvalState: { type: "auto" } },
    ]);
    const results = Array.from({ length: 3 }, (_, index) =>
      toolMessage({ callId: `r${index}`, text: "字".repeat(600) }),
    );
    const tail = textMessage("USER", "继续");
    const messages = [textMessage("USER", "开始"), call, ...results, tail];
    // 预算只够最后一条附近 → 算术起点落后于的结果消息上,alignContextStart 必须回退到 call
    const result = enrichMessages(messages, {
      conversation: conversation(),
      assistant: assistant(),
      model: { id: "m1" } as never,
      contextBudget: { tokens: 300 },
    });
    expect(result.windowStart).toBeGreaterThan(0);
    // 启动路径 = 预算算术起点再经 alignContextStart 回退,两者必须一致。
    const expectedStart = alignContextStart(messages, budgetStartFor(messages, 300));
    expect(result.windowStart).toBe(expectedStart);
    const first = result.messages[0]!;
    // 起手消息不允许是"已执行但没有对应 call 在窗口内"的孤儿 result。
    const firstTool = first.parts.find((part) => part.type === "tool") as ToolPart | undefined;
    if (firstTool) expect(firstTool.output.length).toBe(0);
  });

  test("上下文边界锚(S7):从边界消息起保留;id 不在序列视为无边界", () => {
    const messages = [textMessage("USER", "一"), textMessage("ASSISTANT", "二"), textMessage("USER", "三")];
    const withBoundary = enrichMessages(messages, {
      conversation: conversation(),
      assistant: assistant(),
      model: { id: "m1" } as never,
      boundaryMessageId: messages[1]!.id,
    });
    expect(withBoundary.windowStart).toBe(1);
    expect(withBoundary.messages.map((msg) => textFromParts(msg.parts))).toEqual(["二", "三"]);

    const stale = enrichMessages(messages, {
      conversation: conversation(),
      assistant: assistant(),
      model: { id: "m1" } as never,
      boundaryMessageId: "missing-id",
    });
    expect(stale.windowStart).toBe(0);
  });

  test("工具老化开启时,旧结果在富化产物里折叠且窗口外原文不动", () => {
    const old = toolMessage({ callId: "old", text: "旧".repeat(1000) });
    const recent = toolMessage({ callId: "recent", text: "新" });
    const messages = [textMessage("USER", "开始"), old, recent, textMessage("USER", "问")];
    const result = enrichMessages(messages, {
      conversation: conversation(),
      assistant: assistant(),
      model: { id: "m1" } as never,
      toolAging: { keepTurns: 1, excerptChars: 20 },
    });
    expect(result.agedToolParts).toBe(1);
    expect(String((firstToolPart(old).output[0] as { text?: unknown }).text)).toBe("旧".repeat(1000));
  });
});
