// inference-engine/tool-declaration-tokens.test.ts — 工具声明计费(S1)
//
// 工具 schema 不在消息序列里:数消息永远数不到它。挂满 MCP 的助手光声明就能占上万
// token,漏算会让自动压缩在真实窗口早已见底时仍不触发,最后撞 400。
// 本文件锁定 toolDeclarationTokens 是"预算 fixedTokens"与"自动压缩触发估算"的唯一口径。

import { afterAll, describe, expect, test } from "bun:test";
import type { Assistant, Model, State } from "../foundation/types";
import { estimateTokens } from "../foundation/utils";
import { setState, state } from "../persistence/json-store";
import { conversationFunctionTools } from "../tools/bound";
import { conversationToolsWithDiscovery } from "../tools/discovery-store";
import { toolDeclarationTokens } from "./conversation-encoding";

const priorState = state;

const BIG_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "搜索关键词".repeat(40) },
    limit: { type: "integer", description: "返回条数上限,默认 20,最大 100。" },
  },
  required: ["query"],
};

function installFixture(): void {
  setState({
    settings: {
      enableWebSearch: false,
      mcpServers: [
        {
          id: "srv",
          type: "http",
          commonOptions: {
            name: "Big MCP",
            enable: true,
            tools: Array.from({ length: 12 }, (_, index) => ({
              name: `tool_${index}`,
              description: `第 ${index} 个工具,用于演示声明体积。`,
              inputSchema: BIG_SCHEMA,
            })),
          },
        },
      ],
      memorySettings: { globalEnabled: false, writeStrategy: "ask", dedupEnabled: false, memoryModelThinkingEnabled: false },
      subagent: { enabled: false },
      workspaceTools: {},
      displaySetting: { planPanel: false },
    },
  } as unknown as State);
}

function assistantFixture(overrides: Partial<Assistant> = {}): Assistant {
  return {
    id: "a1",
    mcpServers: ["srv"],
    mcpToolOverrides: {},
    localTools: [],
    enabledSkills: [],
    enableMemory: false,
    memoryWriteScope: "readonly",
    enableToolDiscovery: false,
    ...overrides,
  } as unknown as Assistant;
}

const toolModel = { modelId: "m-tool", abilities: ["TOOL"] } as unknown as Model;
const plainModel = { modelId: "m-plain", abilities: [] } as unknown as Model;

afterAll(() => setState(priorState));

describe("toolDeclarationTokens", () => {
  test("模型不支持 TOOL → 0(出线 tools 为空,与四处装配同判定)", () => {
    installFixture();
    expect(toolDeclarationTokens(assistantFixture(), plainModel, "c1")).toBe(0);
  });

  test("支持 TOOL → 等于出线工具数组 JSON 的估算,且远大于 0", () => {
    installFixture();
    const assistant = assistantFixture();
    const tools = conversationToolsWithDiscovery(assistant, toolModel, "c1");
    const tokens = toolDeclarationTokens(assistant, toolModel, "c1");
    expect(tokens).toBe(estimateTokens(JSON.stringify(tools)));
    // 12 个带中文长描述的工具:声明体积必须是"看得见"的量级,不是几十 token。
    expect(tokens).toBeGreaterThan(1000);
  });

  test("工具发现开启 → 只算本轮真正携带的声明,不按全池虚高", () => {
    installFixture();
    const assistant = assistantFixture({ enableToolDiscovery: true });
    const full = estimateTokens(JSON.stringify(conversationFunctionTools(assistant, toolModel)));
    const actual = toolDeclarationTokens(assistant, toolModel, "tool-decl-c1");
    expect(actual).toBeGreaterThan(0);
    expect(actual).toBeLessThan(full);
  });

  test("没有任何工具 → 0(不产生 JSON 空数组的噪声计费)", () => {
    installFixture();
    const bare = assistantFixture({ mcpServers: [] });
    expect(toolDeclarationTokens(bare, toolModel, "c1")).toBe(0);
  });
});