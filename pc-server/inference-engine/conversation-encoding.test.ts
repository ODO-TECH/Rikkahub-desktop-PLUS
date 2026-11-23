// inference-engine/conversation-encoding.test.ts — 编码层窗口/校准装配的边界契约
//
// 存在的理由(S4 落地时踩到的真回归):`findModel` 在"一个供应商都没配"时回退到
// `{ provider: undefined, model: Auto }`。窗口、预留、k̂ 全都要解引用 provider——
// 这些计算原先躲在 `contextBudget.enabled` 的闭包里,预算关着就永远不执行;S4 把应急
// 截断改成常开后把它们提到了闭包外,零供应商配置下直接 TypeError 炸掉整条编码路径。
// 本文件把"无供应商也必须是合法状态"钉死:护栏算不出窗口就**不参与**,而不是崩。

import { afterAll, describe, expect, test, beforeEach } from "bun:test";
import type { Assistant, Conversation, Message, State, ToolPart } from "../foundation/types";
import { message, textFromParts } from "../foundation/utils";
import { setState } from "../persistence/json-store";
import { contextCalibrationFactor, conversationTransformedMessages } from "./conversation-encoding";
import { invalidateContextSnapshots } from "./context-snapshots";
import { resetEmergencyTruncateLatch } from "./emergency-truncate";

function assistant(overrides: Partial<Assistant> = {}): Assistant {
  return {
    id: "a1",
    chatModelId: null,
    name: "A",
    systemPrompt: "",
    contextMessageLimit: 0,
    messageTemplate: "{{ message }}",
    enableTimeReminder: false,
    allowConversationPromptInjection: false,
    allowConversationSystemPrompt: false,
    modeInjectionIds: [],
    lorebookIds: [],
    enabledSkills: [],
    mcpServers: [],
    localTools: [],
    maxTokens: null,
    ...overrides,
  } as unknown as Assistant;
}

function node(id: string, msg: Message) {
  return { id: `node-${id}`, selectIndex: 0, messages: [msg] };
}

function conversationOf(id: string, messages: Message[]): Conversation {
  return {
    id,
    assistantId: "a1",
    systemPrompt: null,
    title: "",
    messages: messages.map((msg) => node(msg.id, msg)),
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 2,
    modeInjectionIds: [],
    lorebookIds: [],
    workspaceId: null,
    workspaceCwd: null,
    engineCompactions: null,
  } as unknown as Conversation;
}

function toolMsg(callId: string, text: string): Message {
  return message("ASSISTANT", [
    {
      type: "tool",
      toolCallId: callId,
      toolName: "read_file",
      input: "{}",
      output: [{ type: "text", text }],
      approvalState: { type: "auto" },
    } as ToolPart,
  ]);
}

function outputText(msg: Message): string {
  const part = msg.parts.find((item) => item.type === "tool") as ToolPart | undefined;
  if (!part) return textFromParts(msg.parts);
  return part.output.map((entry) => (entry.type === "text" ? String(entry.text ?? "") : "")).join("");
}

/** 零供应商配置:providers 空数组 → findModel 回退 { provider: undefined, model: Auto }。
 *  其余字段按编码层真实读取面给齐(memorySettings 等缺一个就会在 frozenContextBlocks 里炸,
 *  那是夹具不完整,不是被测行为)。 */
function setNoProviders(contextBudget?: Record<string, unknown>) {
  setState({
    settings: {
      assistants: [],
      providers: [],
      chatModelId: "m1",
      displaySetting: { userNickname: "T" },
      lorebooks: [],
      modeInjections: [],
      memorySettings: { globalEnabled: false, writeStrategy: "ask" },
      memoryVectorSettings: { enabled: false, autoIndex: false },
      memoryExperimentSettings: { enabled: false },
      ...(contextBudget ? { contextBudget } : {}),
    },
  } as unknown as State);
  invalidateContextSnapshots();
}

beforeEach(() => {
  resetEmergencyTruncateLatch();
  setNoProviders();
});

afterAll(() => invalidateContextSnapshots());

describe("零供应商配置(findModel 回退 Auto,provider=undefined)", () => {
  test("conversationTransformedMessages 不抛错,消息逐字保留", () => {
    const conv = conversationOf("c1", [
      message("USER", [{ type: "text", text: "你好" }]),
      message("ASSISTANT", [{ type: "text", text: "你好呀" }]),
    ]);
    const result = conversationTransformedMessages(conv, assistant());
    expect(result.messages.map((msg) => textFromParts(msg.parts))).toEqual(["你好", "你好呀"]);
  });

  test("contextCalibrationFactor = 1(无键即无样本,不是崩)", () => {
    expect(contextCalibrationFactor(assistant())).toBe(1);
  });

  test("巨型工具输出原样保留:算不出窗口就不参与应急截断(不猜)", () => {
    const big = toolMsg("big", "字".repeat(60_000));
    const conv = conversationOf("c2", [
      message("USER", [{ type: "text", text: "始" }]),
      big,
      message("USER", [{ type: "text", text: "a" }]),
      message("USER", [{ type: "text", text: "b" }]),
      message("USER", [{ type: "text", text: "c" }]),
    ]);
    const result = conversationTransformedMessages(conv, assistant());
    const encodedBig = result.messages.find((msg) => msg.id === big.id)!;
    expect(outputText(encodedBig)).toBe("字".repeat(60_000));
    expect(outputText(encodedBig)).not.toContain("[truncated for context space");
  });

  test("预算开关开着也不抛错(effectiveWindow=null → 预算路同样不参与)", () => {
    setNoProviders({ enabled: true, toolAgingEnabled: true, toolAgingKeepTurns: 0, toolAgingExcerptChars: 20 });
    const big = toolMsg("big", "字".repeat(60_000));
    const conv = conversationOf("c3", [
      message("USER", [{ type: "text", text: "始" }]),
      big,
      message("USER", [{ type: "text", text: "a" }]),
      message("USER", [{ type: "text", text: "b" }]),
      message("USER", [{ type: "text", text: "c" }]),
    ]);
    const result = conversationTransformedMessages(conv, assistant());
    // 老化不依赖窗口,照常生效;预算/应急截断依赖窗口,静默跳过。
    expect(outputText(result.messages.find((msg) => msg.id === big.id)!)).toContain("[tool output omitted:");
  });
});