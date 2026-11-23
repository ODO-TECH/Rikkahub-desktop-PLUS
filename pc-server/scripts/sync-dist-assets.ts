// scripts/sync-dist-assets.ts — 编译后把 exe 同级静态资产同步进 dist/。
// routeStatic/serveAIIcon/字体服务在打包布局下按 executableDir 查 icons/ 与 fonts/
// (源码运行走 rootDir 兜底不受影响)。dist/ 整目录 gitignored,一旦被清(换盘/手动
// 清空/初次 clone 后 compile)exe 落地而无这两目录,品牌 Logo 与内置字体全部静默
// 回退兜底字母——表象是"Logo 全变默认",极难从代码侧排查。故 compile 每次幂等
// 重放,缺则补、旧则盖,保证 dist 便携布局永远自洽。
// yukkuri-sdk/ 同理由 rootDir 解析(foundation/paths.ts 的 yukkuriSdkDir):缺了它,
// 油库里语音在便携版里直接「引擎未就绪」,而源码运行却正常——最容易误判成代码问题。
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");
const pcServerDir = resolve(import.meta.dir, "..");
const distDir = join(repoRoot, "dist");

// yukkuri-sdk/ 是嵌套结构(lib64/ 与 aq_dic/ 各一层),所以整目录递归复制而不是逐文件搬。
for (const assetDir of ["icons", "fonts", "yukkuri-sdk"] as const) {
  const src = join(repoRoot, assetDir);
  if (!existsSync(src)) continue; // 缺目录说明 checkout 不全,不阻断编译
  const dest = join(distDir, assetDir);
  // Replace generated assets so removed/converted files cannot accumulate between builds.
  if (dirname(resolve(dest)) !== resolve(distDir)) throw new Error(`Invalid asset destination: ${dest}`);
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, force: true });
  console.log(`[sync-dist-assets] ${assetDir} -> ${dest}`);
}

// koffi 的原生件:单文件 exe 里模块图是虚拟路径,koffi 只能靠 process.resourcesPath 下的
// koffi/build/<平台>/koffi.node 找到它(见 media/yukkuri/native-shim.ts 的说明)。
// 布局必须逐字对上 koffi 的搜索路径,少一层就退回「Cannot find the native Koffi module」。
const koffiAddon = join(pcServerDir, "node_modules", "@koromix", "koffi-win32-x64", "win32_x64", "koffi.node");
if (existsSync(koffiAddon)) {
  const dest = join(distDir, "koffi", "build", "win32_x64");
  cpSync(koffiAddon, join(dest, "koffi.node"), { force: true });
  console.log(`[sync-dist-assets] koffi.node -> ${dest}`);
} else {
  console.log("[sync-dist-assets] 未找到 @koromix/koffi-win32-x64,跳过(该平台的油库里合成不可用)");
}
