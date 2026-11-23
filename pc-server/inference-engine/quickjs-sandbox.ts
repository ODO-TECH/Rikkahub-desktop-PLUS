// PTC sandbox runtime (QuickJS/WASM; a fresh VM per invocation).
//
// 为什么是它:
//  - 模型写的程序**不能**拿宿主任意权限。QuickJS 跑在 WASM 里,VM 内没有
//    require / process / Bun / fetch / setTimeout(实测全部 undefined);程序能触碰
//    工作区的唯一通道是我们注入的 `__callTool` 桥,桥后面就是普通 ToolDefinition.execute,
//    审批/边界/审计一条都不会少。
//  - 每次 run_code 新建一个 module + context(实测 5–7 ms),跨调用/跨会话零状态泄漏;
//    不做 REPL 常驻——参照项目自己记录过"变量残留/重名报错"的坑,我们没有理由复制。
//
// 三条纪律(每条都有测试):
//  1. **超时靠 deadline interrupt**:CPU 死循环会阻塞宿主事件循环,基于定时器的中断
//     永远等不到;必须把 deadline 在 eval 之前算好,交给 setInterruptHandler。
//  2. **工具调用有上限**:maxCalls 防模型写 for(;;) 把工作区刷爆;超限返回结构化错误。
//  3. **输出有上限**:每次工具结果在进 VM 前截断,console 输出也有总字符上限,
//     最终结果再过富化层的裁剪。
//
// **程序是同步的(no await / no Promise.all)**:asyncified 桥在微任务里续跑会破坏
// quickjs-emscripten 的宿主引用表(实测 QuickJSHostRefInvalid),而 evalCodeAsync
// 也不自动结算 async IIFE 的 promise(resolvePromise 等不到 job)。工具调用本身在
// VM 眼里就是同步的,所以同步程序已经覆盖 PTC 的全部折叠收益;写 await 时错误信息
// 会直接给出修正提示。
//
// 打包:Bun 的 `with { type: "file" }` 导入把 emscripten-module.wasm 嵌进
// `bun build --compile` 产物;直接按包默认加载会在 exe 里报
// `B:\~BUN\root\emscripten-module.wasm` ENOENT(已在探针里复现并修正)。

import { readFileSync } from "node:fs";
import type { JsonValue } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import type { EmscriptenModuleLoader, QuickJSAsyncEmscriptenModule, QuickJSAsyncVariant } from "quickjs-emscripten-core";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";
// @ts-expect-error Bun 的 file 嵌入导入没有类型声明(readFileSync 在编译产物里同样可读)
import wasmPath from "@jitl/quickjs-wasmfile-release-asyncify/wasm" with { type: "file" };

const wasmFile = readFileSync(wasmPath);
const wasmBinary = wasmFile.buffer.slice(wasmFile.byteOffset, wasmFile.byteOffset + wasmFile.byteLength) as ArrayBuffer;

/** 自建变体:与包内默认变体同源,只把 wasm 换成嵌入字节。 */
const quickjsVariant: QuickJSAsyncVariant = {
  type: "async",
  importFFI: () =>
    import("@jitl/quickjs-wasmfile-release-asyncify/ffi").then((mod) => mod.QuickJSAsyncFFI),
  importModuleLoader: async () => {
    const { default: QuickJSRaw } = await import("@jitl/quickjs-wasmfile-release-asyncify/emscripten-module");
    const loader: EmscriptenModuleLoader<QuickJSAsyncEmscriptenModule> = (options) =>
      QuickJSRaw({ ...options, wasmBinary });
    return { default: loader };
  },
};

export interface SandboxToolBinding {
  name: string;
  /** 给模型看的参数摘要(取自工具自己的 JSON Schema)。 */
  parameters: unknown;
  /** 桥后端:与直接调用工具走同一条 execute(审批/边界/审计都在里面)。 */
  invoke: (args: Record<string, JsonValue>) => Promise<unknown>;
}

export interface SandboxCallRecord {
  name: string;
  ok: boolean;
  ms: number;
  bytes: number;
}

export interface SandboxRunOptions {
  code: string;
  tools: readonly SandboxToolBinding[];
  timeoutMs: number;
  maxCalls: number;
  maxLogChars: number;
  /** 单次工具结果进 VM 前的字符上限(防 VM 内存被一条巨型输出打爆)。 */
  maxToolResultChars: number;
  signal?: AbortSignal;
}

export type SandboxRunResult =
  | { ok: true; result: string | null; logs: string; calls: SandboxCallRecord[]; timedOut: false }
  | { ok: false; error: string; logs: string; calls: SandboxCallRecord[]; timedOut: boolean };

const VM_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const VM_MAX_STACK_BYTES = 4 * 1024 * 1024;

/** 程序里注入的 `tools` 外观:参数对象进、结果值出;错误以异常形式抛给模型代码。
 *  Proxy 兜未知名字:模型拼错工具名时拿到"可用清单",而不是一句 not a function。 */
function preludeFor(toolNames: readonly string[]): string {
  return `
const __names = ${JSON.stringify(toolNames)};
const __tools = Object.create(null);
for (const __name of __names) {
  __tools[__name] = (args) => {
    const __r = JSON.parse(__callTool(__name, JSON.stringify(args === undefined ? {} : args)));
    if (!__r.ok) {
      const __err = new Error(__r.error);
      __err.tool = __name;
      throw __err;
    }
    return __r.value;
  };
}
const tools = new Proxy(__tools, {
  get(__target, __key) {
    if (typeof __key === "string" && !(__key in __target)) {
      throw new Error('Unknown tool "' + __key + '". Available: ' + __names.join(", ") + ".");
    }
    return __target[__key];
  },
});
const console = {
  log: (...args) => __log(args.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(" ")),
};
`;
}

function clipForVm(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... ${text.length - limit} chars truncated by the sandbox ...]`;
}

/** 单条工具结果进 VM 前限长。字符串按字符截断;其余 JSON 序列化后若超限,
 *  换成预览对象——**不能**直接截 JSON 字符串,那会让 JSON.parse 炸掉程序。 */
function clipValueForVm(value: unknown, limit: number): unknown {
  if (typeof value === "string") return clipForVm(value, limit);
  const serialized = JSON.stringify(value ?? null);
  if (serialized.length <= limit) return value;
  return {
    truncated: true,
    bytes: Buffer.byteLength(serialized, "utf8"),
    note: "result too large for the sandbox; re-read with narrower parameters (offset/limit)",
    preview: clipForVm(serialized, limit),
  };
}

/**
 * 跑一段程序。永不给宿主抛错:所有失败都折成 `{ok:false,error}` 由工具层回给模型。
 */
export async function runSandboxedProgram(options: SandboxRunOptions): Promise<SandboxRunResult> {
  const calls: SandboxCallRecord[] = [];
  const logs: string[] = [];
  let logChars = 0;
  let timedOut = false;
  let stopped = false;
  let inflight = 0;
  let disposed = false;

  const QuickJS = await newQuickJSAsyncWASMModuleFromVariant(quickjsVariant);
  const ctx = QuickJS.newContext();
  ctx.runtime.setMemoryLimit(VM_MEMORY_LIMIT_BYTES);
  ctx.runtime.setMaxStackSize(VM_MAX_STACK_BYTES);

  const disposeNow = (): void => {
    if (disposed) return;
    disposed = true;
    try { ctx.dispose(); } catch { /* 已失效的 VM:尽力而为 */ }
  };
  // 结果一旦交还(超时/中止),程序就不许再跑下去:等在途工具回来立即终结 VM。
  // ctx 在途时**不能**提前 dispose(bridge 还要回新句柄),所以延后到 inflight 归零;
  // 若桥本身已不可能再被唤醒,则直接销毁——两条路径都收敛到 disposeNow。
  const finish = (result: SandboxRunResult): SandboxRunResult => {
    stopped = true;
    if (inflight === 0) disposeNow();
    return result;
  };

  const logFn = ctx.newFunction("__log", (handle) => {
    if (logChars >= options.maxLogChars) return;
    const text = ctx.getString(handle);
    const room = options.maxLogChars - logChars;
    const piece = text.length > room ? text.slice(0, room) : text;
    logChars += piece.length;
    logs.push(piece);
    if (logs.length > 2000) {
      // 行数上限:保留前 500 行与最新 500 行,中间折一行(防百万行把宿主内存吃掉)。
      logs.splice(500, logs.length - 1000, "[... many log lines omitted ...]");
    }
  });
  ctx.setProp(ctx.global, "__log", logFn);
  logFn.dispose();

  const bridge = ctx.newAsyncifiedFunction("__callTool", async (nameHandle, argsHandle) => {
    const reply = (payload: unknown): ReturnType<typeof ctx.newString> =>
      ctx.newString(JSON.stringify(payload));
    if (stopped || disposed) return reply({ ok: false, error: "sandbox was stopped" });
    const name = ctx.getString(nameHandle);
    const tool = options.tools.find((item) => item.name === name);
    if (!tool) return reply({ ok: false, error: `Unknown tool "${name}". Available: ${options.tools.map((item) => item.name).join(", ")}.` });
    if (calls.length >= options.maxCalls) {
      return reply({ ok: false, error: `Call limit reached (${options.maxCalls} tool calls per program). Split the work into several run_code calls.` });
    }
    let args: Record<string, JsonValue> = {};
    try {
      const parsed = JSON.parse(ctx.getString(argsHandle) || "{}");
      if (isRecord(parsed)) args = parsed as Record<string, JsonValue>;
    } catch {
      return reply({ ok: false, error: `Arguments for ${name} must be a JSON object.` });
    }
    const started = Date.now();
    inflight += 1;
    try {
      const value = await tool.invoke(args);
      const bytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
      calls.push({ name, ok: true, ms: Date.now() - started, bytes });
      if (stopped || disposed) return reply({ ok: false, error: "sandbox was stopped" });
      return reply({ ok: true, value: clipValueForVm(value, options.maxToolResultChars) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      calls.push({ name, ok: false, ms: Date.now() - started, bytes: Buffer.byteLength(message, "utf8") });
      if (stopped || disposed) return reply({ ok: false, error: "sandbox was stopped" });
      return reply({ ok: false, error: message });
    } finally {
      inflight -= 1;
      // 超时/中止后迟到的工具结果:立刻终结 VM,程序不得继续执行。
      // 但此刻还在 wasm 回调栈里,当场 dispose 会踩到 use-after-free——推出栈再销毁。
      if (stopped && inflight === 0) setTimeout(disposeNow, 0);
    }
  });
  ctx.setProp(ctx.global, "__callTool", bridge);
  bridge.dispose();

  const deadline = Date.now() + Math.max(1000, options.timeoutMs);
  // 只有**真的超过 deadline** 才返回 true(中断)并记账;无条件返回 true 会把每个
  // 程序都误判成超时。CPU 死循环由它在 VM 内部打断,不需要宿主事件循环。
  ctx.runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      timedOut = true;
      return true;
    }
    return false;
  });

  const source = `${preludeFor(options.tools.map((item) => item.name))}\n;(() => {\n${options.code}\n})()`;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const abortRef: { detach: (() => void) | null } = { detach: null };
  try {
    if (options.signal?.aborted) {
      return finish({ ok: false, error: "Program aborted.", logs: "", calls, timedOut: false });
    }
    // 墙钟超时:工具 await 期间 VM 是挂起的,事件循环能跑;CPU 循环由 interrupt 兜底。
    const racer = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Program timed out after ${options.timeoutMs} ms.`)), options.timeoutMs + 250);
    });
    // 用户停止/连接断开:中止要立刻返给 pi,不能等在途工具或墙钟。
    const aborter = new Promise<never>((_, reject) => {
      if (!options.signal) return;
      const onAbort = (): void => reject(new Error("Program aborted."));
      options.signal.addEventListener("abort", onAbort, { once: true });
      abortRef.detach = () => options.signal?.removeEventListener("abort", onAbort);
    });
    const evalPromise = ctx.evalCodeAsync(source);
    // 被墙钟/中止抢走后 evalPromise 可能永远悬着(VM 已被延迟销毁),吞掉迟到拒绝防 unhandled。
    void evalPromise.catch(() => {});
    const settled = await Promise.race([evalPromise, racer, aborter]);
    if (settled.error) {
      const dumped = ctx.dump(settled.error) as { message?: string } | string;
      let message = typeof dumped === "string" ? dumped : String(dumped?.message ?? "program failed");
      // 程序必须是同步的(asyncified 桥在微任务里会破坏宿主引用表,实测崩溃):
      // 模型写 await 时给出可操作的提示,而不是让它在语法错误里猜。
      if (/\bawait\b/.test(message)) {
        message += "\nNote: run_code programs are synchronous — tool calls return values directly. Remove `await` (and Promise.all) and call tools in plain loops.";
      }
      settled.error.dispose();
      return finish({ ok: false, error: message, logs: logs.join("\n"), calls, timedOut: timedOut || /interrupted/i.test(message) });
    }
    const value = ctx.dump(settled.value);
    settled.value.dispose();
    const result = value === undefined || value === null ? null : clipForVm(typeof value === "string" ? value : JSON.stringify(value, null, 2), options.maxLogChars);
    return finish({ ok: true, result, logs: logs.join("\n"), calls, timedOut: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finish({ ok: false, error: message, logs: logs.join("\n"), calls, timedOut: timedOut || /timed out/i.test(message) });
  } finally {
    if (timer) clearTimeout(timer);
    abortRef.detach?.();
  }
}

/** 单测/诊断:确认嵌入的 wasm 与变体在宿主里可用(不跑用户代码)。 */
export async function sandboxSelfCheck(): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const QuickJS = await newQuickJSAsyncWASMModuleFromVariant(quickjsVariant);
  const ctx = QuickJS.newContext();
  try {
    const out = ctx.evalCode("({ sum: [1,2,3].reduce((a,b)=>a+b,0), iso: typeof process + typeof require + typeof Bun })");
    if (out.error) return { ok: false, error: String(ctx.dump(out.error)) };
    const value = ctx.dump(out.value);
    out.value.dispose();
    return { ok: true, result: value };
  } finally {
    ctx.dispose();
  }
}
