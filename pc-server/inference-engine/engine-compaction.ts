// inference-engine/engine-compaction.ts — 压缩切点记录的引擎中性判定单源
//
// 压缩记录是会话级状态(conversation.engineCompactions,仅存 PC 自有库),不是某个
// 引擎的私有物:工作区(pi)用它重放原生 compaction,聊天引擎用它把切点接入富化窗口
// 并注入摘要。两边的"哪条记录生效"必须是同一个算法,否则同一份数据在两种模式下
// 给出不同的模型视野。
//
// 与编码器的分工:本模块只回答"哪条记录生效",不决定"怎么编码"。pi 侧还要求切点
// 行真的能编出条目(encodesToEntries),那是 pi 编码器的知识,通过 isUsable 谓词
// 注回来;聊天侧只要求切点仍在选中路径里(它的窗口锚是纯下标,不依赖内容)。
//
// 取"最新一条"而不是合并:压缩记录天然是链式的——每次压缩的 summary 已包含上一次
// 摘要(见 auxiliary.ts compressConversation 的链式拼接),所以最新一条就是完整状态。

import type { JsonValue, Message } from "../foundation/types";
import { estimateTokens, isRecord } from "../foundation/utils";

/** DB 压缩记录(conversation.engineCompactions 元素)。
 *
 *  两代形态并存,不做数据迁移:
 *  - v1(无 startMessageId):一条记录代表"切点之前的全部历史",多次压缩靠
 *    mergeCompactionSummary 链式拼接成一份越来越长的摘要。只有最新一条生效。
 *  - v2/S5(有 startMessageId):一条记录是一个**块**,只覆盖 [start, cut) 这段原文。
 *    多个块按锚点顺序并列生效,每块摘要各自渲染——追加新块不改写旧块摘要,
 *    出站请求前缀逐字节稳定(前缀缓存友好),这是 v1 链式重写做不到的。 */
export interface EngineCompactionRecord {
  /** 切点:从这条消息(含)起保留原文,之前的历史被 summary 取代。 */
  cutMessageId: string;
  /** 被取代历史的摘要。v1 第二次压缩起为链式文本(含更早的摘要);v2 每块只含本段。 */
  summary: string;
  /** 压缩前的上下文估算(展示/诊断用,不参与判定)。 */
  tokensBefore: number;
  createdAt?: string;
  /** S5:记录身份(S6 血统引用用)。旧记录无 id → compactionRecordId 用 legacy:<cut> 兜底。 */
  id?: string;
  /** S5:本块覆盖的原文起点(含)。缺省 = v1 语义"切点之前全部",起点视为 0。 */
  startMessageId?: string;
  /** S6:蒸馏层级。tier-1 折原文,tier-2+ 折下层块摘要。缺省 1。 */
  tier?: number;
  /** S6:本块由哪些下层块蒸馏而来(血统)。被吸收的块置 active=false 但记录保留,
   *  据此可逐层回溯到原文——原文本身一条不删,始终在 SQLite 里。 */
  consumedRecordIds?: string[];
  /** S6:被上层块吸收后置 false。只翻转标记,绝不删记录/删消息。缺省 true。 */
  active?: boolean;
}

/** 记录身份:新记录用自带 id,旧记录用切点兜底(同一会话里切点唯一,不会撞)。 */
export function compactionRecordId(record: EngineCompactionRecord): string {
  return record.id ?? `legacy:${record.cutMessageId}`;
}

/** 蒸馏层级上限:再往上折就是"摘要的摘要的摘要",信息密度已低于噪声,不如让
 *  应急截断/预算头切去处理体量。缺省/非法值一律按 tier-1(v1 记录同此)。 */
export const COMPACTION_TIER_MAX = 3;

export function compactionTierOf(record: EngineCompactionRecord): number {
  const tier = typeof record.tier === "number" && Number.isFinite(record.tier) ? Math.floor(record.tier) : 1;
  return Math.min(COMPACTION_TIER_MAX, Math.max(1, tier));
}

/** DB 任意 JSON → 压缩记录。宽容校验:坏条目丢弃而不是整列作废(与列解析
 *  "损坏回 null"同哲学)。 */
export function parseEngineCompactions(raw: JsonValue[] | null | undefined): EngineCompactionRecord[] {
  const records: EngineCompactionRecord[] = [];
  for (const item of raw ?? []) {
    if (!isRecord(item)) continue;
    if (typeof item.cutMessageId !== "string" || typeof item.summary !== "string") continue;
    const record: EngineCompactionRecord = {
      cutMessageId: item.cutMessageId,
      summary: item.summary,
      tokensBefore: typeof item.tokensBefore === "number" ? item.tokensBefore : 0,
    };
    if (typeof item.createdAt === "string") record.createdAt = item.createdAt;
    if (typeof item.id === "string" && item.id) record.id = item.id;
    if (typeof item.startMessageId === "string" && item.startMessageId) record.startMessageId = item.startMessageId;
    if (typeof item.tier === "number" && Number.isFinite(item.tier)) record.tier = item.tier;
    if (Array.isArray(item.consumedRecordIds)) {
      const ids = item.consumedRecordIds.filter((value): value is string => typeof value === "string" && value.length > 0);
      if (ids.length > 0) record.consumedRecordIds = ids;
    }
    if (typeof item.active === "boolean") record.active = item.active;
    records.push(record);
  }
  return records;
}

/** 一个生效块:本块摘要取代原文区间 [startIndex, cutIndex)(纯下标,未做工具配对对齐)。 */
export interface CompactionBlock {
  record: EngineCompactionRecord;
  startIndex: number;
  cutIndex: number;
  tier: number;
}

/** 生效块解析(S5):从"最新一条记录"改为"所有 active 块按锚点排序"。
 *
 *  连续性纪律:块必须首尾相接(前块 cut == 后块 start)才 admitted。渲染层把摘要行
 *  依次放在序列最前、原文从最后一块的 cut 起保留(与 v1 单切点同形),所以一旦出现
 *  空洞(中间块被停用/切点被删),后续块就不再可信——**在第一个断点处停下**,而不是
 *  跳过它继续收后面的块。这样被丢弃的块所覆盖的原文重新逐字可见,是唯一不丢信息的
 *  降级方向(与 v1"陈旧记录回落到更早一条"同哲学)。
 *
 *  v1 兼容:无 startMessageId 的记录视为"覆盖切点之前全部",起点 0;多条 v1 记录
 *  只有最后一条是候选(更早的已被链式摘要覆盖),与引入前逐字节一致。
 *
 *  isUsable 由调用方给:pi 传"该行能否编出条目",聊天传恒真(只校验在场)。 */
export function resolveCompactionBlocks(
  compactions: EngineCompactionRecord[],
  history: Message[],
  isUsable: (message: Message) => boolean,
): CompactionBlock[] {
  const indexOf = (id: string) => history.findIndex((msg) => msg.id === id);
  const usable = compactions.filter((record) => {
    if (record.active === false) return false;
    const cutIndex = indexOf(record.cutMessageId);
    if (cutIndex < 0) return false;
    return isUsable(history[cutIndex]!);
  });

  const blocks: CompactionBlock[] = [];
  // v1 链:只取最后一条仍有效的记录,起点恒 0。
  const legacy = usable.filter((record) => !record.startMessageId).at(-1);
  if (legacy) {
    const cutIndex = indexOf(legacy.cutMessageId);
    // cutIndex 可以是 0(切点就是首条消息 = 实际没折掉任何原文):v1 也照样返回该
    // 记录并注入摘要,这里保持同判定,不额外加"必须折掉东西"的门槛。
    blocks.push({ record: legacy, startIndex: 0, cutIndex, tier: compactionTierOf(legacy) });
  }
  // v2 块:按起点排序后要求首尾相接。
  const modern = usable
    .filter((record) => Boolean(record.startMessageId))
    .map((record) => ({ record, startIndex: indexOf(record.startMessageId!), cutIndex: indexOf(record.cutMessageId) }))
    .filter((item) => item.startIndex >= 0 && item.cutIndex > item.startIndex)
    .sort((a, b) => a.startIndex - b.startIndex);
  let covered = blocks.length > 0 ? blocks[0]!.cutIndex : 0;
  for (const item of modern) {
    if (item.startIndex !== covered) break;
    blocks.push({ record: item.record, startIndex: item.startIndex, cutIndex: item.cutIndex, tier: compactionTierOf(item.record) });
    covered = item.cutIndex;
  }
  return blocks;
}

/** 有效压缩切点判定(兼容入口):pi 原生重放、用量估算、自动压缩触发都只要一个
 *  "切点 + 一份摘要"的扁平视图,本函数把块列表折成那个视图。
 *
 *  单块 → 原记录对象本身(身份与字段逐字节不变,v1 会话行为完全一致)。
 *  多块 → 合成视图:cut = 最后一块的 cut,summary = 各块摘要按序拼接(信息等价于
 *  聊天侧的并列摘要行,只是承载方式不同),tokensBefore = 各块之和。
 *  无生效块 → null(陈旧记录/消息被删时退回全量原文,绝不丢历史)。 */
export function findEffectiveCompaction(
  compactions: EngineCompactionRecord[],
  history: Message[],
  isUsable: (message: Message) => boolean,
): EngineCompactionRecord | null {
  const blocks = resolveCompactionBlocks(compactions, history, isUsable);
  if (blocks.length === 0) return null;
  if (blocks.length === 1) return blocks[0]!.record;
  const last = blocks[blocks.length - 1]!.record;
  const flattened: EngineCompactionRecord = {
    cutMessageId: last.cutMessageId,
    summary: blocks.map((block) => block.record.summary.trim()).filter(Boolean).join("\n\n"),
    tokensBefore: blocks.reduce((sum, block) => sum + block.record.tokensBefore, 0),
  };
  if (last.createdAt) flattened.createdAt = last.createdAt;
  return flattened;
}

// ── 自动压缩阈值(聊天引擎与前端提示共用口径) ──────────────────────────

/** 无窗口信息时的保留量兜底常量(S3 前的唯一口径)。窗口已知时一律走 reserveTokensFor:
 *  写死 16384 与模型能吐多少字毫无关系——8k 窗口因此**完全没有自动压缩**,32k 窗口在
 *  50% 就压(过激),1M 窗口到 98.4% 才压(预留吸收不了估算误差)。前端的"上下文即将用完"
 *  提示(web-ui/app/lib/compaction.ts)优先用服务端下发的预留,两处必须同步改。 */
export const COMPACTION_RESERVE_TOKENS = 16384;

/** 预留下限:再小的窗口也得给回答留出一段可用空间(低于此值的回答没有意义)。 */
export const COMPACTION_RESERVE_MIN = 2048;
/** 预留占窗口的比例上限(输出上限未知时按此取,已知时取 min(输出上限, 此比例))。 */
export const COMPACTION_RESERVE_RATIO = 0.25;
/** 预留的硬上限比例:极小窗口下 2048 的下限也不能吃掉半个窗口以上,否则阈值恒失效。 */
export const COMPACTION_RESERVE_MAX_RATIO = 0.5;

/** 本轮要给回答留出的 token(S3,参照 billion-context `effective = native − min(maxOutput,
 *  0.25×native)`)。输出上限未知 → 按窗口的 1/4 估;下限 2048 保证小窗口也有可用回答区,
 *  上限 0.5×窗口保证阈值恒为正(小窗口模型从此**有**自动压缩,而不是像旧口径那样直接 null)。 */
export function reserveTokensFor(contextWindow: number, outputLimit?: number | null): number {
  const byRatio = contextWindow * COMPACTION_RESERVE_RATIO;
  const desired = typeof outputLimit === "number" && Number.isFinite(outputLimit) && outputLimit > 0
    ? Math.min(outputLimit, byRatio)
    : byRatio;
  const floored = Math.max(COMPACTION_RESERVE_MIN, Math.round(desired));
  return Math.min(Math.floor(contextWindow * COMPACTION_RESERVE_MAX_RATIO), floored);
}

/** 自动压缩阈值 = 窗口 − 本轮预留。窗口非法/阈值非正时返回 null——不知道窗口就不猜
 *  (与前端提示同判定)。outputLimit 缺省时按窗口比例估,见 reserveTokensFor。 */
export function compactionThresholdFor(
  contextWindow: number | null | undefined,
  outputLimit?: number | null,
): number | null {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  const threshold = contextWindow - reserveTokensFor(contextWindow, outputLimit);
  return threshold > 0 ? threshold : null;
}

/** 严格大于(与 pi shouldCompact 同口径):恰好等于阈值时仍有一整个保留区可用。 */
export function shouldAutoCompact(
  usedTokens: number,
  contextWindow: number | null | undefined,
  outputLimit?: number | null,
): boolean {
  const threshold = compactionThresholdFor(contextWindow, outputLimit);
  return threshold !== null && usedTokens > threshold;
}

// ── 钉住消息(压缩时不被摘要吞掉) ─────────────────────────────────────

/** 消息是否被用户钉住。pinned 是 PC-only 注解(导出安卓时过滤),标注意义集中在
 *  这里,避免压缩输入、摘要注入、前端各自字符串比较。 */
/** 只认 pinned 注解。参数按运行时实际宽容度声明:老消息行可能没有 annotations 列,
 *  解析层也可能给出 null——两者都应视为"未钉住"而不是崩。 */
export function isPinnedMessage(msg: { annotations?: JsonValue[] | null }): boolean {
  return Array.isArray(msg.annotations)
    && msg.annotations.some((annotation) => isRecord(annotation) && annotation.type === "pinned");
}

/** 切点之前被钉住的消息:这些原文已被摘要取代,但用户要求逐字保留。
 *  切点及之后的消息本来就在模型视野里,不重复注入。 */
export function pinnedMessagesBefore(history: Message[], cutMessageId: string): Message[] {
  const cutIndex = history.findIndex((msg) => msg.id === cutMessageId);
  if (cutIndex <= 0) return [];
  return pinnedMessagesInRange(history, 0, cutIndex);
}

/** S5:某个块区间 [startIndex, cutIndex) 内被钉住的消息。块化后钉住集按块归属——
 *  每块的摘要行只附**本块**吞掉的钉住消息,而不是把全部钉住消息堆在最后一块后面
 *  (那会让早期摘要行随新压缩不断变长,前缀缓存又失效了)。 */
export function pinnedMessagesInRange(history: Message[], startIndex: number, cutIndex: number): Message[] {
  if (cutIndex <= startIndex) return [];
  return history.slice(Math.max(0, startIndex), cutIndex).filter(isPinnedMessage);
}

/** 链式摘要合并:上一版摘要 + 本次新增段的摘要。
 *  正常情况下直接拼接;但摘要模型可能复述上一版(尤其本地小模型/固定 mock),
 *  此时再拼一遍只会让记录里出现重复段落,并把上下文预算耗在复读上。三种退化都收敛:
 *  - 本次摘要已包含上一版 → 用本次(它信息更全,且已覆盖旧内容);
 *  - 上一版已包含本次 → 保留上一版(本次没有新增信息);
 *  - 完全相同 → 只留一份。
 *  只做字符串包含判断,不改写摘要内容;真正的二次浓缩仍由预算闸门负责。 */
export function mergeCompactionSummary(previousSummary: string, freshSummary: string): string {
  const previous = previousSummary.trim();
  const fresh = freshSummary.trim();
  if (!previous) return fresh;
  if (!fresh) return previous;
  if (previous === fresh) return previous;
  // 包含判断只在被包含的一侧足够长时生效:摘要里出现"好""同意"这类短句时,
  // 用 includes 去重会把不同的新内容误判成复述。
  const MIN_CONTAINMENT = 16;
  if (previous.length >= MIN_CONTAINMENT && fresh.includes(previous)) return fresh;
  if (fresh.length >= MIN_CONTAINMENT && previous.includes(fresh)) return previous;
  return `${previous}\n\n${fresh}`;
}

// ── S6 分层再蒸馏 ────────────────────────────────────────────────────
//
// v1 的体量控制是"链式摘要超预算 → 把整份链式摘要再浓缩一遍"。两个结构性缺陷:
// ① 每压一次都要把**全部历史摘要**重读重写一遍,成本随会话长度线性增长,而压缩本该
//    只花在新增段上;② 第 k 次浓缩的输入是第 k−1 次的输出,信息按 ρ^k 几何衰减,
//    早期事实在几轮之后就被磨成噪声。
//
// S6 改成"块蒸馏":原文一生只在 tier-1 折一次;体量超标时把**最旧的若干块摘要**
// 合成一个上层块(tier+1),被吸收的块置 active=false 但记录与原文都保留。上层块的
// 输入永远是下层块摘要,不是自己上一代的输出——衰减只发生在层数上(上限 3 层),
// 不随压缩次数累积。血统(consumedRecordIds)让任意一块都能逐层回溯到原文。

/** 一次蒸馏计划(纯判定,不调模型)。consumed 按锚点顺序,首尾相接。 */
export interface CompactionDistillationPlan {
  consumed: CompactionBlock[];
  /** 上层块层级 = min(被吸收块层级) + 1,夹到 COMPACTION_TIER_MAX。 */
  tier: number;
  /** 上层块覆盖的原文区间(纯下标)。调用方据此取 startMessageId——被吸收的首块
   *  可能是 v1 形态(无 startMessageId,起点恒 0),不能直接抄它的字段。 */
  startIndex: number;
  cutIndex: number;
  cutMessageId: string;
  /** 展示口径:被吸收块覆盖的原文 token 之和。 */
  tokensBefore: number;
  /** 蒸馏输入 = 被吸收块的摘要按序拼接(绝不掺原文,也不掺自己上一代输出)。 */
  inputSummary: string;
  inputTokens: number;
}

/** 规划一次分层蒸馏:活跃块摘要总量超预算时,从最旧的可蒸馏块起贪心吸收,直到
 *  吸收量达到预算(这样上层块才有"把 N 份压成 1 份"的收益)。返回 null 表示不该蒸馏:
 *  - 总量没超预算;
 *  - 可蒸馏块(tier < 上限)不足 2 个——把 1 块换成 1 块只是白烧一轮模型;
 *  - 全部块都已到层级上限(此时体量交给应急截断/预算头切,不再无限往上折)。
 *  budgetTokens 由调用方给(与 compactionSummaryBudget 同值),本模块不反向依赖会话层。 */
export function planCompactionDistillation(
  blocks: CompactionBlock[],
  budgetTokens: number,
): CompactionDistillationPlan | null {
  if (blocks.length < 2) return null;
  const tokensOf = (block: CompactionBlock) => estimateTokens(block.record.summary);
  const total = blocks.reduce((sum, block) => sum + tokensOf(block), 0);
  if (!(total > budgetTokens)) return null;

  const consumed: CompactionBlock[] = [];
  let absorbed = 0;
  for (const block of blocks) {
    if (block.tier >= COMPACTION_TIER_MAX) break;
    consumed.push(block);
    absorbed += tokensOf(block);
    // 两个条件都要满足才停:吸收量够预算(上层块才有收益),且至少两块
    // (单块超预算时"1 块换 1 块"只是白烧一轮模型,见下方 consumed.length 判定)。
    if (absorbed >= budgetTokens && consumed.length >= 2) break;
  }
  if (consumed.length < 2) return null;

  const first = consumed[0]!;
  const last = consumed[consumed.length - 1]!;
  const inputSummary = consumed.map((block) => block.record.summary.trim()).filter(Boolean).join("\n\n");
  return {
    consumed,
    tier: Math.min(COMPACTION_TIER_MAX, Math.min(...consumed.map((block) => block.tier)) + 1),
    startIndex: first.startIndex,
    cutIndex: last.cutIndex,
    cutMessageId: last.record.cutMessageId,
    tokensBefore: consumed.reduce((sum, block) => sum + block.record.tokensBefore, 0),
    inputSummary,
    inputTokens: estimateTokens(inputSummary),
  };
}
