// debug/log-ring.ts — 进程内控制台环形缓冲(供调试端口读取 / SSE 推送)
//
// 设计:
// - 常驻安装、开销可忽略:每次 console.* 多一次字符串化与数组 push,不写盘。
// - 上限 1000 条、单条 8160 字符截断:长时间运行也不会无界吃内存。
// - 订阅者只收到安装之后的新条目;历史靠 readDebugLogs 拉取。
// - 绝不抛错:控制台是最后一条取证通道,捕获层自身的异常必须吞掉并继续调用原函数。

export type DebugLogLevel = "log" | "warn" | "error" | "debug";

export interface DebugLogEntry {
  /** 单调递增序号,?since= 增量拉取用(客户端记最后一条的 seq)。 */
  seq: number;
  at: number;
  level: DebugLogLevel;
  text: string;
}

const MAX_ENTRIES = 1000;
const MAX_TEXT = 8160;

const entries: DebugLogEntry[] = [];
const listeners = new Set<(entry: DebugLogEntry) => void>();
let nextSeq = 1;
let installed = false;

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
  if (typeof arg === "object" && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function push(level: DebugLogLevel, args: unknown[]): void {
  try {
    let text = args.map(formatArg).join(" ");
    if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}…[truncated ${text.length - MAX_TEXT} chars]`;
    const entry: DebugLogEntry = { seq: nextSeq++, at: Date.now(), level, text };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        // 单个订阅者失败不影响其他订阅者与主流程。
      }
    }
  } catch {
    // 捕获层绝不影响业务日志输出。
  }
}

/** 安装 console 钩子(幂等)。应在进程最早阶段调用,以便调试端口开启后能回看启动日志。 */
export function installDebugLogCapture(): void {
  if (installed) return;
  installed = true;
  for (const level of ["log", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        original(...args);
      } finally {
        push(level, args);
      }
    };
  }
}

export function debugLogCaptureInstalled(): boolean {
  return installed;
}

export function readDebugLogs(options: { limit?: number; level?: string; sinceSeq?: number } = {}): DebugLogEntry[] {
  const limit = Math.min(1000, Math.max(1, Math.floor(options.limit ?? 200)));
  const since = Number.isFinite(options.sinceSeq) ? Math.max(0, Math.floor(options.sinceSeq!)) : 0;
  const level = options.level && options.level !== "all" ? options.level : null;
  const filtered = entries.filter((entry) => entry.seq > since && (!level || entry.level === level));
  return filtered.slice(-limit);
}

export function subscribeDebugLogs(listener: (entry: DebugLogEntry) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 仅测试用:清空缓冲。 */
export function clearDebugLogsForTest(): void {
  entries.length = 0;
  listeners.clear();
  nextSeq = 1;
}
