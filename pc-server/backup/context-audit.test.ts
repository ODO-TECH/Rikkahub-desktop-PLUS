// backup/context-audit.test.ts — 导入体积体检(S5)契约测试
//
// 锁定:只读体检、按 estTokens 倒序、窗口未知时按 200K 绝对阈值判定、
// 警告文案只在确有 overWindow 会话时出现。体检不改任何会话字段。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-context-audit-"));

const jsonStore = await import("../persistence/json-store");
const { auditConversationContext, buildImportWarnings, newImportReport } = await import("./import");
const { message } = await import("../foundation/utils");

import type { Conversation, State } from "../foundation/types";

const priorState = jsonStore.state;

beforeAll(() => {
  jsonStore.setState({
    settings: {
      displaySetting: { userNickname: "Audit" },
      assistants: [{ id: "a1", chatModelId: null }],
      providers: [],
      chatModelId: "auto",
      lorebooks: [],
      modeInjections: [],
    },
  } as unknown as State);
});

afterAll(() => {
  jsonStore.setState(priorState);
  try { rmSync(process.env.RIKKAHUB_PC_DATA_DIR!, { recursive: true, force: true }); } catch { /* 句柄仍在 */ }
});

function conversation(id: string, title: string, charCount: number): Conversation {
  return {
    id,
    assistantId: "a1",
    systemPrompt: null,
    title,
    messages: [
      { id: `${id}-n`, selectIndex: 0, messages: [message("USER", [{ type: "text", text: "字".repeat(charCount) }])] },
    ],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 2,
  };
}

describe("导入体积体检", () => {
  test("按 estTokens 倒序,窗口未知时 200K 以上标记 overWindow", () => {
    const small = conversation("c-small", "小会话", 200);
    const large = conversation("c-large", "大会话", 250_000); // ≈225K tokens
    const entries = auditConversationContext([small, large]);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.conversationId).toBe("c-large");
    expect(entries[0]!.overWindow).toBe(true);
    expect(entries[0]!.estTokens).toBeGreaterThan(200_000);
    expect(entries[1]!.overWindow).toBe(false);
    expect(entries[1]!.bytes).toBeGreaterThan(0);
  });

  test("体检不改会话数据", () => {
    const conv = conversation("c-keep", "保持原样", 100);
    const before = JSON.stringify(conv);
    auditConversationContext([conv]);
    expect(JSON.stringify(conv)).toBe(before);
  });

  test("警告只在有 overWindow 会话时出现", () => {
    const report = newImportReport();
    expect(buildImportWarnings(report)).toEqual([]);
    report.contextAudit = auditConversationContext([conversation("c-large", "大会话", 250_000)]);
    const warnings = buildImportWarnings(report);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("超过模型上下文窗口");
    expect(warnings[0]).toContain("大会话");
    expect(warnings[0]).toContain("上下文预算");
  });
});
