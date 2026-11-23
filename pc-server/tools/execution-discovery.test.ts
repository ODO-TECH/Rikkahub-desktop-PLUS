// tools/execution-discovery.test.ts — S11 发现行的失败路径
// 覆盖:发现开启时调用已从实时池消失的 MCP 工具 → 明确错误并指向 search_tools;
// 发现关闭时保持 callMcpTool 既有语义(不新增行为差异);非 MCP 未知工具仍走原错误。
import { afterAll, describe, expect, test } from "bun:test";
import type { Assistant, State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { executeToolCall } from "./execution";

const priorState = state;

function installFixture(): void {
  setState({
    settings: {
      assistants: [],
      enableWebSearch: false,
      mcpServers: [
        {
          id: "srv",
          type: "http",
          commonOptions: {
            name: "GitHub",
            enable: true,
            tools: [{ name: "create_issue", description: "Create", inputSchema: { type: "object", properties: {} } }],
          },
        },
      ],
      memorySettings: { globalEnabled: false, writeStrategy: "ask", dedupEnabled: false, memoryModelThinkingEnabled: false },
      subagent: { enabled: false },
      workspaceTools: {},
    },
  } as unknown as State);
}

function assistantFixture(enableToolDiscovery: boolean): Assistant {
  return {
    id: "a1",
    mcpServers: ["srv"],
    mcpToolOverrides: {},
    enableToolDiscovery,
  } as unknown as Assistant;
}

function callTool(name: string): Promise<unknown> {
  return executeToolCall({ id: "tc1", function: { name, arguments: "{}" } }, assistantFixture(true));
}

afterAll(() => setState(priorState));

describe("S11 MCP 失效工具调用", () => {
  test("发现开启:名字已不在实时池 → 明确报错并指向 search_tools", async () => {
    installFixture();
    let message = "";
    try {
      await callTool("mcp__srv__removed");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("mcp__srv__removed");
    expect(message).toContain("no longer available");
    expect(message).toContain("search_tools");
    // 不再落进 MCP 失败诊断包装(那是连接级故障的语义,与"工具已不可见"不同)。
    expect(message).not.toContain("MCP_TOOL_FAILURE");
  });

  test("发现关闭:保持 callMcpTool 既有拒绝语义", async () => {
    installFixture();
    let message = "";
    try {
      await executeToolCall(
        { id: "tc2", function: { name: "mcp__srv__removed", arguments: "{}" } },
        assistantFixture(false),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("MCP_TOOL_FAILURE");
    expect(message).toContain("not available for this assistant");
    expect(message).not.toContain("search_tools");
  });

  test("非 MCP 未知工具:原错误不变", async () => {
    installFixture();
    await expect(
      executeToolCall({ id: "tc3", function: { name: "no_such_tool", arguments: "{}" } }, assistantFixture(true)),
    ).rejects.toThrow("Unknown tool: no_such_tool");
  });
});
