// scripts/sandbox-wasm-check.ts — S-F2 打包自检
//
// 用途:验证 `bun build --compile` 产物里嵌入的 QuickJS wasm 可用(不走磁盘相对路径)。
// 用法:
//   bun run scripts/sandbox-wasm-check.ts        # 源码态
//   bun build --compile --target=bun-windows-x64 scripts/sandbox-wasm-check.ts --outfile ../dist/sandbox-check.exe
//   ../dist/sandbox-check.exe                    # 换任意 cwd 跑,证明 wasm 已嵌入
import { runSandboxedProgram, sandboxSelfCheck } from "../inference-engine/quickjs-sandbox";

const check = await sandboxSelfCheck();
console.log("selfcheck:", JSON.stringify(check));

const run = await runSandboxedProgram({
  code: "return [1, 2, 3].reduce((a, b) => a + b, 0) + ':' + typeof require;",
  tools: [],
  timeoutMs: 5_000,
  maxCalls: 5,
  maxLogChars: 1_000,
  maxToolResultChars: 1_000,
});
console.log("program:", JSON.stringify({ ok: run.ok, result: run.ok ? run.result : run.error }));
process.exit(check.ok && run.ok ? 0 : 1);
