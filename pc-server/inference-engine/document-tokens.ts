// inference-engine/document-tokens.ts — document part 展开后的抽取文本计费(存储态口径)
//
// 背景(压缩 v2 落地后记 12 记的已知洞,本模块把它补上):存储态的 document part 只有
// `{ fileName, url }`,正文住在旁车缓存 `files/<id>.extracted.txt`。请求构建期
// (message-builder.contentPartsForApi)会把它展开成 documentPromptText 全文,所以
// **出站口径**(apiMessagesTokens)看得见它,而**存储态口径**(contextTokensOf)看不见
// → 上下文预算窗口、工具老化、自动压缩触发三处系统性低估。一份两百页 PDF 可以是几万
// token,在存储态账上却是 0:贴了大文档的会话永不触发压缩,直到撞窗口。
//
// 三条纪律(与 image-tokens 同源,那边是"只读图片头部字节",这边是"只读旁车缓存"):
//   一、**绝不触发抽取**。ensureExtractedTextAsync 是请求构建期的事;计费层跑在每轮
//       编码与预算裁决里,在这里拉起子进程抽 PDF 会把毫秒级裁决变成秒级阻塞,还会让
//       "看一眼会话体积"这种只读操作产生后台任务副作用。
//   二、**缓存 token 数,不缓存文本**。一份 PDF 全文可达 MB 级,留住文本等于把
//       "100MB state.json 事故"换个地方重演(旁车缓存本来就是为了把全文挪出账本)。
//       键带旁车 mtime + size,重抽/补抽自动失效,不需要手工清。
//   三、任何失败都降级、绝不抛。未命中抽取缓存时按 fallbackDocumentText 的体积计——
//       那正是本轮真实会发出去的文本,计 0 才是错的。
//
// 前端镜像口径:web-ui/app/lib/compaction.ts 只镜像 estimateTokens 的**文本公式**,
// 拿不到旁车缓存也拿不到图片字节,故图片与文档的体积都是后端专属口径(S1 起即如此)。
// 圆环显示的是供应商真实 usage,不吃这份估算,因此不存在"圆环与阈值打架"。

import { statSync } from "node:fs";
import { estimateTokens } from "../foundation/utils";
import { extractedTextPath, fallbackDocumentText, readExtractedTextSync } from "../files/index";
import { documentPromptText, fileEntryFromApiUrl } from "./message-builder";

const cache = new Map<string, number>();
const CACHE_MAX = 512;

/** 键 = url + 显示名 + 旁车版本(mtime:size)+ 老内存字段长度。
 *  旁车不存在时记 "none",此时正文只可能来自迁移窗口内的 entry.extractedText,
 *  故把它的长度也带上——两者都变才重算,任一不变就命中。 */
function cacheKey(url: string, fileName: string, fileId: number | null, legacyLength: number): string {
  let version = "none";
  if (fileId != null) {
    try {
      const stat = statSync(extractedTextPath(fileId));
      version = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      version = "none"; // 无旁车:走 legacy 字段或 fallback,两者都已进键
    }
  }
  return `${url}|${fileName}|${version}|${legacyLength}`;
}

function computeDocumentTokens(fileName: string, url: string): number {
  const entry = fileEntryFromApiUrl(url);
  const extracted = entry ? readExtractedTextSync(entry).trim() : "";
  // 与 contentPartsForApi 的 document 分支逐字同构:有全文走 documentPromptText,
  // 没有走 fallbackDocumentText。两处不允许各写一份,否则"发出去的"与"记账的"会漂移。
  const text = extracted
    ? documentPromptText(fileName, extracted)
    : fallbackDocumentText({ fileName, url, entry: entry ?? null });
  return estimateTokens(text);
}

/** 一个 document part 在模型视野里的近似 token。任何失败都降级为 fallback 文本体积,
 *  绝不抛——计费不该让生成挂掉,也不该让只读的体积诊断挂掉。
 *  入参按运行时实际宽容度声明(整条 part 记录):调用方可能传 MessagePart 也可能传
 *  工具输出条目,两者都只保证"是个记录",不保证字段齐全。 */
export function documentTokensForPart(part: Record<string, unknown>): number {
  const url = String(part.url ?? "");
  const fileName = String(part.fileName ?? "document");
  if (!url) return estimateTokens(fallbackDocumentText({ fileName, url, entry: null }));
  try {
    const entry = fileEntryFromApiUrl(url);
    const key = cacheKey(url, fileName, entry?.id ?? null, String(entry?.extractedText ?? "").length);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const tokens = computeDocumentTokens(fileName, url);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, tokens);
    return tokens;
  } catch {
    try {
      return estimateTokens(fallbackDocumentText({ fileName, url, entry: null }));
    } catch {
      return 0; // 连 fallback 都算不出(理论上不可能):计 0 也不让裁决崩
    }
  }
}

/** 测试 seam:清空 memoize,避免跨用例串味(与 resetImageTokenCache 同形)。 */
export function resetDocumentTokenCache(): void {
  cache.clear();
}