// scripts/deploy-portable.ts — 便携版成对部署 + 新 exe 冒烟。
//
// 为什么要有这个脚本:0.1.5 的便携目录曾经出现「前端换了 0.1.5、后端 exe 还是 0.1.4」的
// 错配,界面点 AgentBot 开关只弹 "Not found"(旧 exe 根本没有 settings/agent-loop 路由),
// 从代码侧查半天查不出问题——因为代码是对的,错的是部署。手动 cp 一个文件太容易只换一半。
//
// 纪律:
//   1. 先冒烟后落盘。探针起的是「源 exe」,不是拷贝后的;探针失败一个字节都不写目标目录。
//   2. 成对搬运。exe + web-ui/build/client + icons/fonts 一次搬完,旧哈希先清再拷。
//   3. 覆盖前备份。目标已有 exe 时先复制到 <target>/backup-<时间戳>/。
//   4. 不猜路径。--target 必填,缺了就报错退出。
//
// 用法: bun run scripts/deploy-portable.ts --target "D:/Software/Produce/RikkaHub_portable"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

/** 冒烟探针端口:避开默认 17455,免得撞上用户正在跑的实例。 */
const PROBE_PORT_BASE = 17599;
/** exe 必须含有这个路由才算「带 AgentBot 设置」的构建。 */
const REQUIRED_ROUTE = "settings/agent-loop";

function fail(message: string): never {
  console.error(`[deploy-portable] 失败: ${message}`);
  process.exit(1);
}

function parseTarget(argv: string[]): string {
  const index = argv.indexOf("--target");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  if (!raw) fail("缺少 --target <便携目录>。例: --target \"D:/Software/Produce/RikkaHub_portable\"");
  const target = resolve(raw);
  if (!existsSync(target)) fail(`目标目录不存在: ${target}`);
  return target;
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 二进制里直接找路由字符串:比起进程便宜,能提前拦掉「编译产物是旧的」这种错。 */
function assertRouteInBinary(exePath: string): void {
  const bytes = readFileSync(exePath);
  if (!bytes.includes(REQUIRED_ROUTE)) {
    fail(`${exePath} 不含 ${REQUIRED_ROUTE}，这是旧构建。先 cd pc-server && bun run compile。`);
  }
}

async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // 还没起来，继续等
    }
    await Bun.sleep(300);
  }
  return false;
}

/** 起源 exe 做冒烟:路由存在(非 404)才算这个 exe 与当前界面配套。 */
async function probe(exePath: string): Promise<void> {
  const probeData = join(tmpdir(), `rkh-deploy-probe-${Date.now()}`);
  mkdirSync(probeData, { recursive: true });

  let port = PROBE_PORT_BASE;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const busy = await fetch(`http://127.0.0.1:${port}/api/settings`, { signal: AbortSignal.timeout(500) })
      .then(() => true)
      .catch(() => false);
    if (!busy) break;
    port += 1;
  }

  const proc = Bun.spawn([exePath], {
    cwd: probeData,
    env: { ...process.env, PORT: String(port), RIKKAHUB_PC_DATA_DIR: probeData },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    if (!(await waitForServer(port, 40_000))) fail("探针 exe 启动超时（40s 内 /api/settings 未就绪）");

    const res = await fetch(`http://127.0.0.1:${port}/api/settings/agent-loop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) {
      fail(`探针 exe 对 ${REQUIRED_ROUTE} 返回 404：这个后端不带当前界面需要的设置接口，拒绝部署。`);
    }
    if (!res.ok) fail(`探针 POST ${REQUIRED_ROUTE} 返回 ${res.status}，预期 200。`);

    console.log(`[deploy-portable] 冒烟通过: ${REQUIRED_ROUTE} → 200`);
  } finally {
    try {
      await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST", signal: AbortSignal.timeout(3000) });
    } catch {
      // 已经退出
    }
    await Bun.sleep(800);
    proc.kill();
    rmSync(probeData, { recursive: true, force: true });
  }
}

function uiHash(uiDir: string): string {
  const html = readFileSync(join(uiDir, "index.html"), "utf8");
  return html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? "(未找到入口脚本)";
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const pcServerDir = resolve(import.meta.dir, "..");

  const srcExe = join(repoRoot, "dist", "rikkahub-pc.exe");
  const srcUi = join(repoRoot, "web-ui", "build", "client");

  // ---- 前置校验:源产物缺一个就停,不碰目标目录 ----
  if (!existsSync(srcExe)) fail(`源 exe 不存在: ${srcExe}（先 cd pc-server && bun run compile）`);
  if (!existsSync(join(srcUi, "index.html"))) fail(`前端产物不存在: ${srcUi}（先 cd web-ui && bun run build）`);
  assertRouteInBinary(srcExe);

  const srcStat = statSync(srcExe);
  console.log(`[deploy-portable] 源 exe: ${srcExe} (${srcStat.size} 字节, ${srcStat.mtime.toLocaleString()})`);
  console.log(`[deploy-portable] 源前端: ${uiHash(srcUi)}`);

  // ---- 冒烟:先证明这个 exe 能用,再动目标 ----
  await probe(srcExe);

  // ---- 备份目标已有的 exe（同尺寸说明本来就是同一版，重复备份只会堆垃圾） ----
  const targetExe = join(target, "rikkahub-pc.exe");
  if (existsSync(targetExe) && statSync(targetExe).size !== srcStat.size) {
    const backupDir = join(target, `backup-${stamp()}`);
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(targetExe, join(backupDir, "rikkahub-pc.exe"));
    console.log(`[deploy-portable] 已备份旧 exe → ${backupDir}`);
  }

  // ---- 成对搬运 ----
  // 目标 exe 被运行中的 RikkaHub 占用时 copyFileSync 会抛 EBUSY/EPERM，
  // 直接抛栈对用户没用——这里翻译成一句能照做的提示。
  try {
    copyFileSync(srcExe, targetExe);
  } catch (err) {
    fail(`覆盖 ${targetExe} 失败（多半还在运行）：先退出 RikkaHub.exe 再重跑。原始错误: ${String(err)}`);
  }
  const targetUi = join(target, "web-ui", "build", "client");
  rmSync(targetUi, { recursive: true, force: true });
  mkdirSync(targetUi, { recursive: true });
  cpSync(srcUi, targetUi, { recursive: true, force: true });

  // icons / fonts / yukkuri-sdk 紧挨 exe 落地:漏了会让品牌 Logo 与内置字体静默回退兜底,
  // 油库里语音则直接「引擎未就绪」(paths.ts 的 yukkuriSdkDir 按 rootDir 解析)。
  for (const assetDir of ["icons", "fonts", "yukkuri-sdk"] as const) {
    const from = join(repoRoot, assetDir);
    if (!existsSync(from)) continue;
    cpSync(from, join(target, assetDir), { recursive: true, force: true });
  }

  // koffi 原生件按它自己的搜索布局放 exe 同级(见 media/yukkuri/native-shim.ts):
  // 缺了它,便携版点朗读会报「Cannot find the native Koffi module」。
  const addonFrom = join(pcServerDir, "node_modules", "@koromix", "koffi-win32-x64", "win32_x64", "koffi.node");
  if (existsSync(addonFrom)) {
    const addonTo = join(target, "koffi", "build", "win32_x64", "koffi.node");
    mkdirSync(dirname(addonTo), { recursive: true });
    cpSync(addonFrom, addonTo, { force: true });
    console.log(`[deploy-portable] koffi.node -> ${addonTo}`);
  } else {
    console.warn("[deploy-portable] 警告:未找到 @koromix/koffi-win32-x64,便携版里的油库里语音将不可用(先 bun install)。");
  }

  const finalStat = statSync(targetExe);
  console.log(`[deploy-portable] 目标 exe: ${targetExe} (${finalStat.size} 字节)`);
  console.log(`[deploy-portable] 目标前端: ${uiHash(targetUi)}`);
  if (finalStat.size !== srcStat.size) fail("拷贝后大小与源不一致，目标可能被占用，请关闭 RikkaHub 后重跑。");
  console.log("[deploy-portable] 完成。重启 RikkaHub.exe 生效。");
}

await main();
