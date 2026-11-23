// search/deepseek.test.ts — DeepSeek 官方工具 API(search/fetch)的行为锁。
// 本地 stub 取代真实服务,验证与安卓 DeepSeekSearchService.kt 同款的报文与映射:
//   · POST /v1/tools/search body 只带 query + count(count 夹到官方 1–50)
//   · 结果文本 summary 优先、空则回落 snippet
//   · POST /v1/tools/fetch 取 {title, content} 拼成 scrape 结果
//   · 非 2xx 抛带 "DeepSeek … failed" 的人话错误(401/403/429 走多 key 轮换)
// 纪律:不桩任何模块(bun 1.4.2 的 mock.module 会跨文件泄漏);真实 addLog 需要的
// stats/logs 直接给最小形状,数据目录指到临时目录。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-search-deepseek-test-"));

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { setState } = await import("../persistence/json-store");
const { runSearchWeb, runScrapeWeb, testSearchService } = await import("./index");

const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
let searchReply: unknown = {
  results: [
    { title: "带长摘要的结果", url: "https://example.com/a", snippet: "短摘要", summary: "长摘要,给模型读的那一版" },
    { title: "只有短摘要", url: "https://example.com/b", snippet: "仅有 snippet", summary: "" },
    { title: "被截断的第三条", url: "https://example.com/c", snippet: "c", summary: "c-summary" },
  ],
};
let fetchReply: unknown = { title: "文档页", content: "# Markdown 正文" };
let failStatus = 0;

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await request.json().catch(() => ({}));
    const path = new URL(request.url).pathname;
    requests.push({ url: path, headers: Object.fromEntries(request.headers), body });
    if (failStatus) {
      return new Response(JSON.stringify({ error: { message: "Insufficient Balance", type: "insufficient_balance_error" } }), {
        status: failStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    return Response.json(path.endsWith("/fetch") ? fetchReply : searchReply);
  },
});

function configure(overrides: Record<string, unknown> = {}) {
  const service = {
    type: "deepseek",
    id: "ds1",
    name: "DeepSeek",
    apiKey: "sk-deepseek-test",
    url: `http://127.0.0.1:${server.port}`,
    ...overrides,
  };
  setState({
    logs: [],
    stats: { totalRequests: 0, failedRequests: 0, byProvider: {}, byGroup: {} },
    settings: {
      enableWebSearch: true,
      searchServices: [service],
      searchServiceSelected: 0,
      searchCommonOptions: { resultSize: 10 },
      proxyConfig: undefined,
    },
  } as any);
  return service;
}

afterAll(async () => {
  server.stop(true);
  await new Promise((resolve) => setTimeout(resolve, 260));
  rmSync(process.env.RIKKAHUB_PC_DATA_DIR!, { recursive: true, force: true });
});

test("search_web: 报文与安卓同款,summary 优先、空则回落 snippet", async () => {
  configure();
  requests.length = 0;
  const result: any = await runSearchWeb({ query: " DeepSeek 是什么 " });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("/v1/tools/search");
  expect(requests[0].headers.authorization).toBe("Bearer sk-deepseek-test");
  expect(requests[0].body).toEqual({ query: "DeepSeek 是什么", count: 10 });
  expect(result.service).toBe("DeepSeek");
  expect(result.items).toHaveLength(3);
  expect(result.items[0].text).toBe("长摘要,给模型读的那一版");
  expect(result.items[1].text).toBe("仅有 snippet");
  expect(result.items[0].domain).toBe("example.com");
});

test("search_web: count 夹到官方上限 50,下限 1", async () => {
  configure();
  requests.length = 0;
  await runSearchWeb({ query: "上限" });
  expect(requests[0].body.count).toBe(10);
  setState({
    logs: [],
    stats: { totalRequests: 0, failedRequests: 0, byProvider: {}, byGroup: {} },
    settings: {
      enableWebSearch: true,
      searchServices: [{ type: "deepseek", id: "ds1", name: "DeepSeek", apiKey: "k", url: `http://127.0.0.1:${server.port}` }],
      searchServiceSelected: 0,
      searchCommonOptions: { resultSize: 500 },
      proxyConfig: undefined,
    },
  } as any);
  requests.length = 0;
  await runSearchWeb({ query: "超限" });
  expect(requests[0].body.count).toBe(50);
});

test("search_web: 非 2xx 抛人话错误并带上状态码", async () => {
  configure();
  requests.length = 0;
  failStatus = 402;
  await expect(runSearchWeb({ query: "余额不足" })).rejects.toThrow(/DeepSeek search failed with code 402/);
  failStatus = 0;
});

test("scrape_web: 走 /v1/tools/fetch,取 title + Markdown 正文", async () => {
  configure();
  requests.length = 0;
  fetchReply = { title: "文档页", content: "# Markdown 正文" };
  const result: any = await runScrapeWeb({ url: "https://api-docs.deepseek.com/zh-cn/api/fetch" });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("/v1/tools/fetch");
  expect(requests[0].body).toEqual({ url: "https://api-docs.deepseek.com/zh-cn/api/fetch" });
  expect(result).toMatchObject({ url: "https://api-docs.deepseek.com/zh-cn/api/fetch", title: "文档页", text: "# Markdown 正文" });
});

test("测试连接: 最小请求 count=1,逐 key 汇总", async () => {
  configure({ apiKey: "sk-one sk-two" });
  requests.length = 0;
  const result: any = await testSearchService({ type: "deepseek", id: "ds1", name: "DeepSeek", apiKey: "sk-one sk-two", url: `http://127.0.0.1:${server.port}` } as any);
  expect(result.status).toBe("ok");
  expect(requests).toHaveLength(2);
  expect(requests[0].body).toEqual({ query: "RikkaHub", count: 1 });
  expect(requests[1].headers.authorization).toBe("Bearer sk-two");
});
