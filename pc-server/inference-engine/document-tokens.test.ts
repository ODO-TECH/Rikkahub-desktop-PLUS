// 压缩 v2 · 落地后记 12 的洞已补:document part 的抽取全文必须进**存储态**计费。
// 钉两件事:① 计费口径与出站展开逐字同源(不各写一份);② 只读已有缓存,绝不触发抽取。
// 注意:extractedTextPath 固定指向运行时 filesDir,单测用真实 filesDir 下的高位假 id,
// 结束后清理(与 files/extracted-text-sidecar.test.ts 同一手法,避开可注入目录参数)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";

import type { DocumentPart, MessagePart, State, StoredFile, ToolPart } from "../foundation/types";
import { estimateTokens, message } from "../foundation/utils";
import { setState } from "../persistence/json-store";
import { extractedTextPath, fallbackDocumentText, writeExtractedTextSidecar } from "../files/index";
import { contextTokensOf } from "./context-budget";
import { documentTokensForPart, resetDocumentTokenCache } from "./document-tokens";
import { contentPartsForApi, documentPromptText } from "./message-builder";

const TEST_ID = 987654322;
const URL = `/api/files/${TEST_ID}/content`;
const FILE_NAME = "报告.pdf";

function entry(extractedText?: string): StoredFile {
  return { id: TEST_ID, path: "", fileName: FILE_NAME, mime: "application/pdf", size: 1, extractedText };
}

function docPart(): DocumentPart {
  return { type: "document", url: URL, fileName: FILE_NAME, mime: "application/pdf" };
}

function useFiles(files: StoredFile[]) {
  setState({
    files,
    settings: {
      displaySetting: { userNickname: "Test User" },
      lorebooks: [],
      modeInjections: [],
      chatModelId: "m1",
    },
  } as unknown as State);
}

beforeEach(() => {
  resetDocumentTokenCache();
  rmSync(extractedTextPath(TEST_ID), { force: true });
  useFiles([entry()]);
});

afterAll(() => {
  rmSync(extractedTextPath(TEST_ID), { force: true });
});

describe("document 计费口径(存储态 == 出站展开)", () => {
  test("旁车有全文 → 与 contentPartsForApi 展开后的文本逐字同口径,且远大于旧口径的 0", () => {
    const text = "文档全文段落。".repeat(400); // 纯 CJK + 全角句号 → 1 字 1 token
    writeExtractedTextSidecar(TEST_ID, text);
    const parts: MessagePart[] = [docPart()];
    const expected = estimateTokens(documentPromptText(FILE_NAME, text));

    expect(documentTokensForPart(docPart())).toBe(expected);
    expect(contextTokensOf(message("USER", parts))).toBe(expected);
    expect(expected).toBeGreaterThan(2000);

    // 出站侧真实展开(有全文时不会触发后台补抽),两侧必须是同一个数。
    const wire = contentPartsForApi(parts);
    expect(wire.length).toBe(1);
    expect(estimateTokens(String((wire[0] as { text?: unknown }).text ?? ""))).toBe(expected);
  });

  test("无抽取缓存 → 按 fallbackDocumentText 体积计(那正是本轮会发出去的文本),不是 0", () => {
    const expected = estimateTokens(fallbackDocumentText({ fileName: FILE_NAME, url: URL, entry: entry() }));
    expect(expected).toBeGreaterThan(0);
    expect(documentTokensForPart(docPart())).toBe(expected);
    expect(contextTokensOf(message("USER", [docPart()]))).toBe(expected);
    // 只读纪律:计费不得同步抽取、不得留下旁车文件、不得抛。
    expect(existsSync(extractedTextPath(TEST_ID))).toBe(false);
  });

  test("迁移窗口的老内存字段兜底(无旁车时 readExtractedTextSync 的语义)", () => {
    useFiles([entry("旧全文内容")]);
    const expected = estimateTokens(documentPromptText(FILE_NAME, "旧全文内容"));
    expect(documentTokensForPart(docPart())).toBe(expected);
  });

  test("文件条目丢失 / 空 url → 降级为 missing 占位体积,绝不抛", () => {
    useFiles([]);
    const missing = estimateTokens(fallbackDocumentText({ fileName: FILE_NAME, url: URL, entry: null }));
    expect(documentTokensForPart(docPart())).toBe(missing);
    expect(documentTokensForPart({ type: "document", url: "", fileName: FILE_NAME })).toBe(
      estimateTokens(fallbackDocumentText({ fileName: FILE_NAME, url: "", entry: null })),
    );
  });

  test("重抽后缓存自动失效:键带旁车 mtime+size,新版本必须重算", () => {
    writeExtractedTextSidecar(TEST_ID, "甲".repeat(100));
    const first = documentTokensForPart(docPart());
    expect(first).toBe(estimateTokens(documentPromptText(FILE_NAME, "甲".repeat(100))));

    writeExtractedTextSidecar(TEST_ID, "乙".repeat(300));
    const second = documentTokensForPart(docPart());
    expect(second).toBe(estimateTokens(documentPromptText(FILE_NAME, "乙".repeat(300))));
    expect(second).toBeGreaterThan(first);
  });

  test("同版本重复调用命中 memoize(结果稳定,reset 后重算同值)", () => {
    writeExtractedTextSidecar(TEST_ID, "稳定全文".repeat(50));
    const first = documentTokensForPart(docPart());
    expect(documentTokensForPart(docPart())).toBe(first);
    resetDocumentTokenCache();
    expect(documentTokensForPart(docPart())).toBe(first);
  });

  test("工具输出里的 document 同样计入(ToolOutputEntry 也是 MessagePart)", () => {
    const text = "工具产出的文档正文。".repeat(200);
    writeExtractedTextSidecar(TEST_ID, text);
    const tool: ToolPart = {
      type: "tool",
      toolCallId: "c1",
      toolName: "read_file",
      input: "{}",
      output: [docPart()],
      approvalState: { type: "auto" },
    };
    const expected = estimateTokens(documentPromptText(FILE_NAME, text)) + estimateTokens("{}");
    expect(contextTokensOf(message("ASSISTANT", [tool]))).toBe(expected);
  });
});