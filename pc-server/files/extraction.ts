import { spawnTracked } from "../foundation/child-registry";
// files/extraction.ts — 专题4:文档全文提取的子进程编排(父侧)+ worker 模式(子侧)
//
// 为什么是"用完即弃的子进程"而不是主进程内直接解析:
//   1. wasm 堆只涨不缩——mupdf 解析过一个大 PDF 后,主进程会永久占着峰值内存;
//      子进程退出即归还操作系统,主进程内存曲线与文档大小彻底解耦。
//   2. 崩溃隔离——损坏/恶意 PDF 把 wasm 打崩时只死子进程,服务器与用户会话无感。
//   3. 卡死可杀——解析卡住可以直接 kill,主进程里跑的同步 wasm 代码杀不掉。
//   4. 逐页进度——子进程 stdout 逐行上报 EXTRACT_PROGRESS,前端进度圆圈轮询消费。
//
// 单 exe 自孵化:cmd = [process.execPath, ...process.argv.slice(1)] 原样复刻本进程的
// 启动命令(dev 下是 `bun server.ts …`,编译单 exe 下 argv[1] 是 bunfs 虚拟入口路径、
// exe 会照常跑自己嵌入的入口,该路径只当普通参数落进 args Set,不影响旗标判定),用
// 环境变量 RIKKAHUB_EXTRACT_WORKER=1 让入口在绑端口/抢数据目录锁【之前】拐进 worker 分支。
// Bun 的 process.argv 不含 --watch 等运行时旗标,不会复刻出常驻的 watch 子进程。
//
// 纪律:本模块只管"怎么跑提取",解析器本体在 files/index.ts;不修改业务状态。

import { existsSync } from "node:fs";
import process from "node:process";
import type { StoredFile } from "../foundation/types";
import { reportError } from "../observability/app-errors";
import {
  isDeepSeekOcrConfigured,
  isDeepSeekOcrDocument,
  recognizeFileWithDeepSeekOcr,
} from "../media/ocr";
import {
  extractStoredFileText,
  extractedTextPath,
  isExtractableDocument,
  readExtractedTextSync,
  writeExtractedTextSidecar,
} from "./index";

export type ExtractionState = "pending" | "done" | "empty" | "failed" | "none";

export interface ExtractionStatus {
  status: ExtractionState;
  /** PDF 逐页进度(其他格式解析快,没有中间进度,直接从 pending 跳到终态)。 */
  done: number | null;
  total: number | null;
}

// 逐 chunk 读子进程流。不用 `for await...of stream`:pi 0.84.2 升级把 @types/node 的
// undici-types 拉进编译图,其全局 ReadableStream(stream/web)遮蔽了 lib.dom.iterable 的
// 可迭代声明,Symbol.asyncIterator 在类型层丢失;显式 getReader() 与该全局声明之争无关。
async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// ── 父侧:任务登记簿 + 并发泵 ────────────────────────────────────────────────
//
// registry 语义(接替原 in-flight 去重 + R4-4 空结果负缓存,均为进程内、不落盘):
//   pending → 子进程在跑/在队列里;done → 旁车已写;empty → 提取过但没有文本
//   (扫描版 PDF 等,本次运行不再重试);failed → 子进程崩溃/超时/被杀(同样本次
//   运行不再重试——自动重试会在"必崩文件"上形成无限重生循环;重启或重新上传即重试)。
const registry = new Map<number, { status: "pending" | "done" | "empty" | "failed"; done?: number; total?: number }>();
const queue: StoredFile[] = [];
let activeCount = 0;
// 并发上限 2:提取是 CPU 密集活,再多只会互相抢核;多余任务排队保持 pending。
const MAX_CONCURRENT_EXTRACTIONS = 2;
// 停滞超时:无进度输出 5 分钟判死。用"停滞"而非绝对时长——万页大书只要每页都在
// 前进就不该被杀,真卡死(单页死循环)才需要收割。
const STALL_TIMEOUT_MS = 5 * 60_000;

/** 本地提出来的文字少到这个程度 → 判为扫描件(非空白字符/页)。
 *  参照:正常排版的中文 PDF 一页 500～1500 字;扫描件的文本层往往只剩水印与页码,
 *  光判「为空」会漏掉带水印的那一批,而那正是用户最想让它读出来的文件。
 *  导出仅为让单测能拿同一个数算边界,不在别处复制判据。 */
export const DEEPSEEK_OCR_SPARSE_CHARS_PER_PAGE = 30;

/**
 * 「本地读不出来 → 升级到 DeepSeek 官方 OCR」的唯一决策点(导出只为让这条花钱的
 * 判定链可被直接断言,业务侧不要在别处复制判据)。
 * 两条来路共用:① 子进程跑完但全文为空/像扫描件;② 本地根本不解析的格式(老 DOC/PPT)。
 * EPUB/纯文本类不在官方格式表内,永不升级;开关关或 Key 未填时恒为 null(行为与引入前一致)。
 */
export function deepSeekOcrEscalationFor(
  entry: Pick<StoredFile, "fileName" | "mime">,
  localText: string,
  pageCount: number | null,
): "empty" | "sparse" | null {
  if (!isDeepSeekOcrConfigured()) return null;
  if (!isDeepSeekOcrDocument(entry.fileName, entry.mime)) return null;
  const chars = localText.replace(/\s+/g, "").length;
  if (chars === 0) return "empty";
  if (pageCount && pageCount > 0 && chars < DEEPSEEK_OCR_SPARSE_CHARS_PER_PAGE * pageCount) return "sparse";
  return null;
}

// 官方 OCR 升级队列:与本地提取各自占用 MAX_CONCURRENT_EXTRACTIONS 名额。
// 单账号官方并发上限 15(超出 429),这里压到 2 已经足够保守——批量拖 50 个扫描件
// 也不会瞬间打满配额,而本地那条「提取是 CPU 密集活」的理由对网络等待同样不该被绕过。
const ocrQueue: Array<{ entry: StoredFile; reason: "empty" | "sparse"; pageCount: number | null }> = [];
let ocrActiveCount = 0;

function queueDeepSeekOcrEscalation(entry: StoredFile, reason: "empty" | "sparse", pageCount: number | null): void {
  if (registry.has(entry.id) && registry.get(entry.id)?.status === "pending") return;
  registry.set(entry.id, { status: "pending", total: pageCount ?? undefined });
  ocrQueue.push({ entry, reason, pageCount });
  pumpOcr();
}

function pumpOcr(): void {
  while (ocrActiveCount < MAX_CONCURRENT_EXTRACTIONS && ocrQueue.length > 0) {
    const task = ocrQueue.shift();
    if (!task) break;
    ocrActiveCount += 1;
    void runDeepSeekOcrEscalation(task.entry, task.reason, task.pageCount).finally(() => {
      ocrActiveCount -= 1;
      pumpOcr();
    });
  }
}

/** 升级执行:成功才写旁车缓存;空结果与失败一律保留本地文本与原状态——绝不把已有文字抹掉,
 *  也不把 done 打成 empty(旁车缓存天然防重复计费,同一文件本次运行只 OCR 一次)。 */
async function runDeepSeekOcrEscalation(entry: StoredFile, reason: "empty" | "sparse", pageCount: number | null): Promise<void> {
  const hadLocalText = readExtractedTextSync(entry).trim().length > 0;
  const started = Date.now();
  try {
    const result = await recognizeFileWithDeepSeekOcr(entry.path, entry.fileName);
    if (result.text.trim()) {
      writeExtractedTextSidecar(entry.id, result.text);
      registry.set(entry.id, { status: "done", done: result.pageCount, total: result.pageCount });
      console.log(
        `[extract] ${entry.fileName} DeepSeek OCR(${reason}) done: ${result.pageCount} 页`
        + (result.truncatedPages.length > 0 ? `，其中 ${result.truncatedPages.length} 页被输出上限截断` : "")
        + `，${Date.now() - started}ms`,
      );
      return;
    }
    console.log(`[extract] ${entry.fileName} DeepSeek OCR(${reason}) 没有识别出文字`);
    registry.set(entry.id, hadLocalText ? { status: "done" } : { status: "empty" });
  } catch (err) {
    console.warn(`[extract] ${entry.fileName} DeepSeek OCR(${reason}) failed:`, err);
    // info 级留痕(错误中心可见、不弹全局 toast):本地结果仍在,用户不会丢内容。
    reportError("provider", "info", "DeepSeek OCR 文档识别失败，已保留本地解析结果", err, "deepseek_ocr_document_failed", { fileName: entry.fileName });
    registry.set(entry.id, hadLocalText ? { status: "done" } : { status: "empty" });
  }
}

/** 后台提取入口(3-4 的 ensureExtractedTextAsync 迁移至此,语义不变:调用即返回,
 *  结果写旁车缓存,本次请求方降级 fallbackDocumentText,下次发送生效)。 */
export function ensureExtractedTextAsync(entry: StoredFile): void {
  if (registry.has(entry.id)) return;
  // 本地解析不了的文档(老 DOC/PPT 这类):开关开着且官方吃这个格式时直接升级到官方 OCR
  // ——它们此前只能落到「内容无法提取」的占位提示,是净收益档;开关关时仍按原样 return。
  if (!isExtractableDocument(entry)) {
    const reason = deepSeekOcrEscalationFor(entry, "", null);
    if (!reason) return;
    queueDeepSeekOcrEscalation(entry, reason, null);
    return;
  }
  if (existsSync(extractedTextPath(entry.id))) {
    registry.set(entry.id, { status: "done" });
    return;
  }
  registry.set(entry.id, { status: "pending" });
  queue.push(entry);
  pump();
}

/** 提取状态查询(files/:id/extraction 端点用)。重启后旁车缺失且无任务时自动重新
 *  拉起——轮询本身就是自愈触发器,上次没抽完就退出的文件不会永远停在"解析中"。 */
export function getExtractionStatus(entry: StoredFile): ExtractionStatus {
  const current = registry.get(entry.id);
  if (current) {
    return { status: current.status, done: current.done ?? null, total: current.total ?? null };
  }
  if (existsSync(extractedTextPath(entry.id))) return { status: "done", done: null, total: null };
  if (!isExtractableDocument(entry)) return { status: "none", done: null, total: null };
  ensureExtractedTextAsync(entry);
  return { status: "pending", done: null, total: null };
}

function pump(): void {
  while (activeCount < MAX_CONCURRENT_EXTRACTIONS && queue.length > 0) {
    const entry = queue.shift();
    if (!entry) break;
    activeCount += 1;
    void runExtractionChild(entry).finally(() => {
      activeCount -= 1;
      pump();
    });
  }
}

async function runExtractionChild(entry: StoredFile): Promise<void> {
  const t0 = Date.now();
  let result: "ok" | "empty" | null = null;
  // 子进程逐页进度里最后一次报的总页数:OCR 升级的「文本密度像扫描件」判定要用它。
  let lastTotalPages: number | null = null;
  try {
    const child = spawnTracked([process.execPath, ...process.argv.slice(1)], {
      purpose: "document-extraction",
      env: {
        ...process.env,
        RIKKAHUB_EXTRACT_WORKER: "1",
        RIKKAHUB_EXTRACT_FILE_ID: String(entry.id),
        RIKKAHUB_EXTRACT_PATH: entry.path,
        RIKKAHUB_EXTRACT_NAME: entry.fileName,
        RIKKAHUB_EXTRACT_MIME: entry.mime,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let killedForStall = false;
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        killedForStall = true;
        try { child.kill(); } catch { /* 已退出 */ }
      }, STALL_TIMEOUT_MS);
    };
    armStallTimer();

    // stderr 旁路收集(封顶 4KB),失败时给日志一个现场。
    let stderrText = "";
    const stderrDone = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of streamChunks(child.stderr)) {
        if (stderrText.length < 4096) stderrText += decoder.decode(chunk, { stream: true });
      }
    })();

    const decoder = new TextDecoder();
    let lineBuffer = "";
    for await (const chunk of streamChunks(child.stdout)) {
      armStallTimer();
      lineBuffer += decoder.decode(chunk, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        if (line.startsWith("EXTRACT_PROGRESS ")) {
          const [doneRaw, totalRaw] = line.slice("EXTRACT_PROGRESS ".length).split(" ");
          const done = Number(doneRaw);
          const total = Number(totalRaw);
          if (Number.isFinite(done) && Number.isFinite(total)) {
            lastTotalPages = total;
            registry.set(entry.id, { status: "pending", done, total });
          }
        } else if (line.startsWith("EXTRACT_RESULT ")) {
          result = line.includes(" ok") ? "ok" : "empty";
        }
      }
    }
    const exitCode = await child.exited;
    if (stallTimer) clearTimeout(stallTimer);
    await stderrDone.catch(() => { /* stderr 读取失败不影响结果判定 */ });

    if (exitCode === 0 && result === "ok" && existsSync(extractedTextPath(entry.id))) {
      registry.set(entry.id, { status: "done" });
      console.log(`[extract] ${entry.fileName} done in ${Date.now() - t0}ms`);
    } else if (exitCode === 0 && result === "empty") {
      registry.set(entry.id, { status: "empty" });
      console.log(`[extract] ${entry.fileName} produced no text (scanned/unsupported)`);
    } else {
      registry.set(entry.id, { status: "failed" });
      const reason = killedForStall ? `stalled >${STALL_TIMEOUT_MS}ms, killed` : `exit ${exitCode}`;
      console.warn(`[extract] ${entry.fileName} failed (${reason}) ${stderrText.slice(0, 1000)}`);
    }
    // 本地解析「读不出来」的那两档(全空 / 像扫描件)才升级给 DeepSeek 官方 OCR。
    // 判定与开关都在 deepSeekOcrEscalationFor 单点;子进程崩溃/超时的 failed 不升级——
    // 那类文件重试才是正解,拿付费接口去填一个必崩的坑是双重损失。
    if (exitCode === 0 && (result === "ok" || result === "empty")) {
      const reason = deepSeekOcrEscalationFor(entry, readExtractedTextSync(entry), lastTotalPages);
      if (reason) queueDeepSeekOcrEscalation(entry, reason, lastTotalPages);
    }
  } catch (err) {
    registry.set(entry.id, { status: "failed" });
    console.warn(`[extract] ${entry.fileName} spawn failed:`, err);
  }
}

// ── 子侧:worker 模式 ────────────────────────────────────────────────────────

/** server.ts 入口最早处调用(必须先于数据目录锁与端口绑定):被父进程以
 *  RIKKAHUB_EXTRACT_WORKER=1 孵化时,执行单次提取后由调用方 process.exit。
 *  返回 true 表示本进程是提取 worker。 */
export async function maybeRunExtractionWorker(): Promise<boolean> {
  if (process.env.RIKKAHUB_EXTRACT_WORKER !== "1") return false;
  const fileId = Number(process.env.RIKKAHUB_EXTRACT_FILE_ID);
  const entry: StoredFile = {
    id: fileId,
    path: process.env.RIKKAHUB_EXTRACT_PATH ?? "",
    fileName: process.env.RIKKAHUB_EXTRACT_NAME ?? "",
    mime: process.env.RIKKAHUB_EXTRACT_MIME ?? "application/octet-stream",
    size: 0,
  };
  try {
    if (!Number.isFinite(fileId) || !entry.path || !existsSync(entry.path)) {
      throw new Error(`invalid extraction task: id=${process.env.RIKKAHUB_EXTRACT_FILE_ID} path=${entry.path}`);
    }
    let lastPrintMs = 0;
    const text = await extractStoredFileText(entry, (done, total) => {
      // 逐页回调节流到 200ms:万页 PDF 也不至于用 stdout 刷爆父进程的行解析。
      const now = Date.now();
      if (done !== total && now - lastPrintMs < 200) return;
      lastPrintMs = now;
      console.log(`EXTRACT_PROGRESS ${done} ${total}`);
    });
    if (text) {
      writeExtractedTextSidecar(fileId, text);
      console.log(`EXTRACT_RESULT ok ${text.length}`);
    } else {
      console.log("EXTRACT_RESULT empty");
    }
  } catch (err) {
    console.error("[extract-worker] failed:", err);
    process.exitCode = 1;
  }
  return true;
}
