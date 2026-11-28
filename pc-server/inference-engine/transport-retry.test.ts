// inference-engine/transport-retry.test.ts — S4 传输重试的纯判定(零 I/O、零等待)
//
// 钉住三件事:Retry-After 两种格式与封顶/放弃边界、配额计费文案不重试、退避序列
// 1s→2s 且 Retry-After 优先。集成行为(状态条/轮次不增加/停止打断)在 tool-loop.test。

import { describe, expect, test } from "bun:test";

import {
  isQuotaOrBillingError,
  parseRetryAfterMs,
  RETRY_AFTER_CAP_MS,
  RETRY_AFTER_FAIL_MS,
  TRANSPORT_RETRY_BASE_DELAY_MS,
  TransportHttpError,
  transportRetryDelayMs,
} from "./transport-retry";

describe("parseRetryAfterMs", () => {
  test("秒数格式(含小数)", () => {
    expect(parseRetryAfterMs("1")).toBe(1000);
    expect(parseRetryAfterMs(" 2.5 ")).toBe(2500);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  test("HTTP-date 格式:按当前时间折算剩余毫秒", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    expect(parseRetryAfterMs("Sun, 01 Nov 2026 00:00:05 GMT", now)).toBe(5000);
    // 过去的日期 = 立即可重试
    expect(parseRetryAfterMs("Sat, 31 Oct 2026 23:59:00 GMT", now)).toBe(0);
  });

  test("缺失/不可解析返回 null(走指数退避)", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
    expect(parseRetryAfterMs("-1")).toBeNull();
  });
});

describe("transportRetryDelayMs", () => {
  test("无 Retry-After:1s → 2s 指数退避", () => {
    expect(transportRetryDelayMs(1, null)).toBe(TRANSPORT_RETRY_BASE_DELAY_MS);
    expect(transportRetryDelayMs(2, null)).toBe(TRANSPORT_RETRY_BASE_DELAY_MS * 2);
  });

  test("自定义退避基数:按设置值翻倍,缺省参数保持旧序列", () => {
    expect(transportRetryDelayMs(1, null, 5000)).toBe(5000);
    expect(transportRetryDelayMs(2, null, 5000)).toBe(10000);
    expect(transportRetryDelayMs(3, null, 5000)).toBe(20000);
    expect(transportRetryDelayMs(1, null, undefined)).toBe(TRANSPORT_RETRY_BASE_DELAY_MS);
  });

  test("退避基数非正数/NaN 回落默认(不把请求打成零等待)", () => {
    expect(transportRetryDelayMs(1, null, 0)).toBe(TRANSPORT_RETRY_BASE_DELAY_MS);
    expect(transportRetryDelayMs(1, null, -3000)).toBe(TRANSPORT_RETRY_BASE_DELAY_MS);
    expect(transportRetryDelayMs(1, null, Number.NaN)).toBe(TRANSPORT_RETRY_BASE_DELAY_MS);
  });

  test("有 Retry-After:服务端值封顶 30s;超过 60s 放弃", () => {
    expect(transportRetryDelayMs(1, 1500)).toBe(1500);
    expect(transportRetryDelayMs(1, RETRY_AFTER_CAP_MS + 5000)).toBe(RETRY_AFTER_CAP_MS);
    expect(transportRetryDelayMs(1, RETRY_AFTER_FAIL_MS + 1)).toBeNull();
    expect(transportRetryDelayMs(1, RETRY_AFTER_FAIL_MS)).toBe(RETRY_AFTER_CAP_MS);
    expect(transportRetryDelayMs(1, 45_000, 5000)).toBe(RETRY_AFTER_CAP_MS);
  });

  test("设置值是下限:绝不比服务端更早发,也不被它的小值打回默认", () => {
    // 供应商回 retry-after: 1 却要求等降温——旧实现在这里让设置形同无效。
    expect(transportRetryDelayMs(1, 1500, 30_000)).toBe(30_000);
    expect(transportRetryDelayMs(1, 0, 30_000)).toBe(30_000);
    expect(transportRetryDelayMs(2, 1000, 30_000)).toBe(60_000);
    // 缺省基数下同样不再零等待:退避 1s 是底线。
    expect(transportRetryDelayMs(1, 0)).toBe(TRANSPORT_RETRY_BASE_DELAY_MS);
  });
});

describe("isQuotaOrBillingError", () => {
  test("常见供应商的配额/计费文案命中", () => {
    expect(isQuotaOrBillingError('{"error":{"type":"insufficient_quota"}}')).toBe(true);
    expect(isQuotaOrBillingError("You exceeded your current quota, please check your plan")).toBe(true);
    expect(isQuotaOrBillingError("Your credit balance is too low to access the API")).toBe(true);
    expect(isQuotaOrBillingError("账户余额不足，请充值")).toBe(true);
  });

  test("限流文案不误伤(仍可重试)", () => {
    expect(isQuotaOrBillingError("Resource has been exhausted (e.g. check quota).")).toBe(false);
    expect(isQuotaOrBillingError("Rate limit reached for requests")).toBe(false);
    expect(isQuotaOrBillingError("Too many requests")).toBe(false);
  });
});

describe("TransportHttpError", () => {
  test("408/429/5xx 可重试;400/401/403 不可重试", () => {
    expect(new TransportHttpError("e", 429, null, "rate").retryable).toBe(true);
    expect(new TransportHttpError("e", 503, null, "boom").retryable).toBe(true);
    expect(new TransportHttpError("e", 401, null, "bad key").retryable).toBe(false);
    expect(new TransportHttpError("e", 400, null, "bad request").retryable).toBe(false);
  });

  test("配额/计费 429 即使状态码可重试也不重试", () => {
    const error = new TransportHttpError("e", 429, 1000, "insufficient_quota");
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(1000);
  });
});
