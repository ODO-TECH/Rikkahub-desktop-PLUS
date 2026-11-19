// api/agent-loop-settings-route.test.ts — settings/agent-loop 路由契约锁。
// 锁三件事:① 布尔开关落库且回传整块;② 整数越界/类型不符整单 400 且不落库;
// ③ GET /settings 必须带 agentLoop(界面读的是同一份,缺了开关会静默回默认)。
// 背景:便携版曾出现「前端 0.1.5 / 后端 0.1.4」的产物错配,该路由在旧 exe 里不存在,
// 界面点开关只报 Not found。这条测试锁的是路由本身别再被重构掉。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-agent-loop-route-"));

import { defaultSettings } from "../app-config/defaults";
import { defaultAgentLoopConfig } from "../foundation/types/settings/agent-loop-config";
import type { State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { handleSettingsRoutes } from "./handlers/settings";

async function postAgentLoop(body: Record<string, unknown>): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/settings/agent-loop");
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSettingsRoutes(request, url, "settings/agent-loop");
}

beforeAll(() => {
  setState({
    settings: { ...defaultSettings(), agentLoop: defaultAgentLoopConfig() },
  } as unknown as State);
});

describe("settings/agent-loop", () => {
  test("布尔开关落库并回传整块", async () => {
    const res = await postAgentLoop({ enabled: true, transportRetry: false });
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { agentLoop: Record<string, unknown> };
    expect(body.agentLoop.enabled).toBe(true);
    expect(body.agentLoop.transportRetry).toBe(false);
    expect(state.settings.agentLoop.enabled).toBe(true);
    expect(state.settings.agentLoop.transportRetry).toBe(false);
  });

  test("传输重试可独立于总开关关闭", async () => {
    const res = await postAgentLoop({ enabled: false, transportRetry: false });
    expect(res?.status).toBe(200);
    expect(state.settings.agentLoop.enabled).toBe(false);
    expect(state.settings.agentLoop.transportRetry).toBe(false);
  });

  test("重试等待间隔落库并回传", async () => {
    const res = await postAgentLoop({ transportRetryDelaySeconds: 5 });
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { agentLoop: Record<string, unknown> };
    expect(body.agentLoop.transportRetryDelaySeconds).toBe(5);
    expect(state.settings.agentLoop.transportRetryDelaySeconds).toBe(5);
  });

  test("整数越界整单拒绝,现值不变", async () => {
    const before = state.settings.agentLoop.maxReplans;
    const res = await postAgentLoop({ maxReplans: 99 });
    expect(res?.status).toBe(400);
    expect(state.settings.agentLoop.maxReplans).toBe(before);
  });

  test("重试等待间隔越界整单拒绝,现值不变", async () => {
    const before = state.settings.agentLoop.transportRetryDelaySeconds;
    expect((await postAgentLoop({ transportRetryDelaySeconds: 0 }))?.status).toBe(400);
    expect((await postAgentLoop({ transportRetryDelaySeconds: 31 }))?.status).toBe(400);
    expect((await postAgentLoop({ transportRetryDelaySeconds: 1.5 }))?.status).toBe(400);
    expect(state.settings.agentLoop.transportRetryDelaySeconds).toBe(before);
  });

  test("类型不符整单拒绝", async () => {
    const res = await postAgentLoop({ enabled: "yes" });
    expect(res?.status).toBe(400);
    expect(state.settings.agentLoop.enabled).toBe(false);
  });

  test("无识别字段整单拒绝", async () => {
    const res = await postAgentLoop({ nope: 1 });
    expect(res?.status).toBe(400);
  });

  test("GET /settings 带 agentLoop", async () => {
    const url = new URL("http://127.0.0.1/api/settings");
    const res = await handleSettingsRoutes(new Request(url), url, "settings");
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.agentLoop).toBeDefined();
  });
});
