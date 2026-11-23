// tools/mcp-builtin-moegirl.ts — 内置 @rikkahub/moegirl 工具的执行体
//
// 定位：萌娘百科（zh.moegirl.org.cn）的垂直检索。与 search_web / scrape_web / mcp__fetch
// 互补——那三者面向通用网页，本工具面向「梗 / 角色 / 番剧 / 东方」这一座站，把已实测的
// 三步读法（搜索 → 导语＋目录 → 指定章节）与 gRPC-web 网友评论取出来。
//
// 移植源：ODO-TECH/MoegirlMCP（src/core.js + src/site.js，2026-11-18 拉到 reference/）。
// 请求参数、切段规则、gRPC 字段号、限流数值逐字对齐其实测结论；只有三处刻意不同：
//   ① UA 用品牌串（foundation/net getDefaultUserAgent），不再带项目自己的版本号；
//   ② 缓存放 pc-data/wiki-cache（与 updatesCacheDir 同口径），不写 ~/.cache；
//   ③ 出站统一走 fetchWithTimeout，从而继承应用的代理、超时与日志纪律。
//
// 纪律：不读写 state，不依赖 api 层；请求日志由调用方（mcp.ts 的内置分支）统一记录。
//
// 安全边界：三个工具的入参只有关键词/标题/章节/条数，**没有任何 URL 入口**，目的地锁在
// zh.moegirl.org.cn 与 api.moegirl.org.cn 两个常量上。因此不存在 mcp__fetch 那种
// 「让模型抓一个链接」打到本机 127.0.0.1 的 SSRF 面，也就不需要 assertPublicDestination。
//
// 上游约束（照搬，不是本地发明）：萌百匿名只开放 opensearch / generator=search /
// prop=extracts / prop=info 四类读，list=search 与 parse 要登录；软限流实测连发约 7 次即超时、
// 停约 20s 恢复，百次级触 WAF。所以这里全局串行 + 2.5s 节拍 + 失败退避 + 缓存。
// 内容许可 CC BY-NC-SA 4.0（robots 亦声明 ai-train=no）：只做按需检索与摘要，引用必须带来源
// 链接，不镜像全文、不用于商业训练——这条写进工具描述，输出里始终带 url。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "../foundation/types";
import { fetchWithTimeout, getDefaultUserAgent } from "../foundation/net";
import { wikiCacheDir } from "../foundation/paths";
import { isRecord } from "../foundation/utils";

/** 模型侧看到的工具名（mcp.ts 会加 `mcp__` 前缀），与上游 MoegirlMCP 保持一致。 */
export const MOEGIRL_SEARCH_TOOL_NAME = "moe_search";
export const MOEGIRL_GET_TOOL_NAME = "moe_get";
export const MOEGIRL_COMMENTS_TOOL_NAME = "moe_comments";

const API_URL = "https://zh.moegirl.org.cn/api.php";
const GRPC_BASE = "https://api.moegirl.org.cn/moegirl.moepad.MoepadCommunityService/";
const PAGE_BASE = "https://zh.moegirl.org.cn/";

/** 最小请求间隔：萌百连发约 7 次即软限流，上游实测取 2.5s 保守值。
 *  两个节奏量都可被环境变量改：测试要把秒级等待压成毫秒，真实用户也可能需要更保守的间隔。
 *  刻意惰性读取而不是模块顶层常量——顶层常量在 import 时就定值，调用方设环境变量已经晚了。 */
const DEFAULT_MIN_INTERVAL_MS = 2_500;
const DEFAULT_BACKOFF_MS = 20_000;

function envMillis(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function minIntervalMs(): number {
  return envMillis("RIKKAHUB_WIKI_MIN_INTERVAL_MS", DEFAULT_MIN_INTERVAL_MS);
}

function backoffMs(): number {
  return envMillis("RIKKAHUB_WIKI_BACKOFF_MS", DEFAULT_BACKOFF_MS);
}

/** Action API 最多 3 次尝试；评论服务（gRPC）只试 2 次——403/WAF 反复敲只会更糟。 */
const API_MAX_ATTEMPTS = 3;
const GRPC_MAX_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 30_000;
/** 与上游一致：搜索摘要 150 字、导语 1200 字、单章默认 3000 字。 */
const SNIPPET_CHARS = 150;
const LEAD_CHARS = 1_200;
const DEFAULT_SECTION_CHARS = 3_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** 缓存文件的最长寿命：磁盘层没有逐项 TTL（键里不带类型），统一按最长期限判死。 */
const CACHE_FILE_MAX_AGE_MS = WEEK;

/** 工具内部的「可解释失败」：转成 isError 的 MCP 结果回灌模型，而不是 JSON-RPC 层报错。 */
class MoegirlRefused extends Error {}

/** 限流/服务抖动类失败：退避后重试（萌百的 WAF 就是靠 20s 冷却恢复的）。 */
class MoegirlRetryable extends Error {}

/** 只有这类状态码值得再敲一次门：408 超时、429 限流、5xx 服务端。
 *  400/401/403/404 重试只是多打一遍同样的请求，还会把一次调用拖成三次退避。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

// ── 梗别名表 ──────────────────────────────────────────────────
// 口语/梗名 → 正式条目名。仅在搜索 0 命中时启用（上游 src/aliases.json 的 13 条，逐字保留）。
// 内联成常量而不是 JSON 文件：单文件 exe 里读不到包外的 json，而这张表本来就要随构建进产物。

const ALIASES: Readonly<Record<string, string>> = {
  红白: "博丽灵梦",
  黑白: "雾雨魔理沙",
  十万巫女: "博丽灵梦",
  "⑨": "琪露诺",
  "笨蛋⑨": "琪露诺",
  "姆Q": "帕秋莉·诺蕾姬",
  "紫妈": "八云紫",
  "花妈": "风见幽香",
  "青蛙子": "泄矢诹访子",
  "受兔": "铃仙·优昙华院·因幡",
  "大小姐": "蕾米莉亚·斯卡蕾特",
  "二小姐": "芙兰朵露·斯卡蕾特",
  "中国": "红美铃",
};

function resolveAlias(query: string): string | undefined {
  return ALIASES[query] ?? ALIASES[query.toLowerCase()];
}

// ── 串行节拍 ──────────────────────────────────────────────────

let lastRequestAt = 0;
/** 所有出站请求排一条队：并发是萌百 WAF 的头号触发条件，队列本身即限速器。 */
let queue: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 不让一次退避把进程吊着不放（测试退出、便携版退出时都靠这个）。
    timer.unref?.();
  });
}

async function pace(): Promise<void> {
  const wait = lastRequestAt + minIntervalMs() - Date.now();
  if (wait > 0) await sleep(wait);
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  // 队尾吞掉失败：一次 404 不该让后续请求跟着抛同一个错。
  queue = next.catch(() => undefined);
  return next;
}

// ── 两级缓存：内存 LRU + 磁盘 ─────────────────────────────────

interface CacheEntry {
  at: number;
  data: JsonValue;
}

const memoryCache = new Map<string, CacheEntry>();
const MEMORY_CACHE_LIMIT = 500;

/** 缓存根目录：默认落在 pc-data 下；RIKKAHUB_WIKI_CACHE_DIR 让测试指到临时目录。 */
function cacheDir(): string {
  const override = process.env.RIKKAHUB_WIKI_CACHE_DIR?.trim();
  return override ? override : wikiCacheDir;
}

function cacheFile(key: string): string {
  return join(cacheDir(), `${createHash("sha1").update(key).digest("hex")}.json`);
}

function rememberCache(key: string, data: JsonValue, at: number): void {
  memoryCache.set(key, { at, data });
  if (memoryCache.size <= MEMORY_CACHE_LIMIT) return;
  // 按写入时间淘汰最旧的一批，而不是依赖 Map 的插入序（重放/命中会让插入序失真）。
  const overflow = memoryCache.size - MEMORY_CACHE_LIMIT;
  const oldest = [...memoryCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, overflow);
  for (const [keyToRemove] of oldest) memoryCache.delete(keyToRemove);
}

function cacheGet(key: string, ttlMs: number): JsonValue | null {
  if (ttlMs <= 0) return null;
  const hit = memoryCache.get(key);
  if (hit) {
    if (Date.now() - hit.at < ttlMs) return hit.data;
    memoryCache.delete(key);
  }
  let stored: unknown;
  try {
    const file = cacheFile(key);
    if (!existsSync(file)) return null;
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(stored)) return null;
  const at = Number(stored.at ?? 0);
  const data = stored.data as JsonValue;
  if (!(at > 0) || !data || Date.now() - at >= ttlMs) {
    try {
      rmSync(cacheFile(key), { force: true });
    } catch {
      // 删不掉（只读盘/正被占用）不影响正确性：下次读还是按 TTL 判过期。
    }
    return null;
  }
  rememberCache(key, data, at);
  return data;
}

function cacheSet(key: string, data: JsonValue): void {
  const at = Date.now();
  rememberCache(key, data, at);
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cacheFile(key), JSON.stringify({ at, data }));
  } catch {
    // 缓存是优化不是功能：写不进去只是下次多打一次上游。
  }
}

/** 回收过期缓存文件（persistence/data-dir-hygiene 在启动后异步调用）。返回删除条数。 */
export function sweepWikiCache(now = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(cacheDir());
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(cacheDir(), name);
    let at = 0;
    try {
      const stored = JSON.parse(readFileSync(file, "utf8"));
      at = isRecord(stored) ? Number(stored.at ?? 0) : 0;
    } catch {
      at = 0; // 读不出来的当成 0，直接回收
    }
    if (now - at >= CACHE_FILE_MAX_AGE_MS) {
      try {
        rmSync(file, { force: true });
        removed++;
      } catch {
        // 仍被占用就留着，下次启动再清。
      }
    }
  }
  return removed;
}

// ── MediaWiki Action API ──────────────────────────────────────

/**
 * 带节拍/退避/缓存的一次 Action API 调用。ttlMs>0 时命中缓存直接返回，零网络开销。
 * 失败按上游口径退避 20s 再试；业务性失败（坏状态码、接口 error 体）不重试。
 */
async function callApi(params: Record<string, JsonValue>, ttlMs = 0): Promise<Record<string, JsonValue>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  query.set("format", "json");
  const cacheKey = `api:${query.toString()}`;
  if (ttlMs > 0) {
    const hit = cacheGet(cacheKey, ttlMs);
    if (isRecord(hit)) return hit;
  }
  return enqueue(async () => {
    for (let attempt = 0; attempt < API_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(backoffMs());
      await pace();
      lastRequestAt = Date.now();
      try {
        const response = await fetchWithTimeout(`${API_URL}?${query.toString()}`, {
          headers: { "User-Agent": getDefaultUserAgent(), Accept: "application/json" },
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (!response.ok) {
          throw isRetryableStatus(response.status)
            ? new MoegirlRetryable(`zh.moegirl.org.cn returned HTTP ${response.status}`)
            : new MoegirlRefused(`zh.moegirl.org.cn returned HTTP ${response.status}`);
        }
        const json = (await response.json()) as JsonValue;
        if (!isRecord(json)) throw new MoegirlRefused("zh.moegirl.org.cn returned a malformed response");
        if (isRecord(json.error)) {
          throw new MoegirlRefused(`${String(json.error.code ?? "error")}: ${String(json.error.info ?? "")}`);
        }
        if (ttlMs > 0) cacheSet(cacheKey, json);
        return json;
      } catch (err) {
        if (err instanceof MoegirlRefused) throw err;
        if (attempt === API_MAX_ATTEMPTS - 1) {
          throw new MoegirlRefused(err instanceof Error ? err.message : String(err));
        }
      }
    }
    throw new MoegirlRefused("unreachable");
  });
}

/** pages 字典 → 按 index 排序的页面数组（API 的 key 是页名，枚举顺序不可信）。 */
function pagesInIndexOrder(json: Record<string, JsonValue>): Array<Record<string, JsonValue>> {
  const query = isRecord(json.query) ? json.query : {};
  const pages = isRecord(query.pages) ? query.pages : {};
  return Object.values(pages)
    .filter(isRecord)
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
}

function pageUrl(title: string): string {
  return PAGE_BASE + encodeURIComponent(title.replace(/ /g, "_"));
}

function clamp(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…[截断]` : text;
}

// ── 第一级：search ────────────────────────────────────────────

interface SearchLevel {
  hits: Array<{ title: string; pageid: number; snippet: string; url: string }>;
  more: boolean;
  aliasUsed?: string;
}

async function doSearch(query: string, limit: number, offset: number): Promise<SearchLevel> {
  // 匿名白名单只有 generator=search + prop=extracts，一次请求同时拿到列表与摘要。
  const json = await callApi(
    {
      action: "query",
      generator: "search",
      gsrsearch: query,
      gsrlimit: limit,
      gsroffset: offset,
      prop: "extracts",
      exintro: 1,
      explaintext: 1,
      exsentences: 2,
    },
    HOUR,
  );
  return {
    hits: pagesInIndexOrder(json).map((page) => ({
      title: String(page.title ?? ""),
      pageid: Number(page.pageid ?? 0),
      snippet: clamp(String(page.extract ?? ""), SNIPPET_CHARS),
      url: pageUrl(String(page.title ?? "")),
    })),
    more: Boolean(json.continue),
  };
}

export async function moegirlSearch(query: string, limit = 6, offset = 0): Promise<JsonValue> {
  let level = await doSearch(query, limit, offset);
  if (level.hits.length === 0 && offset === 0) {
    const alias = resolveAlias(query);
    if (alias) level = { ...(await doSearch(alias, limit, offset)), aliasUsed: alias };
  }
  return { query, ...level };
}

// ── 第二/三级：get（导语＋目录 / 指定章节）────────────────────

interface Section {
  name: string;
  chars: number;
  body: string;
}

/** 按 wikitext 标题行（== X ==）切段。prop=extracts 给的是纯文本，标题以等号形态保留。 */
function splitSections(text: string): { lead: string; sections: Section[] } {
  const marks: Array<{ name: string; start: number }> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const matched = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
    if (matched) marks.push({ name: matched[2]!, start: offset });
    offset += line.length + 1;
  }
  const lead = marks.length > 0 ? text.slice(0, marks[0]!.start) : text;
  const sections = marks.map((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1]!.start : text.length;
    return { name: mark.name, chars: end - mark.start, body: text.slice(mark.start, end) };
  });
  return { lead, sections };
}

async function extractOf(title: string, ttlMs: number): Promise<{ title: string; text: string }> {
  const json = await callApi({ action: "query", titles: title, prop: "extracts|info", explaintext: 1, redirects: 1 }, ttlMs);
  const page = pagesInIndexOrder(json)[0];
  if (!page || "missing" in page) throw new MoegirlRefused(`条目不存在: ${title}`);
  return { title: String(page.title ?? title), text: String(page.extract ?? "") };
}

export async function moegirlGet(title: string, options: { section?: string; maxChars?: number } = {}): Promise<JsonValue> {
  const maxChars = options.maxChars ?? DEFAULT_SECTION_CHARS;
  const page = await extractOf(title, DAY);
  const url = pageUrl(page.title);
  const { lead, sections } = splitSections(page.text);
  const requested = options.section;
  if (requested === undefined || requested === null || requested === "") {
    // 第二级：只给导语和目录，让模型自己决定读哪一章，别把整篇灌进上下文。
    return {
      title: page.title,
      url,
      totalChars: page.text.length,
      lead: clamp(lead.trim(), LEAD_CHARS),
      sections: sections.map((section) => ({ name: section.name, chars: section.chars })),
      hint: "用 section 参数（章节名或序号）取指定章节全文，避免整篇灌入上下文。",
    };
  }
  const section = /^\d+$/.test(requested)
    ? sections[Number(requested) - 1]
    : sections.find((entry) => entry.name === requested) ?? sections.find((entry) => entry.name.includes(requested));
  if (!section) {
    throw new MoegirlRefused(
      `章节不存在: ${requested}；可选: ${sections.map((entry) => entry.name).join(" / ") || "（无章节）"}`,
    );
  }
  // 第三级：单章正文。truncated 按「切出来有没有被 clamp 咬掉」判，不是按 maxChars 猜。
  const text = clamp(section.body.trim(), maxChars);
  return { title: page.title, url, section: section.name, text, truncated: text.length < section.body.trim().length };
}

// ── 网友评论：gRPC-web 最小实现 ───────────────────────────────
// 协议形态逆向自浏览器抓包，与上游 moe_comments.py 的实测结论逐字对齐：
//   请求帧 = base64(0x00 + 4 字节大端长度 + protobuf)；Content-Type: application/grpc-web-text+proto
//   响应是裸 grpc-web 二进制：按 帧头(1)+长度(4BE) 剥帧，只留数据帧 0x00、跳过 trailer 0x80
//   评论正文挂在 Quill delta 的 JSON 串里（field 7，实测不是 12）；user=5、time=14{1:varint}、IP 属地=19

const b64 = (bytes: Buffer): string => bytes.toString("base64");

function strField(tag: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
}

function varField(tag: number, value: number): Buffer {
  const out: number[] = [tag];
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    out.push(byte | (rest ? 0x80 : 0));
  } while (rest);
  return Buffer.from(out);
}

/** grpc-web-text 帧：flag(1)=0 + 长度(4BE) + 消息，整体再 base64。 */
function frame(message: Buffer): string {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(message.length, 1);
  return b64(Buffer.concat([header, message]));
}

interface PbField {
  /** 字段号 */
  f: number;
  /** wire type */
  w: number;
  v: bigint | Buffer;
}

/** 只解 protobuf 的 varint / length-delimited / fixed64 / fixed32 四类，够评论面用。 */
function pbFields(bytes: Buffer): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  const varint = (): bigint => {
    let value = 0n;
    let shift = 0n;
    while (i < bytes.length) {
      const byte = bytes[i++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return value;
  };
  while (i < bytes.length) {
    const tag = Number(varint());
    const f = tag >> 3;
    const w = tag & 7;
    if (w === 0) out.push({ f, w, v: varint() });
    else if (w === 2) {
      const n = Number(varint());
      if (i + n > bytes.length) break;
      out.push({ f, w, v: bytes.subarray(i, i + n) });
      i += n;
    } else if (w === 5) {
      out.push({ f, w, v: bytes.subarray(i, i + 4) });
      i += 4;
    } else if (w === 1) {
      out.push({ f, w, v: bytes.subarray(i, i + 8) });
      i += 8;
    } else break; // group 等冷门 wire type：无法安全跳过，就此收束
  }
  return out;
}

const utf8 = (bytes: Buffer): string => Buffer.from(bytes).toString("utf8");

/** 把裸 grpc-web 响应剥成「数据帧拼接」：只认 0x00 数据帧，trailer 0x80 与其余一律跳过。 */
function unwrapGrpcFrames(bytes: Buffer): Buffer {
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 5 <= bytes.length) {
    const flag = bytes[i]!;
    const n = bytes.readUInt32BE(i + 1);
    if (n < 0 || i + 5 + n > bytes.length) break;
    if (flag === 0x00) parts.push(bytes.subarray(i + 5, i + 5 + n));
    i += 5 + n;
  }
  return Buffer.concat(parts);
}

async function grpcCall(method: string, framedBody: string): Promise<Buffer> {
  return enqueue(async () => {
    for (let attempt = 0; attempt < GRPC_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(backoffMs());
      await pace();
      lastRequestAt = Date.now();
      try {
        const response = await fetchWithTimeout(GRPC_BASE + method, {
          method: "POST",
          headers: { "Content-Type": "application/grpc-web-text+proto", "User-Agent": getDefaultUserAgent() },
          body: framedBody,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (!response.ok) {
          throw isRetryableStatus(response.status)
            ? new MoegirlRetryable(`api.moegirl.org.cn returned HTTP ${response.status}`)
            : new MoegirlRefused(`api.moegirl.org.cn returned HTTP ${response.status}`);
        }
        let bytes = Buffer.from(await response.arrayBuffer());
        // 'A'(0x41) 开头说明服务端回的是 grpc-web-text（base64 文本），先解回二进制。
        if (bytes[0] === 0x41) bytes = Buffer.from(bytes.toString("latin1"), "base64");
        return unwrapGrpcFrames(bytes);
      } catch (err) {
        if (err instanceof MoegirlRefused) throw err;
        if (attempt === GRPC_MAX_ATTEMPTS - 1) {
          throw new MoegirlRefused(err instanceof Error ? err.message : String(err));
        }
      }
    }
    throw new MoegirlRefused("unreachable");
  });
}

async function pageidOf(title: string): Promise<{ pageid: number; title: string }> {
  const json = await callApi({ action: "query", titles: title, prop: "info", redirects: 1 }, DAY);
  const page = pagesInIndexOrder(json)[0];
  if (!page || "missing" in page) throw new MoegirlRefused(`条目不存在: ${title}`);
  return { pageid: Number(page.pageid ?? 0), title: String(page.title ?? title) };
}

/** pageid → board id：评论服务没有声明字段号，上游实测的唯一取法是扫可打印串取首个纯数字。 */
async function boardIdOf(pageid: number): Promise<string> {
  const cacheKey = `board:${pageid}`;
  const hit = cacheGet(cacheKey, WEEK);
  if (typeof hit === "string" && hit) return hit;
  const payload = await grpcCall(
    "GetWikiPageArticleByWikiPageIdWithUserInfo",
    frame(Buffer.concat([strField(0x0a, "moegirl-zh"), strField(0x12, String(pageid))])),
  );
  const board = utf8(payload)
    .match(/[ -~一-鿿]{3,}/g)
    ?.map((candidate) => candidate.trim())
    .find((candidate) => /^\d{1,7}$/.test(candidate));
  if (!board) throw new MoegirlRefused("该页面没有评论区");
  cacheSet(cacheKey, board);
  return board;
}

/**
 * 深链评论行。用 type 而不是 interface:返回值要落进 JsonValue,
 * interface 没有隐式索引签名会卡在 assignable 上(TS2322)。
 */
type CommentRow = {
  user?: string;
  text: string;
  time?: string;
  ip?: string;
};

/** 深度优先找「挂着 Quill delta JSON 串」的节点，按实测字段号取 user/time/ip。 */
function parseComments(payload: Buffer): CommentRow[] {
  const comments: CommentRow[] = [];
  const walk = (bytes: Buffer, depth: number): void => {
    if (depth > 6) return;
    const fields = pbFields(bytes);
    const delta = fields.find(
      (field) => (field.f === 7 || field.f === 12) && field.w === 2 && field.v instanceof Buffer && utf8(field.v).startsWith('[{"insert"'),
    );
    if (delta && delta.v instanceof Buffer) {
      const pick = (n: number) => fields.find((field) => field.f === n);
      const bytesOf = (n: number): Buffer | null => {
        const field = pick(n);
        return field?.w === 2 && field.v instanceof Buffer ? field.v : null;
      };
      let text = "";
      try {
        const ops = JSON.parse(utf8(delta.v)) as Array<{ insert?: unknown }>;
        text = ops.map((op) => (typeof op.insert === "string" ? op.insert : "")).join("").trim();
      } catch {
        // delta 畸形时留空文本，这一条仍算「有一条评论」，不让整批失败。
      }
      let time: string | undefined;
      const stamp = pick(14);
      if (stamp?.w === 2 && stamp.v instanceof Buffer) {
        const inner = pbFields(stamp.v).find((field) => field.f === 1 && field.w === 0);
        if (typeof inner?.v === "bigint") time = new Date(Number(inner.v) * 1000).toISOString();
      }
      const user = bytesOf(5);
      const ip = bytesOf(19);
      comments.push({
        ...(user ? { user: utf8(user) } : {}),
        text,
        ...(time ? { time } : {}),
        ...(ip ? { ip: utf8(ip) } : {}),
      });
      return;
    }
    for (const field of fields) {
      if (field.w === 2 && field.v instanceof Buffer) walk(field.v, depth + 1);
    }
  };
  walk(payload, 0);
  return comments;
}

export async function moegirlComments(title: string, limit = 10): Promise<JsonValue> {
  const { pageid, title: real } = await pageidOf(title);
  const board = await boardIdOf(pageid);
  // 内层消息 {3:{1:board,3:limit,4:0,5:1,6:01}}，外层再裹进 field 3(0x1a)。
  const inner = Buffer.concat([
    strField(0x0a, board),
    varField(0x18, limit),
    varField(0x20, 0),
    varField(0x28, 1),
    Buffer.from([0x32, 0x01, 0x01]),
  ]);
  const payload = await grpcCall(
    "GetWikiPageArticleCommentListWithUserInfo",
    frame(Buffer.concat([Buffer.from([0x1a, inner.length]), inner])),
  );
  const comments = parseComments(payload);
  return { title: real, url: pageUrl(real), count: comments.length, comments };
}

// ── 工具定义 ──────────────────────────────────────────────────

const LICENSE_NOTE =
  " Content is CC BY-NC-SA 4.0 and the site asks for reference/summary use only: credit it, keep the url in the result, and never republish an article wholesale.";
const RATE_NOTE =
  " The site rate-limits anonymous callers, so calls here are serialised with a 2.5s gap and cached; never fan out.";

export function moegirlSearchToolDefinition(): Record<string, JsonValue> {
  return {
    name: MOEGIRL_SEARCH_TOOL_NAME,
    description: `Search Moegirl Panda (萌娘百科, zh.moegirl.org.cn) for ACG entries: memes/梗, anime, games, characters, Touhou Project.
First level of a three-step read — results give titles and a ≤150-character snippet, never the article body. Follow up with moe_get.
When the query is a nickname or meme phrase with no hit, this tool retries through a built-in alias table (红白→博丽灵梦, ⑨→琪露诺, 姆Q→帕秋莉…); still nothing means the entry name is wrong, not that the site lacks it.${RATE_NOTE}${LICENSE_NOTE}`.trim(),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词，中文/日文/英文均可，如：博丽灵梦 / 番剧名 / 十万巫女",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 6,
          description: "返回条数，默认 6",
        },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: 10_000,
          default: 0,
          description: "翻页偏移，默认 0",
        },
      },
      required: ["query"],
    },
  };
}

export function moegirlGetToolDefinition(): Record<string, JsonValue> {
  return {
    name: MOEGIRL_GET_TOOL_NAME,
    description: `Read one Moegirl Panda entry, by the title moe_search returned. Levels two and three of the three-step read.
Omit section → lead paragraph (≤1200 chars) plus a table of contents with each section's length; use that to decide what is worth reading.
Pass section (section name, or its 1-based index as a string) → that section's text, capped by maxChars and marked truncated when the cap bit. Never pull a whole article into context.${RATE_NOTE}${LICENSE_NOTE}`.trim(),
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "条目标题（moe_search 返回的 title）",
        },
        section: {
          type: "string",
          description: '章节名或序号（"1"、"2"…）。省略则只返回导语＋目录',
        },
        maxChars: {
          type: "integer",
          minimum: 200,
          maximum: 20_000,
          default: DEFAULT_SECTION_CHARS,
          description: "章节字数上限，默认 3000",
        },
      },
      required: ["title"],
    },
  };
}

export function moegirlCommentsToolDefinition(): Record<string, JsonValue> {
  return {
    name: MOEGIRL_COMMENTS_TOOL_NAME,
    description: `Read the reader comments on a Moegirl Panda entry — the site's separate comment service, giving user name, text, time and IP region as published. Useful for how a meme is actually used or what the community thinks; not a source of facts about the subject itself.
Results are cached for a week, so re-reading an entry costs no network.${RATE_NOTE}${LICENSE_NOTE}`.trim(),
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "条目标题",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 10,
          description: "评论条数，默认 10",
        },
      },
      required: ["title"],
    },
  };
}

// ── 参数校验与执行入口 ────────────────────────────────────────

/** 拒绝而不是静默纠正：让模型在 tool_result 里看到自己写错的那一项（与 mcp-builtin-fetch 同纪律）。 */
function integerArg(value: JsonValue | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  let parsed: number;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) parsed = value;
  else if (typeof value === "string" && /^\d+$/.test(value.trim())) parsed = Number.parseInt(value.trim(), 10);
  else throw new MoegirlRefused(`Invalid ${name}: expected an integer`);
  if (parsed < min || parsed > max) throw new MoegirlRefused(`Invalid ${name}: expected a value from ${min} to ${max}`);
  return parsed;
}

/** 章节名的口径：空串按「不传」处理——模型常把可选字符串写成 ""，而在这套三级读法里
 *  「没有 section」正是「只要导语＋目录」那一档，不该报错。上游 moe_get 同样放行空串。 */
function sectionArg(value: JsonValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new MoegirlRefused("Invalid section: expected a string");
  return value.trim() || undefined;
}

/** 必填文本参数：缺席或空白都当场拒——打上去只会换回一句「条目不存在」，不如在这里说清是谁写错了。 */
function requiredTextArg(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MoegirlRefused(`Invalid ${name}: expected a non-empty string`);
  }
  return value.trim();
}

function toolResult(data: JsonValue, isError: boolean): Record<string, JsonValue> {
  return { content: [{ type: "text", text: JSON.stringify(data) }], isStreaming: false, isError };
}

/** 所有失败都以 isError 的 MCP 结果返回（与真实 MCP 服务器语义一致），不抛 JSON-RPC 层异常。 */
async function guarded(run: () => Promise<JsonValue>): Promise<Record<string, JsonValue>> {
  try {
    return toolResult(await run(), false);
  } catch (err) {
    return toolResult({ error: err instanceof Error ? err.message : String(err) }, true);
  }
}

export function runMoegirlSearchTool(args: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
  return guarded(async () => {
    const query = requiredTextArg(args.query, "query");
    return moegirlSearch(query, integerArg(args.limit, "limit", 6, 1, 20), integerArg(args.offset, "offset", 0, 0, 10_000));
  });
}

export function runMoegirlGetTool(args: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
  return guarded(async () => {
    const title = requiredTextArg(args.title, "title");
    return moegirlGet(title, {
      section: sectionArg(args.section),
      maxChars: integerArg(args.maxChars, "maxChars", DEFAULT_SECTION_CHARS, 200, 20_000),
    });
  });
}

export function runMoegirlCommentsTool(args: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
  return guarded(async () => {
    const title = requiredTextArg(args.title, "title");
    return moegirlComments(title, integerArg(args.limit, "limit", 10, 1, 50));
  });
}
