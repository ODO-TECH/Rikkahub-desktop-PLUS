// 内置 @rikkahub/moegirl 回归：三级检索的请求形态、紧凑输出、别名回退、缓存、
// gRPC-web 编解码与错误语义。出站全部走 globalThis.fetch 桩，测试不打真实站点。
// 协议字段号与帧形态在测试侧用一套独立的最小编码器复现（形状取 2026-11-18 的本机抓包取证），
// 避免「编解码两边共用同一个猜」。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { JsonValue } from "../foundation/types";
import {
  MOEGIRL_COMMENTS_TOOL_NAME,
  MOEGIRL_GET_TOOL_NAME,
  MOEGIRL_SEARCH_TOOL_NAME,
  moegirlCommentsToolDefinition,
  moegirlGetToolDefinition,
  moegirlSearchToolDefinition,
  runMoegirlCommentsTool,
  runMoegirlGetTool,
  runMoegirlSearchTool,
  sweepWikiCache,
} from "./mcp-builtin-moegirl";

// 节奏压到零：测试不该为 2.5s 节拍与 20s 退避付费；缓存改道临时目录，免得把用例产物
// 写进 pc-data。三个键都在被调用时才读，所以这里的赋值对本文件的 import 图依然有效。
process.env.RIKKAHUB_WIKI_MIN_INTERVAL_MS = "0";
process.env.RIKKAHUB_WIKI_BACKOFF_MS = "0";
const cacheRoot = mkdtempSync(join(tmpdir(), "rikkahub-wiki-cache-"));
process.env.RIKKAHUB_WIKI_CACHE_DIR = cacheRoot;

let calls: Array<{ url: string; method: string; body: string; headers: Record<string, string> }> = [];
let restore: (() => void) | undefined;

/** 出站桩：记录请求，再按 handler 的回填。字符串按 JSON 回填，Response 原样透传。 */
function stub(handler: (url: URL, index: number) => Response | string | Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const headers: Record<string, string> = {};
    if (init?.headers) for (const [key, value] of new Headers(init.headers)) headers[key.toLowerCase()] = value;
    const index = calls.length;
    calls.push({ url: href, method: String(init?.method ?? "GET").toUpperCase(), body: String(init?.body ?? ""), headers });
    const result = handler(new URL(href), index);
    if (result instanceof Response) return result;
    return new Response(typeof result === "string" ? result : JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  restore?.();
  restore = undefined;
  for (const name of readdirSync(cacheRoot)) rmSync(join(cacheRoot, name), { force: true });
});

/** MCP 结果 → 业务对象；isError 时直接失败，「本该成功」的用例不必手动比信封。 */
function unpack(result: Record<string, JsonValue>): Record<string, JsonValue> {
  expect(result.isError).toBe(false);
  const content = result.content as Array<Record<string, JsonValue>>;
  expect(content[0]!.type).toBe("text");
  return JSON.parse(String(content[0]!.text)) as Record<string, JsonValue>;
}

function unpackError(result: Record<string, JsonValue>): string {
  expect(result.isError).toBe(true);
  const content = result.content as Array<Record<string, JsonValue>>;
  return String((JSON.parse(String(content[0]!.text)) as { error: string }).error);
}

/** MediaWiki 的 pages 是「页名 → 页」字典；index 决定展示顺序，这里按传入序补上。 */
function apiPages(pages: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const byTitle: Record<string, unknown> = {};
  pages.forEach((page, position) => {
    byTitle[String(page.title)] = { index: position + 1, ...page };
  });
  return { query: { pages: byTitle }, ...extra };
}

// ── 测试侧独立实现的 protobuf / grpc-web 最小编码器 ────────────────────────

const varintBytes = (value: number): Buffer => {
  const out: number[] = [];
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    out.push(byte | (rest ? 0x80 : 0));
  } while (rest);
  return Buffer.from(out);
};

/** 子消息 / 字符串：tag = (field<<3)|2，长度 varint。字段号 >15 时 tag 本身也跨两字节。 */
const lf = (field: number, bytes: Buffer): Buffer =>
  Buffer.concat([varintBytes((field << 3) | 2), varintBytes(bytes.length), bytes]);
const lstr = (field: number, text: string): Buffer => lf(field, Buffer.from(text, "utf8"));
const vf = (field: number, value: number): Buffer =>
  Buffer.concat([varintBytes((field << 3) | 0), varintBytes(value)]);

/** grpc-web 帧 = flag(1) + 长度(4BE) + 消息；请求侧整帧再 base64（grpc-web-text）。 */
function frameRaw(message: Buffer, flag = 0x00): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(message.length, 1);
  header[0] = flag;
  return Buffer.concat([header, message]);
}

const frameBase64 = (message: Buffer): string => frameRaw(message).toString("base64");
const trailerFrame = frameRaw(Buffer.from("grpc-status: 0\r\n", "latin1"), 0x80);
const grpcResponse = (frames: Buffer[]): Response =>
  new Response(new Uint8Array(Buffer.concat(frames)), { headers: { "content-type": "application/grpc-web+proto" } });

/** 评论节点：{5:user, 7:Quill delta, 14:{1:秒级时间戳}, 19:IP 属地}——字段号取本机抓包实测。
 *  真实回包每条评论一个数据帧，帧体再裹两层 field 1，这里照搬同一形状。 */
function commentNode(user: string, text: string, epoch: number, ip: string): Buffer {
  return Buffer.concat([
    lstr(1, "1127410"), // 用户 id
    lstr(2, "948"),
    lstr(3, "948"),
    lstr(4, "19"),
    lstr(5, user),
    vf(6, 47_186_234), // 无关的 varint：解码器不该被它带偏
    lstr(7, JSON.stringify([{ insert: text }])),
    lf(14, vf(1, epoch)),
    lstr(19, ip),
  ]);
}

const commentFrame = (user: string, text: string, epoch: number, ip: string): Buffer =>
  frameRaw(lf(1, lf(1, commentNode(user, text, epoch, ip))));

const ARTICLE = [
  "博丽灵梦是东方Project的主角，博丽神社的巫女。",
  "她平时无所事事，出异变时才动起来。",
  "",
  "== 基本资料 ==",
  "第一次灵梦的官方设定。",
  "",
  "=== 外貌 ===",
  "红白巫女服，头上戴一个大蝴蝶结。",
  "",
  "== 二次设定 ==",
  "⑨ 相关的社区二创与梗。",
].join("\n");

// 目录里的 chars 是「从本章标题行到下一章标题行」的原始长度（含章间空行），三段一一对上。
const SECTION_LEAD = "博丽灵梦是东方Project的主角，博丽神社的巫女。\n她平时无所事事，出异变时才动起来。";
const SECTION_BASIC = "== 基本资料 ==\n第一次灵梦的官方设定。\n\n";
const SECTION_APPEARANCE = "=== 外貌 ===\n红白巫女服，头上戴一个大蝴蝶结。\n\n";
const SECTION_FANON = "== 二次设定 ==\n⑨ 相关的社区二创与梗。";

describe("moe_search（第一级：只给标题与短摘要）", () => {
  test("请求形态锁死在匿名白名单那一条：generator=search + prop=extracts 摘要", async () => {
    stub(() => apiPages([{ title: "检索形态条目", pageid: 101, extract: "一句摘要。" }]));
    unpack(await runMoegirlSearchTool({ query: "灵梦", limit: 3, offset: 6 }));
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://zh.moegirl.org.cn/api.php");
    expect(calls[0]!.method).toBe("GET");
    expect(url.searchParams.get("action")).toBe("query");
    expect(url.searchParams.get("generator")).toBe("search");
    expect(url.searchParams.get("gsrsearch")).toBe("灵梦");
    expect(url.searchParams.get("gsrlimit")).toBe("3");
    expect(url.searchParams.get("gsroffset")).toBe("6");
    expect(url.searchParams.get("prop")).toBe("extracts");
    expect(url.searchParams.get("exintro")).toBe("1");
    expect(url.searchParams.get("explaintext")).toBe("1");
    expect(url.searchParams.get("exsentences")).toBe("2");
    expect(url.searchParams.get("format")).toBe("json");
    // 出站 UA 走品牌串（台账 §7.3），不是 Bun 默认的 "Bun/x"。
    expect(calls[0]!.headers["user-agent"]).toContain("RikkaHub-Desktop");
  });

  test("不传 limit/offset 时按默认 6 条、0 偏移下发", async () => {
    stub(() => apiPages([{ title: "默认值条目", pageid: 102 }]));
    unpack(await runMoegirlSearchTool({ query: "默认值" }));
    const q = new URL(calls[0]!.url).searchParams;
    expect(q.get("gsrlimit")).toBe("6");
    expect(q.get("gsroffset")).toBe("0");
  });

  test("命中列表按 index 排序，摘要满 150 字才打截断标记，more 来自 continue", async () => {
    stub(() =>
      apiPages(
        [
          // 字典枚举顺序与 index 相反：排序必须认 index，不能认 Object.values 的顺序。
          { title: "后排条目", pageid: 2, index: 2, extract: "第二" },
          { title: "前排条目", pageid: 1, index: 1, extract: `第一 ${"字".repeat(200)}` },
        ],
        { continue: { gsroffset: 2 } },
      ),
    );
    const out = unpack(await runMoegirlSearchTool({ query: "排序测试" }));
    const hits = out.hits as Array<Record<string, JsonValue>>;
    expect(hits.map((hit) => hit.title)).toEqual(["前排条目", "后排条目"]);
    expect(hits.map((hit) => hit.pageid)).toEqual([1, 2]);
    // 上游口径是「取满 150 字符再补标记」，不是「留 149 个」。
    expect(String(hits[0]!.snippet)).toBe(`第一 ${"字".repeat(147)}…[截断]`);
    expect(String(hits[1]!.snippet)).toBe("第二");
    expect(out.more).toBe(true);
    expect(out.query).toBe("排序测试");
  });

  test("页链把空格换成下划线后再转义，与萌百的规范页名一致", async () => {
    stub(() => apiPages([{ title: "东方 Project", pageid: 7 }]));
    const out = unpack(await runMoegirlSearchTool({ query: "空格页名" }));
    expect((out.hits as Array<Record<string, JsonValue>>)[0]!.url).toBe("https://zh.moegirl.org.cn/%E4%B8%9C%E6%96%B9_Project");
  });

  test("0 命中才回退别名表，并在结果里点名用了哪个别名", async () => {
    stub((url) => ((url.searchParams.get("gsrsearch") ?? "") === "⑨" ? apiPages([]) : apiPages([{ title: "琪露诺", pageid: 9121, extract: "⑨ 就是琪露诺。" }])));
    const out = unpack(await runMoegirlSearchTool({ query: "⑨" }));
    expect(calls).toHaveLength(2);
    expect(out.aliasUsed).toBe("琪露诺");
    expect(new URL(calls[1]!.url).searchParams.get("gsrsearch")).toBe("琪露诺");
    expect((out.hits as Array<Record<string, JsonValue>>)[0]!.title).toBe("琪露诺");
  });

  test("直接命中时不做别名回退，也不写 aliasUsed", async () => {
    stub(() => apiPages([{ title: "博丽灵梦", pageid: 9121, extract: "正统条目名。" }]));
    const out = unpack(await runMoegirlSearchTool({ query: "红白" }));
    expect(calls).toHaveLength(1);
    expect("aliasUsed" in out).toBe(false);
  });

  test("翻页（offset>0）时的空命中不回退别名——翻页是「同一个词继续翻」", async () => {
    stub(() => apiPages([]));
    const out = unpack(await runMoegirlSearchTool({ query: "⑨", offset: 12 }));
    expect(calls).toHaveLength(1);
    expect(out.hits).toEqual([]);
    expect("aliasUsed" in out).toBe(false);
    expect(out.more).toBe(false);
  });

  test("命中缓存时零出网：同一查询第二次不再打上游，换 limit 才算另一个查询", async () => {
    stub(() => apiPages([{ title: "缓存条目", pageid: 5, extract: "魔法使。" }]));
    unpack(await runMoegirlSearchTool({ query: "缓存测试" }));
    unpack(await runMoegirlSearchTool({ query: "缓存测试" }));
    expect(calls).toHaveLength(1);
    unpack(await runMoegirlSearchTool({ query: "缓存测试", limit: 2 }));
    expect(calls).toHaveLength(2);
  });

  test("空结果也进缓存，不为「0 命中」反复敲限流中的站", async () => {
    stub(() => apiPages([]));
    unpack(await runMoegirlSearchTool({ query: "不存在的梗" }));
    const afterFirst = calls.length; // 1 次直查 + 1 次别名回退
    unpack(await runMoegirlSearchTool({ query: "不存在的梗" }));
    expect(calls).toHaveLength(afterFirst);
  });

  test("接口报错体即时失败、不重试，原文进 tool_result", async () => {
    stub(() => ({ error: { code: "invalid-param-value", info: "gsrlimit 超出范围" } }));
    const message = unpackError(await runMoegirlSearchTool({ query: "报错测试" }));
    expect(calls).toHaveLength(1);
    expect(message).toContain("invalid-param-value");
    expect(message).toContain("gsrlimit 超出范围");
  });

  test("限流类状态码（408/429/5xx）退避重试，最多三次尝试", async () => {
    stub((_url, index) => {
      if (index === 0) return new Response("rate limited", { status: 429 });
      if (index === 1) return new Response("again", { status: 503 });
      return apiPages([{ title: "重试条目", pageid: 1, extract: "终于拿到了。" }]);
    });
    const out = unpack(await runMoegirlSearchTool({ query: "重试测试" }));
    expect(calls).toHaveLength(3);
    expect((out.hits as Array<Record<string, JsonValue>>)[0]!.title).toBe("重试条目");
  });

  test("三次都失败时把最后一次的失败原样交给模型，不编一个通用文案", async () => {
    stub(() => new Response("too many requests", { status: 429 }));
    const message = unpackError(await runMoegirlSearchTool({ query: "一直限流" }));
    expect(calls).toHaveLength(3);
    expect(message).toContain("HTTP 429");
  });

  test("403 这类硬拒即时失败：坏请求重试只会再坏一次，还多招两轮限流", async () => {
    stub(() => new Response("<html>WAF blocked</html>", { status: 403, headers: { "content-type": "text/html" } }));
    const message = unpackError(await runMoegirlSearchTool({ query: "被墙测试" }));
    expect(calls).toHaveLength(1);
    expect(message).toContain("HTTP 403");
  });

  test("响应不是 JSON 时按失败收，不返回半截列表", async () => {
    stub(() => "<html>not json</html>");
    expect(unpackError(await runMoegirlSearchTool({ query: "畸形响应" }))).toBeTruthy();
  });

  test("参数拒绝语义：越界、非整数、缺必填都在本地拦下，不出网", async () => {
    stub(() => apiPages([]));
    expect(unpackError(await runMoegirlSearchTool({ query: "参数", limit: 99 }))).toContain("expected a value from 1 to 20");
    expect(unpackError(await runMoegirlSearchTool({ query: "参数", limit: 0 }))).toContain("expected a value from 1 to 20");
    expect(unpackError(await runMoegirlSearchTool({ query: "参数", limit: "abc" }))).toContain("expected an integer");
    expect(unpackError(await runMoegirlSearchTool({ query: "参数", offset: -1 }))).toContain("expected a value from 0 to 10000");
    expect(unpackError(await runMoegirlSearchTool({ query: "   " }))).toContain("query");
    expect(unpackError(await runMoegirlSearchTool({}))).toContain("query");
    expect(unpackError(await runMoegirlSearchTool({ query: 123 as unknown as string }))).toContain("query");
    expect(calls).toHaveLength(0);
  });

  test("数字字符串形式的 limit 照收——上游就接受数字串", async () => {
    stub(() => apiPages([{ title: "字符串数字条目", pageid: 1 }]));
    unpack(await runMoegirlSearchTool({ query: "字符串数字", limit: "4" as unknown as number }));
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get("gsrlimit")).toBe("4");
  });
});

describe("moe_get（第二级：导语＋目录；第三级：单章正文）", () => {
  test("不传 section 时只给导语与目录，正文一个字都不下发", async () => {
    stub(() => apiPages([{ title: "目录级条目", pageid: 101, extract: ARTICLE }]));
    const out = unpack(await runMoegirlGetTool({ title: "目录级条目" }));
    const q = new URL(calls[0]!.url).searchParams;
    expect(q.get("titles")).toBe("目录级条目");
    expect(q.get("prop")).toBe("extracts|info");
    expect(q.get("explaintext")).toBe("1");
    expect(q.get("redirects")).toBe("1");
    expect(out.title).toBe("目录级条目");
    expect(out.totalChars).toBe(ARTICLE.length);
    expect(out.url).toBe("https://zh.moegirl.org.cn/%E7%9B%AE%E5%BD%95%E7%BA%A7%E6%9D%A1%E7%9B%AE");
    expect(out.lead).toBe(SECTION_LEAD);
    const sections = out.sections as Array<Record<string, JsonValue>>;
    expect(sections.map((section) => section.name)).toEqual(["基本资料", "外貌", "二次设定"]);
    expect(sections.map((section) => section.chars)).toEqual([
      SECTION_BASIC.length,
      SECTION_APPEARANCE.length,
      SECTION_FANON.length,
    ]);
    expect(String(out.hint)).toContain("section");
    expect("text" in out).toBe(false);
  });

  test("导语超 1200 字时打截断标记（目录级输出也受紧凑性约束）", async () => {
    stub(() => apiPages([{ title: "长导语条目", pageid: 102, extract: `${"喵".repeat(1300)}\n\n== 章 ==\n文` }]));
    const out = unpack(await runMoegirlGetTool({ title: "长导语条目" }));
    expect(String(out.lead)).toBe(`${"喵".repeat(1200)}…[截断]`);
  });

  test("章节名精确命中优先于「包含」匹配，序号按 1 起算", async () => {
    stub(() => apiPages([{ title: "章节选择条目", pageid: 103, extract: ARTICLE }]));
    const byName = unpack(await runMoegirlGetTool({ title: "章节选择条目", section: "基本资料" }));
    expect(byName.section).toBe("基本资料");
    expect(byName.text).toBe(SECTION_BASIC.trim());
    expect(byName.truncated).toBe(false);
    expect(byName.url).toBe("https://zh.moegirl.org.cn/%E7%AB%A0%E8%8A%82%E9%80%89%E6%8B%A9%E6%9D%A1%E7%9B%AE");

    expect(unpack(await runMoegirlGetTool({ title: "章节选择条目", section: "3" })).section).toBe("二次设定");
    expect(unpack(await runMoegirlGetTool({ title: "章节选择条目", section: "设定" })).section).toBe("二次设定");
    // 标题层级也参与目录：=== 外貌 === 是独立一节，不会并回「基本资料」。
    expect(unpack(await runMoegirlGetTool({ title: "章节选择条目", section: "外貌" })).text).toBe(SECTION_APPEARANCE.trim());
  });

  test("maxChars 咬到正文时 truncated 为真、text 带标记", async () => {
    stub(() => apiPages([{ title: "截断条目", pageid: 104, extract: `== 章 ==\n${"字".repeat(500)}` }]));
    const capped = unpack(await runMoegirlGetTool({ title: "截断条目", section: "章", maxChars: 200 }));
    // 上游口径：切到 maxChars 个字符为止，再补 5 个字符的标记（标题行 "== 章 ==\n" 占 8 个）。
    expect(String(capped.text)).toBe(`== 章 ==\n${"字".repeat(192)}…[截断]`);
    expect(capped.truncated).toBe(true);
    const uncapped = unpack(await runMoegirlGetTool({ title: "截断条目", section: "章", maxChars: 900 }));
    expect(uncapped.truncated).toBe(false);
    expect(String(uncapped.text)).toBe(`== 章 ==\n${"字".repeat(500)}`);
  });

  test("章节对不上时给出可选清单，而不是静默返回空", async () => {
    stub(() => apiPages([{ title: "缺章条目", pageid: 105, extract: ARTICLE }]));
    const message = unpackError(await runMoegirlGetTool({ title: "缺章条目", section: "不存在的一章" }));
    expect(message).toContain("章节不存在");
    expect(message).toContain("基本资料 / 外貌 / 二次设定");
  });

  test("无目录的条目要 section 时，清单为空也照样说清「没有章节」", async () => {
    stub(() => apiPages([{ title: "无目录条目", pageid: 106, extract: "只有一段导语，没有分章。" }]));
    expect(unpackError(await runMoegirlGetTool({ title: "无目录条目", section: "1" }))).toContain("（无章节）");
  });

  test("条目不存在时照实报 missing，不降级成空结果", async () => {
    stub(() => ({ query: { pages: { "-1": { title: "不存在的条目XYZ", missing: "" } } } }));
    expect(unpackError(await runMoegirlGetTool({ title: "不存在的条目XYZ" }))).toContain("条目不存在");
  });

  test("空串的 section 视为「只要目录」：模型常把可选字符串写成空串", async () => {
    stub(() => apiPages([{ title: "空章节条目", pageid: 107, extract: ARTICLE }]));
    const out = unpack(await runMoegirlGetTool({ title: "空章节条目", section: "   " }));
    expect(Array.isArray(out.sections)).toBe(true);
    expect("text" in out).toBe(false);
  });

  test("正文按天缓存：同一篇连续读两次只打一次上游", async () => {
    stub(() => apiPages([{ title: "缓存正文条目", pageid: 108, extract: ARTICLE }]));
    unpack(await runMoegirlGetTool({ title: "缓存正文条目" }));
    unpack(await runMoegirlGetTool({ title: "缓存正文条目", section: "外貌" }));
    expect(calls).toHaveLength(1);
  });

  test("标题必填且必须是字符串；maxChars 越界在本地拦下", async () => {
    stub(() => apiPages([]));
    expect(unpackError(await runMoegirlGetTool({}))).toContain("title");
    expect(unpackError(await runMoegirlGetTool({ title: 42 as unknown as string }))).toContain("title");
    expect(unpackError(await runMoegirlGetTool({ title: "拒绝测试", maxChars: 7 }))).toContain("maxChars");
    expect(calls).toHaveLength(0);
  });
});

describe("moe_comments（gRPC-web 评论面）", () => {
  test("三跳请求形态与请求体字节：prop=info → board → 列表，目的地只有两个站", async () => {
    stub((url, index) => {
      if (url.pathname === "/api.php") {
        if (index === 0) return apiPages([{ title: "评论形态条目", pageid: 9121 }]);
        return apiPages([]); // 不该再有第二次 api.php
      }
      if (url.pathname.includes("GetWikiPageArticleByWikiPageIdWithUserInfo")) return grpcResponse([frameRaw(lstr(3, "12345"))]);
      return grpcResponse([commentFrame("甲", "一楼", 1_700_000_000, "北京市"), trailerFrame]);
    });
    const out = unpack(await runMoegirlCommentsTool({ title: "评论形态条目", limit: 20 }));
    expect(calls.map((call) => call.url)).toEqual([
      expect.stringContaining("zh.moegirl.org.cn/api.php"),
      expect.stringContaining("api.moegirl.org.cn/moegirl.moepad.MoepadCommunityService/GetWikiPageArticleByWikiPageIdWithUserInfo"),
      expect.stringContaining("api.moegirl.org.cn/moegirl.moepad.MoepadCommunityService/GetWikiPageArticleCommentListWithUserInfo"),
    ]);
    expect(calls[0]!.method).toBe("GET");
    expect(new URL(calls[0]!.url).searchParams.get("prop")).toBe("info");
    expect(new URL(calls[0]!.url).searchParams.get("titles")).toBe("评论形态条目");
    for (const call of calls.slice(1)) {
      expect(call.method).toBe("POST");
      expect(call.headers["content-type"]).toBe("application/grpc-web-text+proto");
      expect(call.headers["user-agent"]).toContain("RikkaHub-Desktop");
    }
    // board 请求体：{1:"moegirl-zh", 2:"9121"} 编成 grpc-web-text 帧
    expect(calls[1]!.body).toBe(frameBase64(Buffer.concat([lstr(1, "moegirl-zh"), lstr(2, "9121")])));
    // 列表请求体：内层 {1:board,3:limit,4:0,5:1,6:01}，外层再裹 field 3
    const inner = Buffer.concat([lstr(1, "12345"), vf(3, 20), vf(4, 0), vf(5, 1), Buffer.from([0x32, 0x01, 0x01])]);
    expect(calls[2]!.body).toBe(frameBase64(lf(3, inner)));
    expect(out.count).toBe(1);
    expect(out.title).toBe("评论形态条目");
    expect(out.url).toBe("https://zh.moegirl.org.cn/%E8%AF%84%E8%AE%BA%E5%BD%A2%E6%80%81%E6%9D%A1%E7%9B%AE");
  });

  test("解析评论：用户名/正文/时间/IP 属地各归其位，trailer 帧与无关字段不进结果", async () => {
    stub((url) => {
      if (url.pathname === "/api.php") return apiPages([{ title: "解析条目", pageid: 42 }]);
      if (url.pathname.includes("ByWikiPageId")) return grpcResponse([frameRaw(lstr(3, "7788"))]);
      return grpcResponse([
        commentFrame("⑨单推人", "我是最强的！", 1_760_000_000, "福建省"),
        commentFrame("路过的巫女", "⑨ 是天才。", 1_700_000_000, "上海市"),
        trailerFrame,
      ]);
    });
    const out = unpack(await runMoegirlCommentsTool({ title: "解析条目" }));
    const comments = out.comments as Array<Record<string, JsonValue>>;
    expect(out.count).toBe(2);
    expect(comments).toHaveLength(2);
    expect(comments.map((row) => row.user)).toEqual(["⑨单推人", "路过的巫女"]);
    expect(comments.map((row) => row.text)).toEqual(["我是最强的！", "⑨ 是天才。"]);
    expect(comments.map((row) => row.ip)).toEqual(["福建省", "上海市"]);
    expect(new Date(String(comments[0]!.time)).getTime()).toBe(1_760_000_000_000);
    expect(new Date(String(comments[1]!.time)).getTime()).toBe(1_700_000_000_000);
    expect(calls).toHaveLength(3);
  });

  test("delta 在 field 12 的形态也认（代码判据是 7||12，只锁 7 会让 12 那条分支无主）", async () => {
    stub((url) => {
      if (url.pathname === "/api.php") return apiPages([{ title: "十二号字段条目", pageid: 51 }]);
      if (url.pathname.includes("ByWikiPageId")) return grpcResponse([frameRaw(lstr(3, "5151"))]);
      const node = Buffer.concat([
        lstr(5, "丙"),
        lstr(7, "签名文字，不是 delta"),
        lstr(12, JSON.stringify([{ insert: "这条在 12 号" }])),
        lstr(19, "浙江省"),
      ]);
      return grpcResponse([frameRaw(lf(1, lf(1, node))), trailerFrame]);
    });
    const out = unpack(await runMoegirlCommentsTool({ title: "十二号字段条目" }));
    const comments = out.comments as Array<Record<string, JsonValue>>;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.text).toBe("这条在 12 号");
    expect(comments[0]!.user).toBe("丙");
  });

  test("delta 畸形（不是可解析的 Quill JSON）时该条留空文本，整批不失败", async () => {
    stub((url) => {
      if (url.pathname === "/api.php") return apiPages([{ title: "畸形评论条目", pageid: 43 }]);
      if (url.pathname.includes("ByWikiPageId")) return grpcResponse([frameRaw(lstr(3, "9999"))]);
      const broken = Buffer.concat([lstr(5, "甲"), lstr(7, '[{"insert" 未闭合')]);
      return grpcResponse([frameRaw(lf(1, lf(1, broken))), commentFrame("乙", "正常一条", 1_700_000_000, "广东省")]);
    });
    const out = unpack(await runMoegirlCommentsTool({ title: "畸形评论条目" }));
    const comments = out.comments as Array<Record<string, JsonValue>>;
    expect(comments).toHaveLength(2);
    expect(comments[0]!.user).toBe("甲");
    expect(comments[0]!.text).toBe("");
    expect(comments[1]!.text).toBe("正常一条");
    expect(out.count).toBe(2);
  });

  test("board 要落在可打印的纯数字串上：扫不到就报「没有评论区」，且不打第三跳", async () => {
    stub((url) => {
      if (url.pathname === "/api.php") return apiPages([{ title: "无评论条目", pageid: 44 }]);
      if (url.pathname.includes("ByWikiPageId")) return grpcResponse([frameRaw(Buffer.from([0x12, 0x03, 0x01, 0x02, 0x03]))]);
      return grpcResponse([]);
    });
    expect(unpackError(await runMoegirlCommentsTool({ title: "无评论条目" }))).toContain("该页面没有评论区");
    expect(calls).toHaveLength(2);
  });

  test("board 按周缓存、列表每次现拉：新评论不该被缓存吃掉", async () => {
    stub((url) => {
      if (url.pathname === "/api.php") return apiPages([{ title: "缓存评论条目", pageid: 45 }]);
      if (url.pathname.includes("ByWikiPageId")) return grpcResponse([frameRaw(lstr(3, "5555"))]);
      return grpcResponse([commentFrame("甲", "一楼", 1_700_000_000, "北京市")]);
    });
    unpack(await runMoegirlCommentsTool({ title: "缓存评论条目" }));
    const afterFirst = calls.length; // api.php + board + list
    unpack(await runMoegirlCommentsTool({ title: "缓存评论条目" }));
    expect(calls).toHaveLength(afterFirst + 1);
    expect(calls[afterFirst]!.url).toContain("GetWikiPageArticleCommentListWithUserInfo");
  });

  test("评论面退避重试上限 2：429 只敲两次门", async () => {
    stub((url) => {
      if (url.pathname === "/api.php") return apiPages([{ title: "评论限流条目", pageid: 46 }]);
      if (url.pathname.includes("ByWikiPageId")) return grpcResponse([frameRaw(lstr(3, "6666"))]);
      return new Response("slow down", { status: 429 });
    });
    expect(unpackError(await runMoegirlCommentsTool({ title: "评论限流条目" }))).toContain("HTTP 429");
    // board 那跳成功（1 次）+ 列表两次 429 = 三个评论服务请求
    expect(calls.filter((call) => call.url.includes("moepad.MoepadCommunityService"))).toHaveLength(3);
    expect(calls.filter((call) => call.url.includes("CommentListWithUserInfo"))).toHaveLength(2);
  });

  test("评论面 403 即时失败：一次都不重试", async () => {
    stub((url) => {
      if (url.pathname === "/api.php") return apiPages([{ title: "评论被墙条目", pageid: 47 }]);
      return new Response("<html>blocked</html>", { status: 403, headers: { "content-type": "text/html" } });
    });
    expect(unpackError(await runMoegirlCommentsTool({ title: "评论被墙条目" }))).toContain("HTTP 403");
    expect(calls.filter((call) => call.url.includes("moepad.MoepadCommunityService"))).toHaveLength(1);
  });

  test("响应是 grpc-web-text（0x41 开头的 base64 文本）时先解回二进制", async () => {
    stub((url) => {
      if (url.pathname === "/api.php") return apiPages([{ title: "文本帧条目", pageid: 48 }]);
      if (url.pathname.includes("ByWikiPageId")) {
        return new Response(frameRaw(lstr(3, "321")).toString("base64"), { headers: { "content-type": "application/grpc-web-text" } });
      }
      return grpcResponse([commentFrame("甲", "文本帧一条", 1_700_000_000, "江苏省")]);
    });
    const out = unpack(await runMoegirlCommentsTool({ title: "文本帧条目" }));
    expect((out.comments as Array<Record<string, JsonValue>>)[0]!.text).toBe("文本帧一条");
  });

  test("条目不存在时第一跳就失败，不打评论服务", async () => {
    stub(() => ({ query: { pages: { "-1": { title: "查无此页", missing: "" } } } }));
    expect(unpackError(await runMoegirlCommentsTool({ title: "查无此页" }))).toContain("条目不存在");
    expect(calls).toHaveLength(1);
  });

  test("标题必填；limit 越界在本地拦下，不打评论服务", async () => {
    stub(() => apiPages([]));
    expect(unpackError(await runMoegirlCommentsTool({}))).toContain("title");
    expect(unpackError(await runMoegirlCommentsTool({ title: "越界", limit: 51 }))).toContain("expected a value from 1 to 50");
    expect(unpackError(await runMoegirlCommentsTool({ title: "越界", limit: 1.5 }))).toContain("expected an integer");
    expect(calls).toHaveLength(0);
  });
});

describe("工具定义", () => {
  test("三个工具各自的名字与必填项，就是模型侧 mcp__moe_* 的全部契约", () => {
    expect(moegirlSearchToolDefinition().name).toBe(MOEGIRL_SEARCH_TOOL_NAME);
    expect(moegirlGetToolDefinition().name).toBe(MOEGIRL_GET_TOOL_NAME);
    expect(moegirlCommentsToolDefinition().name).toBe(MOEGIRL_COMMENTS_TOOL_NAME);
    expect((moegirlSearchToolDefinition().inputSchema as Record<string, JsonValue>).required).toEqual(["query"]);
    expect((moegirlGetToolDefinition().inputSchema as Record<string, JsonValue>).required).toEqual(["title"]);
    expect((moegirlCommentsToolDefinition().inputSchema as Record<string, JsonValue>).required).toEqual(["title"]);
  });

  test("描述里写清三级读法与许可：不许整篇灌上下文、必须留来源链接", () => {
    const search = String(moegirlSearchToolDefinition().description);
    const get = String(moegirlGetToolDefinition().description);
    const comments = String(moegirlCommentsToolDefinition().description);
    expect(search).toContain("three-step read");
    expect(search).toContain("moe_get");
    expect(search).toContain("serialised with a 2.5s gap");
    expect(get).toContain("Never pull a whole article into context");
    expect(get).toContain("CC BY-NC-SA");
    expect(comments).toContain("CC BY-NC-SA");
    expect(comments).toContain("cached for a week");
  });

  test("入参边界写在 schema 里，与实现里的拒绝口径一致", () => {
    const bound = (definition: unknown, name: string) =>
      ((((definition as { inputSchema?: unknown }).inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {})[name] as {
        minimum?: number;
        maximum?: number;
      } ?? {};
    const search = moegirlSearchToolDefinition();
    expect(bound(search, "limit").minimum).toBe(1);
    expect(bound(search, "limit").maximum).toBe(20);
    expect(bound(search, "offset").maximum).toBe(10000);
    const get = moegirlGetToolDefinition();
    expect(bound(get, "maxChars").minimum).toBe(200);
    expect(bound(get, "maxChars").maximum).toBe(20000);
    expect(bound(moegirlCommentsToolDefinition(), "limit").maximum).toBe(50);
  });
});

describe("缓存回收（persistence/data-dir-hygiene 消费的面）", () => {
  test("7 天内不动，过期件删除并计数", async () => {
    stub(() => apiPages([{ title: "回收条目", pageid: 5, extract: "魔法使。" }]));
    unpack(await runMoegirlSearchTool({ query: "回收测试" }));
    const files = readdirSync(cacheRoot);
    expect(files.length).toBeGreaterThan(0);
    expect(sweepWikiCache()).toBe(0);
    expect(readdirSync(cacheRoot).filter((name) => name.endsWith(".json"))).toEqual(files);
    const eightDaysLater = Date.now() + 8 * 24 * 3_600_000;
    expect(sweepWikiCache(eightDaysLater)).toBe(files.length);
    expect(readdirSync(cacheRoot)).toHaveLength(0);
  });

  test("认不出的文件没有存活理由，下一次回收即删", async () => {
    const bogus = join(cacheRoot, "bogus.json");
    await Bun.write(bogus, "{ not json");
    expect(sweepWikiCache(Date.now() + 8 * 24 * 3_600_000)).toBe(1);
    expect(readdirSync(cacheRoot)).toHaveLength(0);
  });

  test("缓存目录不存在时返回 0，不抛错（首次启动就该是这样）", () => {
    process.env.RIKKAHUB_WIKI_CACHE_DIR = join(cacheRoot, "missing-dir");
    try {
      expect(sweepWikiCache()).toBe(0);
    } finally {
      process.env.RIKKAHUB_WIKI_CACHE_DIR = cacheRoot;
    }
  });
});
