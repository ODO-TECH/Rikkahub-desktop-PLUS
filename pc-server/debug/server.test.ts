// debug/server.test.ts — 调试端口(默认关闭、回环、可选令牌、重启回调接线)
//
// 覆盖:配置归一化边界、开/关生命周期、health/logs/requests/tree/404、令牌校验、
// 重启桩调用。会话编码报告依赖真实会话库,由演示实例与 e2e 覆盖,这里只验缺失时 404。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "rkh-debug-server-"));
process.env.RIKKAHUB_PC_DATA_DIR = dataDir;

const { defaultDebugServerConfig, normalizeDebugServerConfig } = await import("../foundation/types/settings/debug-server-config");
const jsonStore = await import("../persistence/json-store");
const { defaultState } = await import("../app-config/defaults");
const { openConversationsDb } = await import("../conversations");
const debug = await import("./server");

const priorState = jsonStore.state;
const PORT = 20000 + (process.pid % 20000);
const TOKEN_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN_BASE = `http://127.0.0.1:${TOKEN_PORT}`;

beforeAll(() => {
  jsonStore.setState(defaultState() as unknown as typeof jsonStore.state);
  openConversationsDb();
  debug.prepareDebugLogging();
});

afterAll(() => {
  debug.stopDebugServer();
  jsonStore.setState(priorState);
});

describe("配置归一化", () => {
  test("缺省/损坏回落默认,端口越界回落默认", () => {
    expect(normalizeDebugServerConfig(undefined)).toEqual(defaultDebugServerConfig());
    expect(normalizeDebugServerConfig({ enabled: "yes", port: 80, token: 42 })).toEqual(defaultDebugServerConfig());
    expect(normalizeDebugServerConfig({ enabled: true, port: 65000, token: "  abc  " })).toEqual({
      enabled: true,
      port: 65000,
      token: "abc",
    });
  });
});

describe("监听生命周期与端点", () => {
  test("开启后 health/logs/tree 可用,关闭后连接失败", async () => {
    // 生产路径由 settings 端点先落库再拉起;这里模拟同序(运行态与设置各管各的)。
    (jsonStore.state.settings as unknown as { debugServer: unknown }).debugServer = { enabled: true, port: PORT, token: "" };
    const status = debug.applyDebugServerConfig({ enabled: true, port: PORT, token: "" });
    expect(status.running).toBe(true);
    expect(status.port).toBe(PORT);

    console.log("[debug-test] hello-ring-buffer");
    const health = (await (await fetch(`${BASE}/debug/health`)).json()) as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect(health.pid).toBe(process.pid);
    expect(health.debugPort).toBe(PORT);

    const logs = (await (await fetch(`${BASE}/debug/logs?limit=50&level=log`)).json()) as {
      entries: Array<{ text: string }>;
    };
    expect(logs.entries.some((entry) => entry.text.includes("[debug-test] hello-ring-buffer"))).toBe(true);

    const treeResponse = await fetch(`${BASE}/debug/tree`);
    if (!treeResponse.ok) console.error("tree body:", await treeResponse.text());
    const tree = (await treeResponse.json()) as {
      counts: { assistants: number };
      settings: { debugServer: { enabled: boolean } };
    };
    expect(tree.counts.assistants).toBeGreaterThan(0);
    expect(tree.settings.debugServer.enabled).toBe(true);

    const missing = await fetch(`${BASE}/debug/conversations/does-not-exist/tree`);
    if (missing.status !== 404) console.error("missing body:", await missing.text());
    expect(missing.status).toBe(404);

    const html = await fetch(`${BASE}/debug`);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("RikkaHub 调试口");

    debug.applyDebugServerConfig({ enabled: false, port: PORT, token: "" });
    expect(debug.debugServerStatus().running).toBe(false);
    await expect(fetch(`${BASE}/debug/health`)).rejects.toThrow();
  });

  test("重启端点调用注入的回调", async () => {
    let calls = 0;
    debug.configureDebugServer({
      restart: async () => {
        calls += 1;
        return { ok: true, pid: 4242 };
      },
    });
    debug.applyDebugServerConfig({ enabled: true, port: PORT, token: "" });
    const response = await fetch(`${BASE}/debug/restart`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, pid: 4242 });
    expect(calls).toBe(1);

    debug.configureDebugServer({
      restart: async () => ({ ok: false, code: "restart_managed_by_shell", message: "由壳管理" }),
    });
    const refused = await fetch(`${BASE}/debug/restart`, { method: "POST" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("restart_managed_by_shell");
  });

  test("配置令牌后缺令牌 401,带头部或查询参数放行", async () => {
    debug.applyDebugServerConfig({ enabled: true, port: TOKEN_PORT, token: "s3cret" });
    expect((await fetch(`${TOKEN_BASE}/debug/health`)).status).toBe(401);
    const header = await fetch(`${TOKEN_BASE}/debug/health`, { headers: { "x-debug-token": "s3cret" } });
    expect(header.status).toBe(200);
    const query = await fetch(`${TOKEN_BASE}/debug/health?token=s3cret`);
    expect(query.status).toBe(200);
    debug.stopDebugServer();
  });

  test("debug can edit settings and call the application API while blocking cross-origin writes",async()=>{
    debug.applyDebugServerConfig({enabled:true,port:PORT,token:""});
    const blocked=await fetch(`${BASE}/debug/settings`,{method:"PATCH",headers:{"content-type":"application/json",origin:"https://example.com"},body:'{}'});
    expect(blocked.status).toBe(403);
    const response=await fetch(`${BASE}/debug/settings`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({agentLoop:{transportRetry:false}})});
    expect(response.status).toBe(200);expect(jsonStore.state.settings.agentLoop?.transportRetry).toBe(false);
    debug.configureDebugServer({api:async(request,url)=>new Response(JSON.stringify({method:request.method,path:url.pathname,apiKey:"should-not-leak"}),{headers:{"content-type":"application/json"}})});
    const proxy=await(await fetch(`${BASE}/debug/api/settings/test`,{method:"POST",body:'{}'})).json() as any;
    expect(proxy.path).toBe("/api/settings/test");expect(proxy.apiKey).toBe("[REDACTED]");
    // Wait for the deliberately deferred listener reconfiguration before cleanup.
    await Bun.sleep(120);debug.stopDebugServer();
  });
});
