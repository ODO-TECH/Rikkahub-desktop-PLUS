// foundation/system-proxy-cache.test.ts — S2 守卫：系统代理「请求路径零探测」。
// 契约（R1-7 已实现，这里把它钉住）：
//   ① prime 之后，任意多次 readSystemProxy 都不触发新的探测（per-request 只读缓存）；
//   ② TTL 过期后的读仍立即返回陈值，只触发一次后台单飞刷新（并发读不会叠加探测）；
//   ③ 诊断计数只统计探测调用，不暴露代理地址。
import { describe, expect, test, setSystemTime } from "bun:test";

import { primeSystemProxyCache, readSystemProxy, systemProxyDiagnostics, SYSTEM_PROXY_TTL_MS } from "./net";

describe("系统代理探测缓存（S2）", () => {
  test("预热后 N 次读零探测；TTL 过期只触发一次后台刷新", async () => {
    await primeSystemProxyCache();
    const afterPrime = systemProxyDiagnostics().detectCalls;
    expect(afterPrime).toBeGreaterThan(0);
    expect(systemProxyDiagnostics().cacheAgeMs).not.toBeNull();

    for (let i = 0; i < 100; i += 1) readSystemProxy();
    expect(systemProxyDiagnostics().detectCalls).toBe(afterPrime);

    // 让缓存过期：读立即返回（陈值），并发两次读也只排一次刷新
    const realNow = Date.now();
    try {
      setSystemTime(new Date(realNow + SYSTEM_PROXY_TTL_MS + 1000));
      const first = readSystemProxy();
      const second = readSystemProxy();
      expect(first).toBe(second); // 过期当次仍返回陈值，不阻塞
      for (let i = 0; i < 100 && systemProxyDiagnostics().detectCalls === afterPrime; i += 1) await Bun.sleep(10);
      expect(systemProxyDiagnostics().detectCalls).toBe(afterPrime + 1);
    } finally {
      setSystemTime();
    }
  });
});