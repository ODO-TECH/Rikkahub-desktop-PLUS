// inference-engine/transport-retry.ts — S4 传输重试的纯判定/解析(零 I/O)。
//
// 纪律:本模块只回答"这次失败值不值得再发一次请求、该等多久"。真正发请求与等待在
// tool-loop 骨架;判定留成纯函数便于单测(Retry-After 两种格式、配额/计费文案、
// 退避序列)。
//
// 成本边界(plan §3.4):最多 3 次尝试 = 首次 + 2 次重试,一个失败轮次最多多出 2 个
// 计费请求。因此这里不提供"无限退避"或按 4s 再试的入口;4s 只是退避序列文案里的
// 理论下一档,超出 3 次尝试即不再使用。
//
// 禁止重试的判定不在这里(是否已输出、是否执行过工具、是否用户中止),那些需要轮次
// 上下文,由骨架持有;本模块只做"单次失败本身"的判定。

import { isRetryableHttpStatus } from "../foundation/retry";

/** 含首次尝试。首次 + 2 次退避重试 = 最多多出 2 个计费请求。 */
export const TRANSPORT_RETRY_MAX_ATTEMPTS = 3;
/** 指数退避基数:1s → 2s(第三次尝试前);与 plan §3.4 的序列一致。
 *  只是未配置时的默认值——设置里 transportRetryDelaySeconds 可改,见 transportRetryDelayMs。 */
export const TRANSPORT_RETRY_BASE_DELAY_MS = 1000;
/** Retry-After 等待上限:服务端要求的等待超过 30s 时按 30s 封顶。 */
export const RETRY_AFTER_CAP_MS = 30_000;
/** Retry-After 超过 60s 时直接失败,不拿用户的时间去等一个远期窗口。 */
export const RETRY_AFTER_FAIL_MS = 60_000;

/** 配额/计费类错误:重试不会成功,只会多花一次请求。文案匹配是最后一道保险——
 *  多数供应商用 429 表达限流与欠费,单看状态码无法区分。 */
const QUOTA_BILLING_PATTERNS: RegExp[] = [
  /insufficient[\s_-]?quota/i,
  /exceeded your current quota/i,
  /quota\s+(?:exceeded|exhausted)/i,
  /credit balance/i,
  /out of credits/i,
  /\bbilling\b/i,
  /payment required/i,
  /余额不足|额度不足|欠费|账户余额|计费/i,
];

export function isQuotaOrBillingError(body: string): boolean {
  return QUOTA_BILLING_PATTERNS.some((pattern) => pattern.test(body));
}

/** 解析 Retry-After:支持秒数(`1`、`1.5`)与 HTTP-date 两种格式。
 *  返回 null = 缺失/无法解析(走指数退避);0 = 立即重试。 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  }
  // HTTP-date 一定含字母(星期/月份);纯数字或符号串交给 Date.parse 会把 "-1"
  // 之类解析成远古日期,误判成"立即可重试"。
  if (!/[A-Za-z]/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/** 单次重试前的等待时长(ms)。返回 null = 放弃重试(Retry-After 要求超过 60s)。
 *  baseDelayMs 由设置里的 transportRetryDelaySeconds 决定,缺省 1s → 2s。
 *
 *  两条规则怎么合:服务端要求是**下限**(绝不比它说的更早发),设置值是**下限的抬高**
 *  (取两者较大)。只按服务端封顶的话,供应商回一个 retry-after: 1 就把用户设的
 *  30s 打回 1s——429 里写着"等内存降温"的服务商正属此类,设置等于无效。
 *  封顶 30s 只约束服务端那一半,不让用户自己设的更长等待被截掉。 */
export function transportRetryDelayMs(
  failedAttempt: number,
  retryAfterMs: number | null,
  baseDelayMs: number = TRANSPORT_RETRY_BASE_DELAY_MS,
): number | null {
  const backoffMs = transportRetryBackoffMs(failedAttempt, baseDelayMs);
  if (retryAfterMs === null) return backoffMs;
  if (retryAfterMs > RETRY_AFTER_FAIL_MS) return null;
  return Math.max(Math.min(RETRY_AFTER_CAP_MS, Math.max(0, retryAfterMs)), backoffMs);
}

/** 无 Retry-After 时的指数退避:base × 2^(第几次失败-1);非法基数回落默认 1s。 */
function transportRetryBackoffMs(failedAttempt: number, baseDelayMs: number): number {
  const base = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : TRANSPORT_RETRY_BASE_DELAY_MS;
  return base * 2 ** Math.max(0, failedAttempt - 1);
}

/** 非 2xx 失败:保留引入前的人话文案(`${provider} ${status}: ${body…}`),同时携带
 *  判定所需的状态码与 Retry-After。骨架据此决定重试;终局抛出时文案逐字不变。 */
export class TransportHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryAfterMs: number | null, body: string) {
    super(message);
    this.name = "TransportHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryable = isRetryableHttpStatus(status) && !isQuotaOrBillingError(body);
  }
}
