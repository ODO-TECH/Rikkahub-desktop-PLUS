// api/handlers/settings-ptc.test.ts — PTC 设置路由(默认开 + 写入侧夹取)
//
// 钉住三条:
//  ① 缺省字段保持现值(老前端不回传 timeoutMs 时不能把 60s 重置);
//  ② 越界 timeout 由 normalize 夹到 [5s, 600s],不 400、不夹出合法区间;
//  ③ 存储缺键时读取默认 = 开启 + 60s(用户要求默认开)。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-ptc-settings-"));

const store = await import("../../persistence/json-store");
const { handleSettingsRoutes } = await import("./settings");
const { defaultState } = await import("../../app-config/defaults");

import type { State } from "../../foundation/types";

function post(body: Record<string, unknown>) {
  return handleSettingsRoutes(
    new Request("http://localhost/api/settings/ptc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    new URL("http://localhost/api/settings/ptc"),
    "settings/ptc",
  );
}

describe("settings/ptc", () => {
  test("默认开:state 里没有 ptc 键时读取默认 enabled=true / 60s", async () => {
    const next = defaultState() as State;
    delete (next.settings as unknown as Record<string, unknown>).ptc;
    store.setState(next);
    // 路由读 state.settings.ptc ?? defaultPtcConfig();这里 POST 一个空对象,
    // 响应回显的应是默认值(缺省字段保持现值 = 默认)。
    const response = await post({});
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { ptc: { enabled: boolean; timeoutMs: number } };
    expect(body.ptc.enabled).toBe(true);
    expect(body.ptc.timeoutMs).toBe(60_000);
  });

  test("越界 timeout 夹到 600s;负数夹到 5s;非法类型保持现值", async () => {
    store.setState(defaultState() as State);
    const high = await post({ timeoutMs: 10_000_000 });
    expect(((await high!.json()) as { ptc: { timeoutMs: number } }).ptc.timeoutMs).toBe(600_000);
    const low = await post({ timeoutMs: -20 });
    expect(((await low!.json()) as { ptc: { timeoutMs: number } }).ptc.timeoutMs).toBe(5_000);
    // 非数字 = 不回传:保持上一次的现值(这里是刚才夹出来的 5s),不是重置成默认。
    const bad = await post({ timeoutMs: "soon" });
    expect(((await bad!.json()) as { ptc: { timeoutMs: number } }).ptc.timeoutMs).toBe(5_000);
  });

  test("布尔开关即时生效;缺省时不改动", async () => {
    store.setState(defaultState() as State);
    const off = await post({ enabled: false });
    expect(((await off!.json()) as { ptc: { enabled: boolean } }).ptc.enabled).toBe(false);
    const keep = await post({ timeoutMs: 90_000 });
    expect(((await keep!.json()) as { ptc: { enabled: boolean } }).ptc.enabled).toBe(false);
  });
});
