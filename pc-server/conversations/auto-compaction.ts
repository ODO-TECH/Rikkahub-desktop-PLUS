// conversations/auto-compaction.ts — 聊天引擎生成前的自动压缩预检(阶段三)
//
// 触发口径与 pi 的 shouldCompact 对齐:估算上下文 > contextWindow − reserveTokens。
// 判定只决定"压不压",压缩本身完全复用 compressConversation(记录、切点注解、链式
// 摘要、二次浓缩、审计闸门全同手动路径)——自动与手动不允许产生两种数据形态。
//
// 估算优先级:
//   ① 切点之后最后一条带真实 usage 的助手消息:promptTokens + completionTokens 包含
//      system/工具/摘要,是最接近上游视野的数(与前端提示条同口径)。该 usage 必须
//      晚于当前生效压缩记录,否则它反映的是压缩前的窗口(刚压完会误触发第二次)。
//   ② 无可用 usage(首轮/压缩后的第一轮/记录缺 createdAt):把模型真实要吃的富化产物
//      完整编码一遍再数 token——含 system、摘要、注入与工具往返,再加上工具声明 JSON
//      (它不在消息序列里,数消息数不到;挂满 MCP 时可达上万 token)。这一步会先做记忆
//      召回(prepareMemoryRecall),与正式生成同一时机,避免冻结出未召回的旧上下文档。
//
// 失败策略:best-effort。压缩模型调用失败时记一条 warn 级错误后继续生成——自动维护
// 不该把用户刚发的消息顶掉;上下文仍超限时上游自会报错,而手动压缩入口一直在。
// 唯一硬语义是取消:signal 中止(用户停止/新消息接管)时立即放弃,不落任何记录。

import type { Assistant, Conversation, Message, Model, Provider } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import { broadcastEngineStatus, broadcastList } from "../api/sse";
import { contextWindowFor, outputLimitFor } from "../model-providers/model-limits";
import { modelsDevCache } from "../inference-engine/providers";
import {
  findEffectiveCompaction,
  isPinnedMessage,
  parseEngineCompactions,
  shouldAutoCompact,
} from "../inference-engine/engine-compaction";
import { isEmptyAssistantPlaceholder } from "../inference-engine/parts";
import { conversationTransformedMessages, contextCalibrationFactor, toolDeclarationTokens } from "../inference-engine/conversation-encoding";
import { calibrationFactorFor } from "../inference-engine/token-calibration";
import { prepareMemoryRecall } from "../memory/recall";
import { prepareDynamicRecall } from "../memory/dynamic-recall";
import { reportError } from "../observability/app-errors";
import { state } from "../persistence/json-store";
import { selectedConversationMessages } from "./index";
import { compressing } from "./generation-state";
import { isRuntimeEpochCurrent, runtimeEpoch } from "./runtime-epoch";
import { contextTokensOf } from "../inference-engine/context-budget";
import { compressConversation } from "./auxiliary";
import { scheduleCompactionCandidates } from "../memory/experiment/compaction-candidates";

/** 自动压缩保留的最近消息比例:压掉约 3/4,避免"压完仍超阈值"每轮重复消费压缩模型。
 *  条数上限沿用手动压缩默认 32,下限 4(至少留一轮完整往返)。 */
const AUTO_COMPACT_KEEP_RATIO = 0.25;
const AUTO_COMPACT_KEEP_MAX = 32;
const AUTO_COMPACT_KEEP_MIN = 4;
const AUTO_COMPACT_TARGET_TOKENS = 2000;

/** 单条消息在模型视野里的近似 token(正文 + 工具输入/输出)。估算单源在
 *  inference-engine/context-budget.ts,自动压缩与预算窗口共用同一口径。 */
function messageContextTokens(msg: Message): number {
  return contextTokensOf(msg);
}

/** 切点之后的可见消息(与编码层同一切点判定;切点失效时退回全量)。 */
function visibleMessages(conversation: Conversation): { messages: Message[]; compaction: ReturnType<typeof findEffectiveCompaction> } {
  const messages = selectedConversationMessages(conversation);
  const compaction = findEffectiveCompaction(
    parseEngineCompactions(conversation.engineCompactions),
    messages,
    () => true,
  );
  const cutIndex = compaction ? messages.findIndex((msg) => msg.id === compaction.cutMessageId) : -1;
  return { messages: cutIndex > 0 ? messages.slice(cutIndex) : messages, compaction };
}

/** 当前生效压缩记录是否晚于这条消息(是 → 它的 usage 反映压缩前窗口,不可用)。 */
function usageOlderThanCompaction(
  compaction: ReturnType<typeof findEffectiveCompaction>,
  msg: Message,
): boolean {
  if (!compaction) return false;
  const compactedAt = Date.parse(String(compaction.createdAt ?? ""));
  // 记录没有时间(如 pi 早期记录):无法证明 usage 新鲜,保守视为旧。
  if (!Number.isFinite(compactedAt)) return true;
  const messageAt = Date.parse(String(msg.createdAt ?? ""));
  if (!Number.isFinite(messageAt)) return true;
  return messageAt <= compactedAt;
}

/** 自动压缩判定用的上下文估算(≈ 下一次请求的 prompt token)。 */
export async function estimateAutoCompactContext(
  conversation: Conversation,
  assistant: Assistant,
): Promise<number> {
  const { messages: visible, compaction } = visibleMessages(conversation);
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const msg = visible[index]!;
    if (msg.role !== "ASSISTANT" || isEmptyAssistantPlaceholder(msg)) continue;
    const usage = isRecord(msg.usage) ? msg.usage : null;
    const promptTokens = Number(usage?.promptTokens ?? 0);
    if (!Number.isFinite(promptTokens) || promptTokens <= 0) continue;
    if (usageOlderThanCompaction(compaction, msg)) continue;
    const completionTokens = Number(usage?.completionTokens ?? 0);
    // usage 是上游真实数,不乘校准;只有"这条之后新追加的消息"是本地估算,需要乘 k̂。
    const factor = contextCalibrationFactor(assistant);
    let trailing = 0;
    for (let i = index + 1; i < visible.length; i += 1) trailing += messageContextTokens(visible[i]!);
    return promptTokens + (Number.isFinite(completionTokens) ? completionTokens : 0) + Math.round(trailing * factor);
  }
  // 无可用 usage:按模型真实视野完整估算。召回先就位,避免冻结未召回的上下文块;
  // S9 易变块同一次请求就会带上,估算必须把它算进去,否则压完仍可能超阈值。
  await prepareMemoryRecall(conversation, assistant);
  await prepareDynamicRecall(conversation, assistant);
  const { messages: encoded, picked } = conversationTransformedMessages(conversation, assistant, { dynamicRecall: true });
  // 工具声明不在消息序列里,必须单独加(usage 优先分支的 promptTokens 已含它)。
  // 整段都是本地估算 → 乘 k̂(S2 用量自校准;无样本时为 1,与引入前一致)。
  const local = encoded.reduce((sum, msg) => sum + messageContextTokens(msg), 0)
    + toolDeclarationTokens(assistant, picked.model, conversation.id);
  // provider 可能为空(findModel 在零供应商配置时回退 Auto):无键即无样本,k̂=1。
  return Math.round(local * calibrationFactorFor(picked.provider?.id ?? "", picked.model.modelId));
}

function keepRecentFor(compressibleCount: number): number {
  const byRatio = Math.ceil(compressibleCount * AUTO_COMPACT_KEEP_RATIO);
  return Math.min(AUTO_COMPACT_KEEP_MAX, Math.max(AUTO_COMPACT_KEEP_MIN, byRatio));
}

/** 生成前预检:启用 + 未知窗口/窗口过小 + 未在压缩 + 有可压缩段 + 超过阈值 → 压一次。
 *  返回 true 表示本次生成前实际执行了压缩。 */
export async function maybeAutoCompactChat(input: {
  conversation: Conversation;
  assistant: Assistant;
  provider: Provider;
  model: Model;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { conversation, assistant, provider, model, signal } = input;
  // 代际守卫:本预检挂在生成入口,生成期间可能发生备份导入——旧实例的压缩结果与
  // compressing 记账都不得影响导入后的新运行态(见 finalizeConversationImport)。
  const epoch = runtimeEpoch();
  if (state.settings.chatAutoCompact !== true) return false;
  if (compressing.has(conversation.id)) return false;
  const contextWindow = contextWindowFor(modelsDevCache, provider, model.modelId);
  // 同步先做一次便宜的规模判断之外,窗口本身未知时直接放弃——不知道阈值就不猜。
  if (contextWindow == null) return false;

  const contextTokens = await estimateAutoCompactContext(conversation, assistant);
  if (signal?.aborted) return false;
  if (!isRuntimeEpochCurrent(epoch)) return false;
  // S3:预留跟着模型真实输出上限走(未知则按窗口 1/4),不再写死 16384——小窗口模型
  // 从此有自动压缩,大窗口模型的预留也够吸收估算误差。
  if (!shouldAutoCompact(contextTokens, contextWindow, outputLimitFor(modelsDevCache, provider, model.modelId))) return false;

  // 可压缩段:上一次切点之后。少于两条说明没有可摘的原文(压缩会拒绝),静默跳过。
  const allMessages = selectedConversationMessages(conversation);
  const previous = findEffectiveCompaction(
    parseEngineCompactions(conversation.engineCompactions),
    allMessages,
    () => true,
  );
  const previousIndex = previous ? allMessages.findIndex((msg) => msg.id === previous.cutMessageId) : 0;
  const compressible = allMessages.slice(Math.max(0, previousIndex));
  if (compressible.length < 2) return false;
  if (compressing.has(conversation.id)) return false;
  // 阶段四:钉住的消息不进摘要。若切点前的段落全被钉住,压缩会因"无可摘要内容"
  // 失败——自动路径不该每轮弹一条失败警告,静默跳过(上游超限时仍会自己报错)。
  let keepRecent = keepRecentFor(compressible.length);
  if (keepRecent >= compressible.length) keepRecent = Math.max(1, Math.floor(compressible.length / 2));
  const pinnedFreeBeforeCut = compressible
    .slice(0, compressible.length - keepRecent)
    .filter((msg) => !isPinnedMessage(msg));
  if (pinnedFreeBeforeCut.length === 0) return false;

  const startedAt = Date.now();
  compressing.set(conversation.id, startedAt);
  broadcastEngineStatus(conversation.id, {
    busy: true,
    phase: "compacting",
    reason: "threshold",
    startedAt,
  });
  broadcastList();
  try {
    await compressConversation(
      conversation,
      "",
      AUTO_COMPACT_TARGET_TOKENS,
      keepRecent,
      signal,
      { autoReason: "threshold" },
    );
    // 实验：压缩后置候选（默认关；内部自行门控，best-effort 不阻塞生成）。
    scheduleCompactionCandidates(conversation);
    return true;
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw error instanceof DOMException ? error : new DOMException("Compression cancelled", "AbortError");
    }
    // 导入替换导致的作废不是压缩故障:静默放弃,由生成入口的代际检查收尾。
    if (!isRuntimeEpochCurrent(epoch)) return false;
    reportError(
      "provider",
      "warn",
      `自动压缩上下文失败,本轮按原上下文继续生成:${error instanceof Error ? error.message : String(error)}`,
      error,
      "auto_compact_failed",
    );
    return false;
  } finally {
    if (isRuntimeEpochCurrent(epoch)) {
      compressing.delete(conversation.id);
      broadcastEngineStatus(conversation.id, { busy: false });
      broadcastList();
    }
  }
}

/** 按「本轮实际要编码的富化产物」估算 token(含 system/摘要/注入,预算窗口已生效)。
 *  与 usage 优先口径分开:导入会话里存的是来源 APP 的旧 usage,不能当作本轮请求体积。 */
export async function estimateEncodedContext(conversation: Conversation, assistant: Assistant): Promise<number> {
  await prepareMemoryRecall(conversation, assistant);
  await prepareDynamicRecall(conversation, assistant);
  const { messages: encoded, picked } = conversationTransformedMessages(conversation, assistant, { dynamicRecall: true });
  const local = encoded.reduce((sum, msg) => sum + messageContextTokens(msg), 0)
    + toolDeclarationTokens(assistant, picked.model, conversation.id);
  return Math.round(local * calibrationFactorFor(picked.provider?.id ?? "", picked.model.modelId));
}

/** 硬闸判定(纯函数,供测试):未超原生窗口返回 null,超了返回可操作错误文案。
 *  S4:判定口径是**原生窗口**,不是 window − reserve。预留是给输出留的头,由
 *  reserveTokensFor/planOutputCap 在请求参数层面执行;硬闸只回答"这个请求上游会不会
 *  直接拒"。拿预留当硬线会把估算偏大、本可成功的请求误杀(估算误差可达 ±20%)。 */
export function contextFitError(usedTokens: number, contextWindow: number | null): string | null {
  if (contextWindow == null) return null; // 窗口未知不猜
  if (usedTokens <= contextWindow) return null;
  return `上下文约 ${Math.round(usedTokens / 1000)}K tokens,已超过模型窗口上限(${Math.round(contextWindow / 1000)}K):` +
    `请对本次会话做一次手动压缩,或换用更大窗口的模型后再发送。`;
}

/** 发送前硬闸(**常开**,S4)。在任何网络调用之前判定:估算上下文 > 模型原生窗口 →
 *  直接拒绝本次生成,不发出请求。这是「防 400」的最后一道,不是压缩的替代:
 *  - 常开:出厂设置(预算关、自动压缩关)下也必须生效,否则等于没有任何护栏;
 *  - 窗口未知时不猜(与 maybeAutoCompactChat 同口径);
 *  - 判定放在应急截断之后(enrichMessages 已截过一轮),截完仍超才报错。 */
export async function assertContextFits(input: {
  conversation: Conversation;
  assistant: Assistant;
  provider: Provider;
  model: Model;
}): Promise<void> {
  const contextWindow = contextWindowFor(modelsDevCache, input.provider, input.model.modelId);
  if (contextWindow == null) return;
  // 必须按本轮编码产物估:导入会话的 usage 来自来源 APP(全量注入时代),用它会把
  // 已经过预算裁剪的请求误判为超限,形成「开了预算仍发不出去」的死锁。
  const contextTokens = await estimateEncodedContext(input.conversation, input.assistant);
  const message = contextFitError(contextTokens, contextWindow);
  if (message) throw new Error(message);
}
