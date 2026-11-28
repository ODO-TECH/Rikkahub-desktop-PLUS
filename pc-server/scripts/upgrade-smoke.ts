// scripts/upgrade-smoke.ts — 升级冒烟（S4）。
// 契约：上一个发布版（0.2.1）写下的数据，新版能打开、历史不变；新版续聊一轮后，上一个发布版
// 还能打开这份数据、读到新增的对话。以后每次改存储都跑。
//
//   bun run smoke:upgrade             用仓库里的样本跑一遍（最后一步要 0.2.1 的 exe，找不到就跳过并说明）
//   bun run smoke:upgrade --generate  用 0.2.1 的 exe 重新生成样本（换基线版本时用）
//
// 样本在 scripts/upgrade-sample/0.2.1/，是 0.2.1 配本文件的假供应商生成的，不含任何真实密钥。
// expected.json 记着每个会话的节点数、各节点选中的分支与消息 id，以及续聊时发给模型的历史。
// 基线 exe 路径可用 RIKKAHUB_UPGRADE_BASELINE_EXE 覆盖；样本目录可用 RIKKAHUB_UPGRADE_SAMPLE_DIR 覆盖。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type AnyRecord = Record<string, any>;

const repoRoot = resolve(import.meta.dir, "../..");
const serverDir = join(repoRoot, "pc-server");
const sampleDir = process.env.RIKKAHUB_UPGRADE_SAMPLE_DIR ?? join(import.meta.dir, "upgrade-sample", "0.2.1");
const baselineExe =
  process.env.RIKKAHUB_UPGRADE_BASELINE_EXE ??
  resolve(repoRoot, "../release-0.2.1/RikkaHub-0.2.1-windows-x64/rikkahub-pc.exe");
/** 样本里的供应商地址写死了这个端口。 */
const MOCK_PORT = Number(process.env.SMOKE_UPGRADE_MOCK_PORT ?? 18192);
const APP_PORT = Number(process.env.SMOKE_UPGRADE_APP_PORT ?? 18193);
const mockBaseUrl = `http://127.0.0.1:${MOCK_PORT}/v1`;
const baseUrl = `http://127.0.0.1:${APP_PORT}`;
const MODEL_ID = "upgrade-smoke-model";
const REPLY_PREFIX = "升级冒烟回复";
const CONTINUE_TEXT = "升级冒烟：继续这一轮";
const SAMPLE_ENTRIES = ["state.json", "rikka_hub.db", "rikka_hub.db-wal", "rikka_hub.db-shm", "workspaces", "AGENTS.md"];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof (part as AnyRecord).text === "string" ? (part as AnyRecord).text : "")).join("");
}

function lastUserText(body: AnyRecord): string {
  const messages: AnyRecord[] = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.at(-1);
  return textOf(last?.content).trim();
}

// ---------- 假供应商：按请求内容应答，不按轮次排剧本 ----------

const requests: Array<{ path: string; body: AnyRecord }> = [];
let replySeq = 0;

function chatReply(body: AnyRecord) {
  const said = lastUserText(body);
  const reply = `${REPLY_PREFIX} #${++replySeq}：${said || "(空)"}`;
  return reply;
}

function sse(reply: string) {
  const frames = [
    { id: "chatcmpl-smoke", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] },
    { id: "chatcmpl-smoke", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } },
  );
}

const mock = Bun.serve({
  port: MOCK_PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    const body = (await req.json().catch(() => ({}))) as AnyRecord;
    requests.push({ path: url.pathname, body });
    const reply = chatReply(body);
    if (body.stream === false) {
      return Response.json({
        id: "chatcmpl-smoke",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    }
    return sse(reply);
  },
});

// ---------- 服务进程 ----------

type Proc = Bun.Subprocess;

function spawnBaseline(dataDir: string): Proc {
  return Bun.spawn([baselineExe], {
    cwd: dirname(baselineExe),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      BROWSER: "none",
      RIKKAHUB_ANALYTICS: "0",
      RIKKAHUB_PC_DATA_DIR: dataDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForHealth(timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // 还在启动
    }
    await Bun.sleep(200);
  }
  throw new Error("server did not become healthy");
}

async function stopServer(proc: Proc) {
  try {
    await fetch(`${baseUrl}/api/app/shutdown`, { method: "POST" });
  } catch {
    // 端点不可用时直接 kill
  }
  const exited = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => null)]);
  if (exited === null) proc.kill();
  try {
    await proc.exited;
  } catch {
    // 已退出
  }
}

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  return data;
}

// ---------- 对话读写 ----------

function selectedMessages(conversation: AnyRecord): AnyRecord[] {
  return (conversation.messages ?? []).map((node: AnyRecord) => node.messages[node.selectIndex] ?? node.messages[0]);
}

async function waitForReply(conversationId: string, minNodes: number, timeoutMs = 30_000): Promise<AnyRecord> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const conversation = (await api(`/api/conversations/${conversationId}`)) as AnyRecord;
    const nodes = conversation.messages ?? [];
    const last = nodes.at(-1);
    const lastText = textOf((last?.messages?.[last?.selectIndex ?? 0] ?? last?.messages?.[0])?.parts ?? []);
    if (!conversation.isGenerating && nodes.length >= minNodes && lastText.includes(REPLY_PREFIX)) return conversation;
    await Bun.sleep(250);
  }
  throw new Error(`conversation ${conversationId} did not finish`);
}

async function sendTurn(conversationId: string, text: string, minNodes: number) {
  await api(`/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text }] }) });
  return waitForReply(conversationId, minNodes);
}

async function configureMockProvider() {
  const settings = (await api("/api/settings")) as AnyRecord;
  const model = {
    id: MODEL_ID,
    modelId: "upgrade-smoke",
    displayName: "Upgrade Smoke",
    type: "CHAT",
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    abilities: ["REASONING"],
    tools: [],
  };
  await api("/api/settings/provider", {
    method: "POST",
    body: JSON.stringify({
      type: "openai",
      id: "upgrade-smoke-provider",
      enabled: true,
      name: "Upgrade Smoke Provider",
      builtIn: false,
      shortDescription: "local upgrade smoke provider",
      description: "local upgrade smoke provider",
      apiKey: "smoke-key",
      baseUrl: mockBaseUrl,
      chatCompletionsPath: "/chat/completions",
      useResponseApi: false,
      promptCaching: false,
      promptCacheTtl: "5m",
      testPassed: true,
      testPassedAt: Date.now(),
      models: [model],
      balanceOption: { enabled: false, apiPath: "/credits", resultPath: "balance" },
    }),
  });
  const assistant = (settings.assistants ?? []).find((item: AnyRecord) => item.id === settings.assistantId);
  assert(assistant, "default assistant missing");
  await api("/api/settings/assistant/detail", {
    method: "POST",
    body: JSON.stringify({
      ...assistant,
      chatModelId: MODEL_ID,
      name: "Upgrade Smoke",
      systemPrompt: "You are an upgrade smoke assistant.",
      messageTemplate: "{{ message }}",
      presetMessages: [],
      regexes: [],
      streamOutput: true,
      enableMemory: false,
      useGlobalMemory: false,
      enableRecentChatsReference: false,
      enableTimeReminder: false,
      reasoningLevel: "low",
      localTools: [],
      enabledSkills: [],
      mcpServers: [],
      modeInjectionIds: [],
      lorebookIds: [],
      quickMessageIds: [],
      allowConversationSystemPrompt: true,
    }),
  });
}

function conversationSnapshot(conversation: AnyRecord) {
  const nodes = (conversation.messages ?? []).map((node: AnyRecord) => ({
    id: node.id,
    selectIndex: node.selectIndex ?? 0,
    messages: (node.messages ?? []).map((message: AnyRecord) => ({ id: message.id, role: message.role, text: textOf(message.parts ?? []) })),
  }));
  return {
    nodeCount: nodes.length,
    nodes,
    history: selectedMessages(conversation).map((message: AnyRecord) => ({ role: message.role, text: textOf(message.parts ?? []) })),
  };
}

function copyInto(fromDir: string, toDir: string) {
  mkdirSync(toDir, { recursive: true });
  for (const name of SAMPLE_ENTRIES) {
    const source = join(fromDir, name);
    if (!existsSync(source)) continue;
    cpSync(source, join(toDir, name), { recursive: true });
  }
}

// ---------- 生成样本 ----------

async function generate() {
  assert(existsSync(baselineExe), `baseline exe not found: ${baselineExe}（用 RIKKAHUB_UPGRADE_BASELINE_EXE 指定）`);
  const tempDir = mkdtempSync(join(tmpdir(), "rkh-upgrade-gen-"));
  let proc: Proc | undefined;
  try {
    proc = spawnBaseline(tempDir);
    await waitForHealth();
    console.log("[generate] 0.2.1 已就绪，配置假供应商");
    await configureMockProvider();

    const convA = "upgrade-smoke-a";
    const convB = "upgrade-smoke-b";
    console.log("[generate] 写入两个会话");
    await sendTurn(convA, "升级冒烟第一问", 2);
    await sendTurn(convA, "升级冒烟第二问", 4);
    await sendTurn(convB, "升级冒烟另一个会话", 2);

    const a = (await api(`/api/conversations/${convA}`)) as AnyRecord;
    const b = (await api(`/api/conversations/${convB}`)) as AnyRecord;
    const expected = {
      baselineVersion: "0.2.1",
      generatedAt: new Date().toISOString(),
      mockBaseUrl,
      continueTarget: convA,
      continueText: CONTINUE_TEXT,
      conversations: [
        { id: convA, ...conversationSnapshot(a) },
        { id: convB, ...conversationSnapshot(b) },
      ],
    };

    await stopServer(proc);
    proc = undefined;

    rmSync(sampleDir, { recursive: true, force: true });
    copyInto(tempDir, sampleDir);
    // 干净停机已 checkpoint：0 字节的 -wal/-shm 是残留，不随样本分发
    for (const name of ["rikka_hub.db-wal", "rikka_hub.db-shm"]) rmSync(join(sampleDir, name), { force: true });
    writeFileSync(join(sampleDir, "expected.json"), JSON.stringify(expected, null, 2), "utf-8");
    console.log(`[generate] 样本已写入 ${sampleDir}`);
  } finally {
    if (proc) await stopServer(proc);
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows 句柄释放可能滞后，留给系统清理
    }
  }
}

// ---------- 默认：跑升级冒烟 ----------

function assertConversationMatches(expectedConv: AnyRecord, actual: AnyRecord) {
  assert(actual.id === expectedConv.id, `conversation id mismatch: ${actual.id}`);
  const nodes = actual.messages ?? [];
  assert(nodes.length === expectedConv.nodeCount, `${actual.id}: node count ${nodes.length} != ${expectedConv.nodeCount}`);
  expectedConv.nodes.forEach((expectedNode: AnyRecord, index: number) => {
    const node = nodes[index];
    assert(node.id === expectedNode.id, `${actual.id}: node ${index} id mismatch`);
    assert((node.selectIndex ?? 0) === expectedNode.selectIndex, `${actual.id}: node ${index} selectIndex mismatch`);
    (node.messages ?? []).forEach((message: AnyRecord, messageIndex: number) => {
      assert(message.id === expectedNode.messages[messageIndex]?.id, `${actual.id}: node ${index} message ${messageIndex} id mismatch`);
    });
  });
}

function historyMatches(expectedHistory: AnyRecord[], payloadMessages: AnyRecord[]): boolean {
  let cursor = 0;
  for (const message of payloadMessages) {
    if (cursor >= expectedHistory.length) break;
    const role = String(message.role ?? "").toUpperCase();
    const text = textOf(message.content).trim();
    if (role === String(expectedHistory[cursor].role).toUpperCase() && text === expectedHistory[cursor].text) cursor += 1;
  }
  return cursor === expectedHistory.length;
}

async function run() {
  const expectedPath = join(sampleDir, "expected.json");
  assert(existsSync(expectedPath), `样本缺失：${expectedPath}，先运行 bun run smoke:upgrade --generate`);
  const expected = JSON.parse(readFileSync(expectedPath, "utf-8")) as AnyRecord;
  const dataDir = mkdtempSync(join(tmpdir(), "rkh-upgrade-run-"));
  let proc: Proc | undefined;
  try {
    copyInto(sampleDir, dataDir);

    // 1) 新版打开 0.2.1 的数据：历史不变
    proc = Bun.spawn([process.execPath, "server.ts"], {
      cwd: serverDir,
      env: { ...process.env, PORT: String(APP_PORT), BROWSER: "none", RIKKAHUB_ANALYTICS: "0", RIKKAHUB_PC_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForHealth();
    for (const expectedConv of expected.conversations) {
      const actual = (await api(`/api/conversations/${expectedConv.id}`)) as AnyRecord;
      assertConversationMatches(expectedConv, actual);
    }
    console.log(`[upgrade] 0.2.1 数据在新版打开：${expected.conversations.length} 个会话历史一致`);

    // 2) 新版续聊：发给模型的历史不变，多出一轮问答
    const target = expected.conversations.find((item: AnyRecord) => item.id === expected.continueTarget) as AnyRecord;
    assert(target, "continue target missing");
    const beforeRequests = requests.length;
    await sendTurn(target.id, expected.continueText, target.nodeCount + 2);
    const continued = (await api(`/api/conversations/${target.id}`)) as AnyRecord;
    assert((continued.messages ?? []).length === target.nodeCount + 2, `续聊后节点数 ${(continued.messages ?? []).length} != ${target.nodeCount + 2}`);
    const request = [...requests.slice(beforeRequests)].reverse().find((item) => JSON.stringify(item.body).includes(expected.continueText));
    assert(request, "续聊请求未到达假供应商");
    const payloadMessages: AnyRecord[] = Array.isArray(request.body.messages) ? request.body.messages : [];
    if (!historyMatches(target.history, payloadMessages)) {
      const brief = (items: AnyRecord[]) =>
        items.map((item) => ({ role: item.role, text: String(item.text ?? textOf(item.content ?? item.parts ?? [])).slice(0, 120) }));
      console.error("[upgrade][debug] expected:", JSON.stringify(brief(target.history as AnyRecord[]), null, 1));
      console.error("[upgrade][debug] payload:", JSON.stringify(brief(payloadMessages), null, 1));
      throw new Error("续聊时发给模型的历史与 0.2.1 写下的不一致");
    }
    console.log("[upgrade] 续聊一轮：历史一致、模型请求正常");

    await stopServer(proc);
    proc = undefined;

    // 3) 0.2.1 再打开新版写过的数据
    if (!existsSync(baselineExe)) {
      console.log(`[upgrade] 跳过旧版回读：找不到基线 exe（${baselineExe}）`);
    } else {
      proc = spawnBaseline(dataDir);
      await waitForHealth();
      const reopened = (await api(`/api/conversations/${target.id}`)) as AnyRecord;
      const nodes = reopened.messages ?? [];
      assert(nodes.length === target.nodeCount + 2, `0.2.1 回读节点数 ${nodes.length} != ${target.nodeCount + 2}`);
      const last = nodes.at(-1);
      const lastText = textOf((last?.messages?.[last?.selectIndex ?? 0] ?? last?.messages?.[0])?.parts ?? []);
      assert(lastText.includes(REPLY_PREFIX), "0.2.1 回读不到新版写入的回复");
      const byIds = new Set(nodes.map((node: AnyRecord) => node.id));
      for (const oldNode of target.nodes) assert(byIds.has(oldNode.id), `0.2.1 回读丢了节点 ${oldNode.id}`);
      console.log("[upgrade] 0.2.1 能打开新版写过的数据：新增一轮可见、旧节点不丢");
      await stopServer(proc);
      proc = undefined;
    }

    console.log("[upgrade] PASS");
  } finally {
    if (proc) await stopServer(proc);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort：Windows 上句柄释放可能滞后
    }
    mock.stop(true);
  }
}

if (process.argv.includes("--generate")) {
  await generate();
  mock.stop(true);
} else {
  await run();
}