import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Mirror mermaid's self-contained classic-script bundle from node_modules into public/mermaid.
//
// 为什么需要这一步:mermaid 原先只在运行时从 https://esm.sh/mermaid@11 拉。桌面应用断网或
// 出站链路不通时,对话里的 mermaid 代码块只剩代码原文——渲染能力吊在公网 CDN 上不该是这样。
// 现在库已经进了依赖,产物只差搬运;搬运脚本不手写第二份,版本永远跟 bun.lock 一致。
//
// 为什么落在 public/ 而不是 build/:vite build 会把 public/ 整份复制进 build/client,
// copy.ts 再镜像到 ../dist/web-ui/build/client,所以打包、编译产物、便携部署三条链路都自动
// 覆盖到;`bun run dev` 也直接能读同一个 URL,不必两套路径。目录内容已 gitignore。
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(SCRIPT_DIR, "node_modules", "mermaid");
const SOURCE = join(SOURCE_DIR, "dist", "mermaid.min.js");
const TARGET = join(SCRIPT_DIR, "public", "mermaid", "mermaid.min.js");

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

if (!existsSync(SOURCE)) {
  fail(`找不到 ${SOURCE},先在 web-ui 里执行 bun install`);
}

// srcdoc iframe 没有 base URL,用 <script src> 挂全局是最省事的加载方式。这只在 mermaid 继续
// 提供「经典脚本 + globalThis.mermaid」时成立;上游哪天只发纯 ESM,必须先在这里发现,
// 而不是等界面渲染不出图再去浏览器控制台查。
const bundle = readFileSync(SOURCE);
if (!bundle.includes('globalThis["mermaid"]')) {
  fail("mermaid.min.js 没有挂 globalThis.mermaid,iframe 的加载方式需要重新设计");
}

let version = "unknown";
try {
  version = String(JSON.parse(readFileSync(join(SOURCE_DIR, "package.json"), "utf8")).version);
} catch {
  // 版本只用于日志,拿不到不阻塞构建
}

mkdirSync(dirname(TARGET), { recursive: true });
copyFileSync(SOURCE, TARGET);
console.log(`✅ mermaid ${version} → ${TARGET} (${statSync(TARGET).size} 字节)`);
