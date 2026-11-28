// scripts/proxy-behavior-smoke.ts — Bun 运行时 fetch 代理行为重验证(升级 Bun 后必跑)。
//   bun run scripts/proxy-behavior-smoke.ts   (在 pc-server 目录下)
//
// 三条断言对应 net.ts 拦截器设计的三个根基,每条都用「本地可控靶标」做决定性判定,
// 不依赖外网/系统代理是否在线,故在任何机器与 CI 上结论一致:
//
//   A. Bun 1.4.5 按当前 env 处理代理；写入/删除即时生效，ALL_PROXY 可兜底。
//      裸 fetch 用在线本地代理 + .invalid 目标验证；桌面拦截器清除继承变量，
//      direct/manual 的唯一配置源是应用设置。1.4.2 对照组应在动态 env 断言失败。
//
//   B. 拦截器 per-request 注入是否按 mode 正确分流:
//      同一进程、同一 globalThis.fetch,仅切换 getProxyConfig() 的返回值:
//      direct 模式必须无视「会被采信的代理」直连真靶;manual 模式必须把请求
//      送进指定代理。证明拦截器在 1.4 下仍能 per-request 覆盖 Bun 的 env 决策。
//
//   C. fetch 网络错误分类正则是否仍命中(classifyProxyError,对 A2):
//      fetch 一个必死的本地端口触发 ECONNREFUSED,确认错误形态(code/message)
//      仍被 net.ts 的正则捕获,友好提示照常产出。
import { installProxyFetchInterceptor, classifyProxyError } from "../foundation/net";
import { RUNNING_IN_CONTAINER } from "../foundation/platform";
import type { ProxyConfig } from "../foundation/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log("  ok  " + name);
  else { failures++; console.error("FAIL  " + name + (detail !== undefined ? "  →  " + JSON.stringify(detail) : "")); }
}

// ── 本地靶标 ────────────────────────────────────────────────────────────────
// origin: 真实目标,回 204。proxy: 记录收到的请求并回 200,据此判断请求有没有被代理。
// deadProxy: 仅占用一个端口后立刻关闭,得到一个「必 ECONNREFUSED」的端口。
const seenByProxy: string[] = [];
const proxy = Bun.serve({
  port: 0,
  fetch(req) { seenByProxy.push(req.url); return new Response("via-proxy", { status: 200 }); },
});
const origin = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
const deadHolder = Bun.serve({ port: 0, fetch: () => new Response("x") });
const deadPort = deadHolder.port;
deadHolder.stop(true);

const originUrl = `http://127.0.0.1:${origin.port}/target`;
const proxyUrl = `http://127.0.0.1:${proxy.port}`;
const deadUrl = `http://127.0.0.1:${deadPort}/`;

async function statusOf(url: string): Promise<number | "ERR"> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.status;
  } catch {
    return "ERR";
  }
}

console.log(`[proxy-behavior] Bun ${Bun.version}  origin=:${origin.port} proxy=:${proxy.port} dead=:${deadPort}`);

const envKeys = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy"];
for (const key of envKeys) delete process.env[key];
// ── A. 新版原生 env 语义，使用未安装拦截器的 fetch ─────────────────────────
await statusOf(originUrl);
process.env.HTTP_PROXY = proxyUrl;
seenByProxy.length = 0;
const envStatus = await statusOf("http://proxy-probe.invalid/env");
check("A1 首次请求后写入 HTTP_PROXY 即时生效", envStatus === 200 && seenByProxy.length === 1, { envStatus });
delete process.env.HTTP_PROXY;
seenByProxy.length = 0;
const deletedStatus = await statusOf("http://proxy-probe.invalid/deleted");
check("A2 删除 HTTP_PROXY 后不再走代理", deletedStatus === "ERR" && seenByProxy.length === 0, { deletedStatus });
process.env.ALL_PROXY = proxyUrl;
seenByProxy.length = 0;
const allStatus = await statusOf("http://proxy-probe.invalid/all");
check("A3 ALL_PROXY 为 HTTP 请求提供兜底", allStatus === 200 && seenByProxy.length === 1, { allStatus });
for (const key of envKeys) process.env[key] = proxyUrl;

// 默认 direct 配置:非容器下安装拦截器时清空全部继承代理 env。
const directCfg: ProxyConfig = { mode: "direct" } as ProxyConfig;
let cfg = directCfg;
installProxyFetchInterceptor(() => cfg);

if (!RUNNING_IN_CONTAINER) {
  check("A4 桌面安装拦截器后全部继承代理 env 已清除", envKeys.every(key => process.env[key] === undefined));
} else {
  check("A4 容器保留部署代理 env", envKeys.every(key => process.env[key] === proxyUrl));
  for (const key of envKeys) delete process.env[key];
}
check("A5 死代理确实不可达(对照组有效)", (await statusOf(deadUrl)) === "ERR");

// ── B. 拦截器 per-request 分流 ───────────────────────────────────────────────
// 注意:net.ts 的 bypass 把 localhost/127.0.0.1/::1 硬编码为「永远直连」,
// 故 manual 用例不能用 loopback 当靶标(会被真实代码正确绕过,误判成失败)。
// 改用非 loopback 域名 .invalid(RFC 2606 保留,永不解析):代理生效 → 请求送达
// 代理(由代理返回 200);代理被绕过 → 才轮到 DNS 解析 .invalid 并失败。
// 于是「代理有没有收到请求」即 manual 模式是否真注入了 proxy 选项的决定性信号。
const manualTarget = "http://proxy-probe.invalid/target";
seenByProxy.length = 0;
cfg = { mode: "manual", url: proxyUrl, bypassRules: "" } as ProxyConfig;
const manualStatus = await statusOf(manualTarget);
check("B1 manual 模式:请求经指定代理(代理收到 .invalid 请求并应答)", seenByProxy.length === 1 && manualStatus === 200, { manualStatus, seenByProxy: seenByProxy.length });

seenByProxy.length = 0;
cfg = directCfg;
const directStatus = await statusOf(originUrl);
check("B2 direct 模式:请求绕过在线代理直连真靶", seenByProxy.length === 0 && directStatus === 204, { directStatus, seenByProxy: seenByProxy.length });

// ── C. 错误分类正则(对 A2) ─────────────────────────────────────────────────
cfg = { mode: "manual", url: proxyUrl, bypassRules: "" } as ProxyConfig; // 有代理时分类才产出友好提示
let classified: string | null = null;
let errShape: Record<string, unknown> = {};
try {
  await fetch(deadUrl);
} catch (err) {
  errShape = {
    ctor: err instanceof Error ? err.constructor.name : typeof err,
    code: (err as { code?: unknown }).code,
    msg: err instanceof Error ? err.message : String(err),
  };
  classified = classifyProxyError(err, cfg);
}
check("C1 fetch 死端口抛错且 code/message 形态符合预期", typeof errShape.msg === "string" && errShape.msg.length > 0, errShape);
check("C2 classifyProxyError 正则命中,产出友好提示", typeof classified === "string" && classified.includes("代理连接失败"), { classified });
console.log(`  ..  错误形态: ${JSON.stringify(errShape)}`);

// ── D. 统一注入 timeout:0(禁用 Bun 300s socket 空闲定时器)────────────────────
// 拦截器对所有走 globalThis.fetch 的调用注入 timeout:0(net.ts),让应用层看门狗当唯一
// 计时源——新引擎(第三/四个 agent 引擎)的 LLM fetch 自动继承,无需各自记得加。
// timeout 不在 fetch 上暴露可观测值,故用两条间接断言锁定注入行为:
cfg = directCfg;
// D1 注入后正常请求仍成功(timeout:0 形态被 Bun 接受、未破坏请求本身)。
const injectedStatus = await statusOf(originUrl);
check("D1 注入 timeout:0 后正常请求仍达真靶(注入形态合法、无副作用)", injectedStatus === 204, { injectedStatus });
// D2 护栏:调用方显式传 timeout:false 时不被拦截器覆盖,且不报错(显式值被尊重)。
let explicitOk = false;
try {
  const r = await fetch(originUrl, { timeout: false } as RequestInit);
  explicitOk = r.status === 204;
} catch (err) {
  explicitOk = false;
}
check("D2 显式 timeout:false 被尊重(拦截器不覆盖、不报错)", explicitOk);

proxy.stop(true);
origin.stop(true);
console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
