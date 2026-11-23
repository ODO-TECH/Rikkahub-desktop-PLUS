// inference-engine/token-calibration.ts — 用量自校准 k̂(S2,参照 billion-context cache-ledger)
//
// 问题:estimateTokens 是启发式,不是真 tokenizer。同一个模型在不同语言/内容上的偏差
// 是系统性的(中文偏低、代码偏高、某中转站按自己的分词器计费),固定系数修不了。
// 办法:每次请求记下"我们估的 prompt 体积",上游回报真实 promptTokens 时配成一个样本,
// 按 (provider, model) 学一个比值 k̂,之后所有**判定用**估算乘上它。
//
// 纪律(每一条都是防"学坏了反而更糟"):
//   - 准入:比值必须落在 [0.2, 5]。超出说明配对错了(拿错了 usage、上下文中途变了),
//     不是模型特性,直接丢弃而不是钳进去。
//   - 发布:至少 2 个样本、且它们互差在 ×2 之内才发布。单样本可能是一次异常;
//     互差过大说明估算方差本身就没收敛,这时给 1.0 比给一个假精确的数更安全。
//   - 钳制:发布值收进 [0.25, 4]。学得再极端也不允许把窗口判定放大/缩小一个数量级。
//   - 只认真实 usage:estimated 载荷(ensureUsage 兜底估算)一律拒收——拿估算校准估算
//     是自证循环,会把误差锁死。
//   - 只配对本轮**第一次** usage:工具循环后续轮的 prompt 已经长大,与出站估算不同源。
//   - 无样本 → 1.0,判定结果与引入前逐字节一致。
//   - UI 不乘 k̂:圆环/统计显示的是供应商真实回报,乘上去就变成了编数字。
//
// 持久化:pc-data/token-calibration.json,运行时遥测,**不进 settings**,因此天然不参与
// 备份与安卓导出。原子写 + 节流;读坏/写失败一律降级为"没有校准",绝不阻塞生成。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tokenCalibrationPath } from "../foundation/paths";
import { isRecord } from "../foundation/utils";

export const CALIBRATION_FILE = "token-calibration.json";
/** 每键样本环长度。够学出稳定比值,又不会被很久以前的模型行为拖住。 */
export const CALIBRATION_RING_MAX = 8;
/** 发布所需的最少样本数。 */
export const CALIBRATION_MIN_SAMPLES = 2;
/** 准入区间:比值超出即视为配对错误,丢弃。 */
export const CALIBRATION_ADMIT_MIN = 0.2;
export const CALIBRATION_ADMIT_MAX = 5;
/** 一致性要求:参与发布的样本之间最大/最小不得超过这个倍数。 */
export const CALIBRATION_AGREEMENT_SPREAD = 2;
/** 发布钳制区间。 */
export const CALIBRATION_PUBLISH_MIN = 0.25;
export const CALIBRATION_PUBLISH_MAX = 4;

export interface CalibrationSample {
  /** 出站时我们的本地估算(含系统面 + 工具声明 + 图片)。 */
  local: number;
  /** 上游回报的真实 promptTokens。 */
  billed: number;
  at: number;
}

export interface CalibrationEntry {
  samples: CalibrationSample[];
  factor: number;
}

export function calibrationKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

/** 样本比值;不满足准入(含非法/零分母)时返回 null。 */
export function calibrationRatio(local: number, billed: number): number | null {
  if (!Number.isFinite(local) || !Number.isFinite(billed) || local <= 0 || billed <= 0) return null;
  const ratio = billed / local;
  if (ratio < CALIBRATION_ADMIT_MIN || ratio > CALIBRATION_ADMIT_MAX) return null;
  return ratio;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 样本环 → 发布系数。取"最大的一致簇"的中位数:排序后滑窗找 max/min ≤ 倍数上限的
 *  最长区间,簇内样本数不足 CALIBRATION_MIN_SAMPLES 就不发布(返回 1)。
 *  用簇而不是全体中位数:一个离群样本不该把一群一致样本的结论带偏。 */
export function publishCalibrationFactor(samples: readonly CalibrationSample[]): number {
  const ratios = samples
    .map((sample) => calibrationRatio(sample.local, sample.billed))
    .filter((ratio): ratio is number => ratio !== null)
    .sort((a, b) => a - b);
  if (ratios.length < CALIBRATION_MIN_SAMPLES) return 1;
  let best: number[] = [];
  let start = 0;
  for (let end = 0; end < ratios.length; end += 1) {
    while (ratios[end]! / ratios[start]! > CALIBRATION_AGREEMENT_SPREAD) start += 1;
    const window = ratios.slice(start, end + 1);
    if (window.length > best.length) best = window;
  }
  if (best.length < CALIBRATION_MIN_SAMPLES) return 1;
  return Math.min(CALIBRATION_PUBLISH_MAX, Math.max(CALIBRATION_PUBLISH_MIN, median(best)));
}

/** 追加样本并维持环长(超出丢最旧)。返回新数组,不改传入数组。 */
export function appendCalibrationSample(
  samples: readonly CalibrationSample[],
  sample: CalibrationSample,
): CalibrationSample[] {
  const next = [...samples, sample];
  return next.length > CALIBRATION_RING_MAX ? next.slice(next.length - CALIBRATION_RING_MAX) : next;
}

// ── 运行时存储 ────────────────────────────────────────────────────────────────

type CalibrationMap = Map<string, CalibrationEntry>;

let entries: CalibrationMap | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** 节流:一次生成可能落多个样本,合并成一次写盘。 */
const PERSIST_DELAY_MS = 2000;

function calibrationPath(): string {
  return tokenCalibrationPath;
}

function parseEntries(raw: unknown): CalibrationMap {
  const map: CalibrationMap = new Map();
  if (!isRecord(raw)) return map;
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || !Array.isArray(value.samples)) continue;
    const samples: CalibrationSample[] = [];
    for (const item of value.samples) {
      if (!isRecord(item)) continue;
      const local = Number(item.local);
      const billed = Number(item.billed);
      const at = Number(item.at);
      if (calibrationRatio(local, billed) === null) continue;
      samples.push({ local, billed, at: Number.isFinite(at) ? at : 0 });
    }
    if (samples.length === 0) continue;
    const trimmed = samples.slice(-CALIBRATION_RING_MAX);
    // factor 一律按样本重算,不信文件里的值:旧版本/手改的系数不该继续生效。
    map.set(key, { samples: trimmed, factor: publishCalibrationFactor(trimmed) });
  }
  return map;
}

function loadEntries(): CalibrationMap {
  if (entries) return entries;
  try {
    const path = calibrationPath();
    entries = existsSync(path) ? parseEntries(JSON.parse(readFileSync(path, "utf8"))) : new Map();
  } catch {
    // 读坏/无权限 = 没有校准。不报错、不重试:下次写盘会覆盖成合法内容。
    entries = new Map();
  }
  return entries;
}

function serialize(map: CalibrationMap): string {
  const out: Record<string, CalibrationEntry> = {};
  for (const [key, entry] of map) out[key] = entry;
  return JSON.stringify(out, null, 2);
}

function persistNow(): void {
  if (!entries) return;
  try {
    const path = calibrationPath();
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, serialize(entries));
    renameSync(tempPath, path);
  } catch {
    // 写失败只丢校准(退回 1.0),不影响生成,也不该刷屏报错。
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DELAY_MS);
  // 校准写盘不该把进程留在事件循环里(测试/短命脚本会因此不退出)。
  (persistTimer as { unref?: () => void }).unref?.();
}

/** 当前生效系数;无样本/未发布 → 1(与引入前逐字节一致)。 */
export function calibrationFactorFor(providerId: string, modelId: string): number {
  if (!providerId || !modelId) return 1;
  return loadEntries().get(calibrationKey(providerId, modelId))?.factor ?? 1;
}

/** 落一个样本。比值不准入时静默丢弃(不污染环)。 */
export function recordCalibrationSample(
  providerId: string,
  modelId: string,
  local: number,
  billed: number,
): void {
  if (!providerId || !modelId) return;
  if (calibrationRatio(local, billed) === null) return;
  const map = loadEntries();
  const key = calibrationKey(providerId, modelId);
  const samples = appendCalibrationSample(map.get(key)?.samples ?? [], { local, billed, at: Date.now() });
  map.set(key, { samples, factor: publishCalibrationFactor(samples) });
  schedulePersist();
}

// ── 出站估算 ↔ usage 配对 ─────────────────────────────────────────────────────

interface PendingEstimate {
  providerId: string;
  modelId: string;
  local: number;
  at: number;
}

/** 陈旧配对防护:超过这个时长的出站估算不再与 usage 配对(中间可能压过缩、换过模型)。 */
export const CALIBRATION_PENDING_TTL_MS = 5 * 60 * 1000;
const PENDING_MAX = 256;
const pending = new Map<string, PendingEstimate>();

/** 请求出站时登记本地估算(按会话)。同一会话再次生成即覆盖——只留最近一次。 */
export function noteOutboundEstimate(
  conversationId: string,
  providerId: string,
  modelId: string,
  local: number,
): void {
  if (!conversationId || !providerId || !modelId) return;
  if (!Number.isFinite(local) || local <= 0) return;
  if (pending.size >= PENDING_MAX) pending.clear();
  pending.set(conversationId, { providerId, modelId, local, at: Date.now() });
}

/** 取走并清除本会话的出站估算。工具循环的后续轮取不到 → 不产生样本(口径不同源)。 */
export function takeOutboundEstimate(conversationId: string): PendingEstimate | null {
  const entry = pending.get(conversationId);
  if (!entry) return null;
  pending.delete(conversationId);
  if (Date.now() - entry.at > CALIBRATION_PENDING_TTL_MS) return null;
  return entry;
}

/** usage 事件 → 校准样本。只认真实回报:estimated 载荷或缺 promptTokens 一律跳过。
 *  返回是否真的落了样本(诊断/测试用)。 */
export function learnFromUsage(conversationId: string, usage: unknown): boolean {
  if (!isRecord(usage)) return false;
  if (usage.estimated === true) return false;
  const billed = Number(usage.promptTokens ?? 0);
  if (!Number.isFinite(billed) || billed <= 0) return false;
  const estimate = takeOutboundEstimate(conversationId);
  if (!estimate) return false;
  if (calibrationRatio(estimate.local, billed) === null) return false;
  recordCalibrationSample(estimate.providerId, estimate.modelId, estimate.local, billed);
  return true;
}

/** 测试 seam:丢掉内存态与待配对登记,下次读取重新落盘加载(不动磁盘文件)。
 *  刻意置 null 而不是空 Map:空 Map 表示"已加载且为空",会让后续读取跳过磁盘,
 *  测"读回重算"时就永远读不到刚写的内容。 */
export function resetTokenCalibration(): void {
  entries = null;
  pending.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

/** 测试/诊断 seam:立即写盘(跳过节流)。 */
export function flushTokenCalibration(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistNow();
}