// media/yukkuri/native-shim.ts — 让 koffi 在「单文件编译产物」里找得到自己的原生模块
//
// 症状(2026-11-18 实测):源码跑一切正常,`bun build --compile` 出的 exe 里 import koffi
// 直接抛「Cannot find the native Koffi module; did you bundle it correctly?」。
// 原因在 koffi 自己的加载器:它只在两处找 koffi.node —— 模块图里的 `__dirname`(编译产物里
// 是 B:\~BUN\root\... 虚拟路径,真实文件系统上不存在),以及 `process.resourcesPath` 下的
// koffi、koffi/build、node_modules/koffi/build 三个根(而 Bun 的单文件产物里这个值是 undefined)。
//
// 做法:把 resourcesPath 指到 exe 同级目录,并把原生件按 koffi 期望的布局作为随包资产放在
// `<exe>/koffi/build/win32_x64/koffi.node`(由 scripts/sync-dist-assets.ts 与 deploy-portable 落地)。
// 本模块必须在 engine.ts 里排在 `import ... from "koffi"` **之前** —— ESM 的模块求值按 import
// 顺序走,晚一行就来不及了。
//
// 只在 Windows x64 生效:油库里本来就只支持这一档(见 sdk.ts 的 platformSupported),
// 其他平台不去改 process 上的字段,免得给别的运行时添乱。
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

/** 命中随包布局时返回该路径,否则返回 null(源码运行走 koffi 自己的 node_modules 解析)。 */
function packagedAddonDir(exeDir: string): string | null {
  const candidate = join(exeDir, "koffi", "build", "win32_x64", "koffi.node");
  return existsSync(candidate) ? candidate : null;
}

export function ensureKoffiNativePath(): string | null {
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  const holder = process as unknown as { resourcesPath?: string };
  const addon = packagedAddonDir(dirname(process.execPath));
  // 随包件不在(源码运行 / 老 dist)就别乱改:那时 koffi 用 node_modules 里的解析路径就能命中。
  if (!addon) return null;
  if (typeof holder.resourcesPath !== "string") holder.resourcesPath = dirname(process.execPath);
  return addon;
}

// 求值即生效:engine.ts 只要 import 到本模块,koffi 的加载器就已经有正确的搜索根。
const applied = ensureKoffiNativePath();
if (applied) console.log(`[yukkuri] koffi 原生件走随包布局: ${applied}`);
