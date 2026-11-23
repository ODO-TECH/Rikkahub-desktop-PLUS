// debug/server.ts — 本地调试端口(默认关闭,只绑 127.0.0.1)
//
// 为什么单独一个监听口而不是往 /api 上加路由:
// - /api 受 Web 访问密码(web auth)保护;调试口是给本机开发/排障用的短路径,
//   带不带密码都应该能用 curl 直连,且绝不能被 --host 0.0.0.0 带出去。
// - 独立生命周期:开关一关立即停止监听,不牵动主服务;主服务重启时调试口跟着停/起。
//
// 端点(完整清单见 GET /debug):
//   GET  /debug                     HTML 控制台(日志流 + 树浏览 + 重启按钮)
//   GET  /debug/health              pid / 版本 / 数据目录 / 主端口 / 运行时长
//   GET  /debug/logs                控制台环形缓冲(limit/level/since 过滤)
//   GET  /debug/logs/stream         SSE 实时日志
//   GET  /debug/requests            最近模型/搜索请求日志(state.logs,已脱敏)
//   GET  /debug/tree                助手、供应商、会话、设置摘要
//   GET/PATCH /debug/settings       全量设置读取/深合并写入，凭据脱敏
//   /debug/api/*                    调用现有应用 API
//   POST /debug/ui                  当前应用页的 CDP 命令
//   GET  /debug/conversations/:id/tree       会话节点树(逐 part 类型/长度)
//   GET  /debug/conversations/:id/encoded    编码产物统计(窗口/逐条 token/工具输出体积)
//   POST /debug/restart             走与 /api/app/restart 相同的停机+自重启编排
//
// 安全:只绑回环;可选 token(x-debug-token 头或 ?token=)。token 为空 = 不校验。
// 响应一律不返回 apiKey / Authorization 原文:树里供应商只报 apiKeySet 布尔。

import type { Assistant, Message, MessageNode, Provider } from "../foundation/types";
import type { DebugServerConfig } from "../foundation/types/settings/debug-server-config";
import { normalizeDebugServerConfig } from "../foundation/types/settings/debug-server-config";
import { dataDir } from "../foundation/paths";
import { state } from "../persistence/json-store";
import { getConversationsDb, loadConversationNodesFromDb } from "../conversations";
import { getConversationMeta } from "../conversations/read-queries";
import { conversationTransformedMessages } from "../inference-engine/conversation-encoding";
import { contextTokensOf } from "../inference-engine/context-budget";
import { APP_VERSION } from "../updates/index";
import { inspectUiTree,callUiDebug } from "./ui-tree";
import {redactDebug,patchDebugSettings} from "./settings-control";
import { readDebugLogs, subscribeDebugLogs, installDebugLogCapture } from "./log-ring";

export interface DebugRestartResult {
  ok: boolean;
  /** 被拒绝时的机器可读原因(容器/壳管后端/低完整性/正在关闭)。 */
  code?: string;
  message?: string;
  pid?: number;
}

export interface DebugServerInfo {
  startedAt: number;
  mainPort: number | null;
}

interface DebugDeps {
  api?: (request:Request,url:URL)=>Promise<Response>;
  restart?: () => Promise<DebugRestartResult>;
  info?: () => DebugServerInfo;
}

let deps: DebugDeps = {};
let server: { stop(force?: boolean): void; port?: number } | null = null;
let runningConfig: DebugServerConfig | null = null;
let lastError: string | null = null;
let debugStartedAt = 0;
let debugPort: number | null = null;

/** 由 server.ts 在停机编排可用之后注入:重启回调必须复用同一套闸门与编排。 */
export function configureDebugServer(next: DebugDeps): void {
  deps = { ...deps, ...next };
}

/** 提前安装 console 捕获:调试口后开也能回看启动期日志。幂等、零网络副作用。 */
export function prepareDebugLogging(): void {
  installDebugLogCapture();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function tokenAuthorized(request: Request, url: URL): boolean {
  const expected = runningConfig?.token ?? "";
  if (!expected) return true;
  const provided = request.headers.get("x-debug-token") ?? url.searchParams.get("token") ?? "";
  return provided === expected;
}

function start(config: DebugServerConfig): { ok: boolean; error?: string } {
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: config.port,
      idleTimeout: 0,
      fetch: async (request) => handleFetch(request),
      error(err) {
        lastError = err instanceof Error ? err.message : String(err);
        return json(500, { error: lastError });
      },
    });
    runningConfig = config;
    debugStartedAt = Date.now();
    debugPort = server.port ?? config.port;
    lastError = null;
    console.log(`[debug] 调试端口已开启: http://127.0.0.1:${debugPort}/debug`);
    return { ok: true };
  } catch (err) {
    server = null;
    runningConfig = config;
    debugPort = null;
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[debug] 调试端口 ${config.port} 启动失败: ${lastError}`);
    return { ok: false, error: lastError };
  }
}

export function stopDebugServer(): void {
  if (!server) return;
  try {
    server.stop(true);
  } catch {
    // 关闭失败不阻断停机编排。
  }
  server = null;
  runningConfig = null;
  debugPort = null;
}

export interface DebugServerStatus {
  running: boolean;
  port: number | null;
  error: string | null;
}

export function debugServerStatus(): DebugServerStatus {
  return { running: server != null, port: debugPort, error: lastError };
}

/** 按设置应用:关闭则停;端口变化则重绑;同配置幂等。设置端点与启动引导共用。 */
export function applyDebugServerConfig(raw: unknown): DebugServerStatus {
  const config = normalizeDebugServerConfig(raw);
  if (!config.enabled) {
    stopDebugServer();
    return debugServerStatus();
  }
  if (server && runningConfig?.port === config.port && runningConfig?.token === config.token) {
    return debugServerStatus();
  }
  stopDebugServer();
  start(config);
  return debugServerStatus();
}

/** 启动引导末尾调用:state 已装载,按用户设置决定是否拉起。 */
export function startDebugServerFromState(): void {
  prepareDebugLogging();
  const config = normalizeDebugServerConfig(state.settings?.debugServer);
  if (!config.enabled) return;
  runningConfig = config;
  start(config);
}

async function handleFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const host=url.hostname;
  if(!["127.0.0.1","localhost","[::1]"].includes(host))return json(403,{error:"Debug requires a loopback host"});
  const origin=request.headers.get("origin");
  const allowed=[url.origin,`http://127.0.0.1:${deps.info?.().mainPort}`,`http://localhost:${deps.info?.().mainPort}`];
  if(request.headers.get("sec-fetch-site")==="cross-site" || (origin && !allowed.includes(origin)))return json(403,{error:"Cross-origin debug access denied"});
  if (!tokenAuthorized(request, url)) {
    return json(401, { error: "调试令牌无效:请在 URL 加 ?token=… 或请求头 x-debug-token" });
  }
  if(url.pathname === "/debug/settings") {
    if(request.method === "GET")return json(200,{settings:redactDebug(state.settings)});
    if(["PATCH","POST"].includes(request.method)) {
      try {
        const next=patchDebugSettings(state.settings,await request.json());
        const {updateSettings}=await import("../app-config");
        updateSettings(next);
        const {invalidateContextSnapshots}=await import("../inference-engine/context-snapshots");
        invalidateContextSnapshots();
        const config=normalizeDebugServerConfig(next.debugServer);
        // Rebinding the debug listener must not close its own response socket.
        setTimeout(()=>applyDebugServerConfig(config),100);
        console.log(`[debug-control] settings updated (${request.method})`);
        return json(200,{ok:true,settings:redactDebug(next)});
      }catch(error){return json(400,{error:error instanceof Error?error.message:"Invalid settings"});}
    }
    return json(405,{error:"Use GET or PATCH"});
  }
  if(url.pathname.startsWith("/debug/api/")) {
    if(!deps.api)return json(501,{error:"Application API is unavailable"});
    const path=url.pathname.slice("/debug/api".length);
    const target=new URL("/api"+path,url.origin);target.search=url.search;target.searchParams.delete("token");
    const headers=new Headers(request.headers);headers.delete("x-debug-token");headers.delete("authorization");
    const forwarded=new Request(target,{method:request.method,headers,...(!["GET","HEAD"].includes(request.method)?{body:await request.arrayBuffer()}:{}),signal:request.signal});
    try {
      const response=await deps.api(forwarded,target);
      if(!response.headers.get("content-type")?.includes("application/json"))return response;
      return json(response.status,redactDebug(await response.json()));
    }catch(error){return json(400,{error:error instanceof Error?error.message:"Debug API request failed"});}
  }
  if (url.pathname === "/debug" || url.pathname === "/debug/") {
    return new Response(dashboardHtml(), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (url.pathname === "/debug/health" && request.method === "GET") {
    const info = deps.info?.();
    return json(200, {
      ok: true,
      pid: process.pid,
      version: APP_VERSION,
      dataDir,
      startedAt: info?.startedAt ?? debugStartedAt,
      uptimeSec: Math.floor(process.uptime()),
      mainPort: info?.mainPort ?? null,
      debugPort,
    });
  }
  if (url.pathname === "/debug/logs" && request.method === "GET") {
    return json(200, {
      entries: readDebugLogs({
        limit: Number(url.searchParams.get("limit") ?? 200),
        level: url.searchParams.get("level") ?? undefined,
        sinceSeq: Number(url.searchParams.get("since") ?? 0),
      }),
    });
  }
  if (url.pathname === "/debug/logs/stream" && request.method === "GET") {
    return logStream(url);
  }
  if (url.pathname === "/debug/requests" && request.method === "GET") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
    return json(200, { entries: (state.logs ?? []).slice(0, limit) });
  }
  if (url.pathname === "/debug/tree" && request.method === "GET") {
    return json(200, buildAppTree(Number(url.searchParams.get("conversations") ?? 50)));
  }
  if (url.pathname === "/debug/ui-tree" && request.method === "GET") {
    return json(200, await inspectUiTree(deps.info?.().mainPort ?? null));
  }
  if(url.pathname === "/debug/ui" && request.method === "POST") {
    try {
      const body=await request.json() as {method?:string;params?:Record<string,unknown>};
      return json(200,await callUiDebug(deps.info?.().mainPort ?? null,body.method ?? "",body.params ?? {}));
    }catch(error){return json(400,{error:error instanceof Error?error.message:"UI debug failed"});}
  }
  const treeMatch = url.pathname.match(/^\/debug\/conversations\/([^/]+)\/tree$/);
  if (treeMatch && request.method === "GET") {
    const result = buildConversationTree(decodeURIComponent(treeMatch[1]!));
    return "error" in result ? json(404, result) : json(200, result);
  }
  const encodedMatch = url.pathname.match(/^\/debug\/conversations\/([^/]+)\/encoded$/);
  if (encodedMatch && request.method === "GET") {
    const result = buildEncodedReport(decodeURIComponent(encodedMatch[1]!));
    return "error" in result ? json(404, result) : json(200, result);
  }
  if (url.pathname === "/debug/restart" && request.method === "POST") {
    if (!deps.restart) return json(501, { error: "重启回调未接线(仅在主服务进程内可用)" });
    const result = await deps.restart();
    return json(result.ok ? 200 : 409, result);
  }
  return json(404, { error: `未知调试端点 ${request.method} ${url.pathname};清单见 GET /debug` });
}

function logStream(url: URL): Response {
  const initialSince = Number(url.searchParams.get("since") ?? 0) || 0;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // 连接已被客户端断开;cleanup 由 cancel 处理。
        }
      };
      for (const entry of readDebugLogs({ limit: 100, sinceSeq: initialSince })) send("log", entry);
      unsubscribe = subscribeDebugLogs((entry) => send("log", entry));
      heartbeat = setInterval(() => send("ping", { at: Date.now() }), 15_000);
      heartbeat.unref?.();
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe = null;
      heartbeat = null;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

// ── 树与编码报告 ────────────────────────────────────────────────

function assistantSummary(assistant: Assistant) {
  return {
    id: assistant.id,
    name: assistant.name,
    chatModelId: assistant.chatModelId ?? null,
    contextMessageLimit: assistant.contextMessageLimit ?? null,
    allowConversationSystemPrompt: assistant.allowConversationSystemPrompt === true,
  };
}

function providerSummary(provider: Provider) {
  const models = Array.isArray(provider.models) ? provider.models : [];
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    enabled: provider.enabled !== false,
    baseUrl: provider.baseUrl ?? null,
    modelCount: models.length,
    apiKeySet: typeof provider.apiKey === "string" && provider.apiKey.length > 0,
  };
}

function buildAppTree(conversationLimit: number) {
  const settings = state.settings;
  const limit = Math.min(200, Math.max(1, Math.floor(conversationLimit) || 50));
  const conversations: Array<Record<string, unknown>> = [];
  try {
    const db = getConversationsDb();
    if (db) {
      const rows = db.prepare(
        `SELECT c.id, c.assistant_id, c.title, c.is_pinned, c.create_at, c.update_at,
                (SELECT COUNT(*) FROM pc_message_node n WHERE n.conversation_id = c.id) AS node_count
           FROM pc_conversation c ORDER BY c.update_at DESC LIMIT ?`,
      ).all(limit) as Array<{
        id: string; assistant_id: string; title: string | null; is_pinned: number;
        create_at: number; update_at: number; node_count: number;
      }>;
      for (const row of rows) {
        conversations.push({
          id: row.id,
          assistantId: row.assistant_id,
          title: row.title ?? "",
          isPinned: row.is_pinned === 1,
          createAt: row.create_at,
          updateAt: row.update_at,
          nodes: row.node_count,
        });
      }
    }
  } catch (err) {
    conversations.push({ error: err instanceof Error ? err.message : String(err) });
  }
  return {
    app: {
      version: APP_VERSION,
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      debugPort,
    },
    counts: {
      assistants: settings.assistants?.length ?? 0,
      providers: settings.providers?.length ?? 0,
      conversations: conversations.length,
    },
    settings: {
      assistants: (settings.assistants ?? []).map(assistantSummary),
      providers: (settings.providers ?? []).map(providerSummary),
      chatModelId: settings.chatModelId ?? null,
      contextBudget: settings.contextBudget ?? null,
      debugServer: { enabled: settings.debugServer?.enabled === true, port: settings.debugServer?.port ?? null, tokenSet: !!settings.debugServer?.token },
    },
    conversations,
  };
}

function screenshotPart(part: Message["parts"][number]): Record<string, unknown> {
  switch (part.type) {
    case "text":
      return { type: "text", textLen: part.text?.length ?? 0 };
    case "reasoning":
      return { type: "reasoning", textLen: part.reasoning?.length ?? 0 };
    case "tool": {
      const outputs = Array.isArray(part.output) ? part.output : [];
      const bytes = outputs.reduce((sum, entry) => {
        if (entry && entry.type === "text") return sum + (entry.text?.length ?? 0);
        if (entry && "error" in entry) return sum + String(entry.error ?? "").length;
        return sum;
      }, 0);
      return { type: "tool", toolName: part.toolName, inputLen: part.input?.length ?? 0, outputs: outputs.length, outputBytes: bytes, approval: part.approvalState?.type ?? "unknown" };
    }
    case "image":
    case "video":
    case "audio":
      return { type: part.type, urlScheme: urlScheme(part.url) };
    case "document":
      return { type: "document", urlScheme: urlScheme(part.url), fileName: part.fileName, mime: part.mime };
    case "loading":
      return { type: "loading" };
    default:
      return { type: String((part as { type?: unknown }).type ?? "unknown") };
  }
}

function urlScheme(url: string | undefined): string {
  const raw = String(url ?? "");
  const index = raw.indexOf(":");
  return index > 0 ? raw.slice(0, index) : "relative";
}

function summarizeMessage(message: Message) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return {
    id: message.id,
    role: message.role,
    isContextCheckpoint: message.isContextCheckpoint === true,
    createdAt: message.createdAt ?? null,
    modelId: message.modelId ?? null,
    usage: message.usage ?? null,
    translationSet: message.translation != null,
    parts: parts.map(screenshotPart),
  };
}

/** 只读快照:不经过 working set(checkout 会刷新 lastAccess/搬实例),调试查看绝不扰动运行时。 */
function loadConversationSnapshot(conversationId: string) {
  const db = getConversationsDb();
  if (!db) return { error: "会话库未就绪" } as const;
  const meta = getConversationMeta(db, conversationId);
  if (!meta) return { error: `会话不存在:${conversationId}` } as const;
  const nodes = loadConversationNodesFromDb(db, conversationId);
  return { conversation: { ...meta, messages: nodes } };
}

function buildConversationTree(conversationId: string) {
  const loaded = loadConversationSnapshot(conversationId);
  if ("error" in loaded) return loaded;
  const conversation = loaded.conversation;
  return {
    id: conversation.id,
    title: conversation.title,
    assistantId: conversation.assistantId,
    createAt: conversation.createAt,
    updateAt: conversation.updateAt,
    isPinned: conversation.isPinned === true,
    workspaceId: conversation.workspaceId ?? null,
    contextBoundaryMessageId: conversation.contextBoundaryMessageId ?? null,
    engineCompactions: conversation.engineCompactions ?? null,
    nodes: (conversation.messages ?? []).map((node: MessageNode, index: number) => {
      const selected = node.messages[node.selectIndex] ?? node.messages[0];
      return {
        index,
        id: node.id,
        selectIndex: node.selectIndex,
        variants: node.messages.length,
        selected: selected ? summarizeMessage(selected) : null,
      };
    }),
  };
}

function buildEncodedReport(conversationId: string) {
  const loaded = loadConversationSnapshot(conversationId);
  if ("error" in loaded) return loaded;
  const conversation = loaded.conversation;
  const assistant = (state.settings.assistants ?? []).find((item) => item.id === conversation.assistantId);
  if (!assistant) return { error: `会话引用的助手不存在:${conversation.assistantId}(孤儿会话,继续聊天必然失败)` };
  const encoded = conversationTransformedMessages(conversation, assistant, { dynamicRecall: false });
  const messages = encoded.messages ?? [];
  let total = 0;
  const rows = messages.map((message, index) => {
    const tokens = contextTokensOf(message, { reasoning: true });
    total += tokens;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    return {
      index,
      id: message.id,
      role: message.role,
      tokens,
      textLen: parts.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0),
      partKinds: parts.map((part) => part.type),
      toolCount: parts.filter((part) => part.type === "tool").length,
      deadFileRefs: parts.filter(
        (part) =>
          (part.type === "image" || part.type === "video" || part.type === "audio" || part.type === "document")
          && !/^(https?|data|blob):/.test(part.url ?? ""),
      ).length,
    };
  });
  return {
    id: conversation.id,
    title: conversation.title,
    assistant: assistantSummary(assistant),
    model: encoded.picked?.model
      ? { id: encoded.picked.model.modelId, name: encoded.picked.model.displayName ?? null }
      : null,
    provider: encoded.picked?.provider
      ? { id: encoded.picked.provider.id, name: encoded.picked.provider.name, type: encoded.picked.provider.type }
      : null,
    messageCount: messages.length,
    estimatedTokens: total,
    systemTextLen: (() => {
      const system = messages.find((message) => message.role === "SYSTEM");
      return system ? system.parts.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0) : 0;
    })(),
    roles: messages.map((message) => message.role),
    deadFileRefs: rows.reduce((sum, row) => sum + row.deadFileRefs, 0),
    messages: rows,
  };
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RikkaHub 调试口</title>
<style>
:root{color-scheme:light dark}body{font:13px/1.5 ui-monospace,Consolas,monospace;margin:0;padding:16px;background:#0f1115;color:#d7dae0}
h1{font-size:15px;margin:0 0 12px}h2{font-size:13px;margin:18px 0 6px;color:#9aa4b2}
button{font:inherit;background:#1f2430;color:#d7dae0;border:1px solid #333a48;border-radius:4px;padding:4px 10px;cursor:pointer}
button:hover{background:#283040}button:disabled{opacity:.5;cursor:not-allowed}
pre{background:#161a22;border:1px solid #242a36;border-radius:4px;padding:10px;overflow:auto;max-height:60vh;white-space:pre-wrap;word-break:break-all}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.muted{color:#8b94a3}.err{color:#ff8f8f}.warn{color:#ffd479}a{color:#79b8ff}
</style></head><body>
<h1>RikkaHub 调试口</h1>
<div class="row">
  <button id="refresh">刷新状态</button>
  <button id="restart">重启服务</button>
  <span id="health" class="muted">加载中…</span>
</div>
<h2>实时日志(SSE)</h2>
<div class="row"><button id="clear">清屏</button><span class="muted">最多保留 500 行显示</span></div>
<pre id="logs"></pre>
<h2>最近请求(模型/搜索)</h2>
<pre id="requests">点「刷新状态」加载</pre>
<h2>应用树</h2>
<pre id="tree"></pre>
<h2>设置与调优</h2>
<div class="row"><button id="load-settings">读取全部设置</button><button id="save-settings">应用 JSON 补丁</button><span class="muted">密钥脱敏；保留 [REDACTED] 不会覆盖原值。修改立即保存。</span></div>
<textarea id="settings-editor" style="width:98%;height:240px;background:#161a22;color:#d7dae0"></textarea>
<pre id="settings-result">PATCH /debug/settings 修改任意设置。/debug/api/* 可调用现有应用 API，沿用其校验与执行流程。</pre>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const q = token ? ('?token=' + encodeURIComponent(token)) : '';
const withToken = (url, sep) => token ? (url + sep + 'token=' + encodeURIComponent(token)) : url;
const $ = (id) => document.getElementById(id);
const logsEl = $('logs');
function appendLog(e){
  const line = document.createElement('div');
  line.className = e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : '';
  line.textContent = new Date(e.at).toLocaleTimeString() + ' [' + e.level + '] ' + e.text;
  logsEl.appendChild(line);
  while (logsEl.childNodes.length > 500) logsEl.removeChild(logsEl.firstChild);
  logsEl.scrollTop = logsEl.scrollHeight;
}
async function refresh(){
  try {
    const health = await (await fetch('/debug/health' + q)).json();
    $('health').textContent = 'pid ' + health.pid + ' · v' + health.version + ' · 主端口 ' + health.mainPort + ' · 已运行 ' + health.uptimeSec + 's';
    const tree = await (await fetch('/debug/tree' + q)).json();
    $('tree').textContent = JSON.stringify(tree, null, 2);
    const reqs = await (await fetch('/debug/requests?limit=10' + (token ? '&token=' + encodeURIComponent(token) : ''))).json();
    $('requests').textContent = JSON.stringify(reqs.entries, null, 2);
  } catch (err) { $('health').textContent = '请求失败: ' + err; }
}
$('refresh').onclick = refresh;
$('load-settings').onclick=async()=>{const r=await(await fetch('/debug/settings'+q)).json();$('settings-editor').value=JSON.stringify(r.settings,null,2);};
$('save-settings').onclick=async()=>{try{const r=await fetch('/debug/settings'+q,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(JSON.parse($('settings-editor').value))});const result=await r.json();$('settings-result').textContent=JSON.stringify(result,null,2);}catch(e){$('settings-result').textContent=String(e);}};
$('clear').onclick = () => { logsEl.textContent = ''; };
$('restart').onclick = async () => {
  if (!confirm('确定重启 RikkaHub 后端?')) return;
  $('restart').disabled = true;
  try { await fetch('/debug/restart' + q, {method:'POST'}); } catch (e) {}
  $('health').textContent = '重启中…刷新页面等待新的 pid';
  $('restart').disabled = false;
};
const es = new EventSource(withToken('/debug/logs/stream', '?'));
es.addEventListener('log', (ev) => { try { appendLog(JSON.parse(ev.data)); } catch {} });
refresh();
</script></body></html>`;
}
