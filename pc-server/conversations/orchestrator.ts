import { runKernelGeneration } from "../kernel-engine/driver";
// conversations/orchestrator.ts — 会话生成编排（Provider 分发、流式工具循环挂接、生成主链路与收尾任务）
// 纪律：纯搬迁自 server.ts（阶段 5.3g），行为不变。推理引擎经 GenerationEvent sink 与本层解耦。

import type { ApiMessage, Assistant, Conversation, JsonValue, Message, MessageNode, Model, Provider, ToolPendingOutput } from "../foundation/types";
import { bumpAnalyticsErrCount } from "../app-config/analytics";
import type { GenerationEventSink, GenerationTarget, LoopToolObservation, StreamHooksWithSink, ToolExecutor } from "../inference-engine/events";
import { effectiveMaxTokens, effectiveTopP } from "../inference-engine/sampling";
import { id, isRecord, message, textFromParts } from "../foundation/utils";
import { classifyProxyError } from "../foundation/net";
import { classifyContextOverflowError, classifyOAuthCredentialError, classifyOutputCapError, classifyRateLimitError } from "../inference-engine/provider-errors";
import { state } from "../persistence/json-store";
import { prepareMemoryRecall } from "../memory/recall";
import { prepareDynamicRecall, } from "../memory/dynamic-recall";
import { prepareMoodInjection, } from "../mood/injection";
import { scheduleMemoryOrganize } from "../memory/organize";
import { scheduleMentionScoring } from "../memory/experiment/mentions";
import { scheduleMoodJudgeForTurn } from "../mood/judge";
import { addLog } from "../api/logs";
import { broadcastConversation, broadcastEngineStatus, broadcastList, broadcastNodeUpdate, touchStream } from "../api/sse";
import { applyCustomBody, applyRequestHeaders, findModel } from "../model-providers";
import { resolveProviderAuthForProvider, applyShaping } from "../model-providers/auth";
import { endpointFor } from "../model-providers/checks";
import { openAiMaxTokensField, reasoningLevelNormalized } from "../model-providers/request-dialect";
import {
  claudeCacheControlEphemeral,
  claudeMessagesFromApiMessages,
  claudeSystemContent,
  claudeThinkingPayload,
  claudeToolsFromOpenAiTools,
  chatCompletionsWireMessages,
  hostOfProvider,
  isModelAllowTemperature,
  openAiChatCompletionsModalities,
  reasoningPayloadForProvider,
  responseApiBuiltInTools,
  responseApiFunctionTool,
  responseApiIncludeForProvider,
  responseApiReasoningForProvider,
  supportsAbility,
} from "../inference-engine/message-builder";
import {
  buildGoogleRequestBody,
  conversationAssistantHistoryParts,
  conversationMessagesForApi,
  conversationResponseApiInput,
  conversationResponseApiInstructions,
  googleToolsFromFunctionTools,
  toolDeclarationTokens,
} from "../inference-engine/conversation-encoding";
import { apiMessagesTokens } from "../inference-engine/api-tokens";
import { noteOutboundEstimate, calibrationFactorFor } from "../inference-engine/token-calibration";
import {
  fetchClaudeTextWithTools,
  fetchOpenAiText,
  fetchText,
  modelsDevCache,
  streamClaudeChatWithTools,
  streamGoogleChatWithTools,
} from "../inference-engine/providers";
import { buildInteractionsRequestBody, interactionsToolsFromFunctionTools, streamInteractionsChatWithTools } from "../inference-engine/interactions";
import { planOutputCap, requiredOutputCap } from "../model-providers/model-limits";
import {
  finishReasoningParts,
  finishToolParts,
  isEmptyAssistantPlaceholder,
  setMessageLoading,
  streamStartedMessages,
  stripLoadingPlaceholder,
} from "../inference-engine/parts";
import { createGenerationEventApplier } from "./generation-apply";
import { apiToolCallFromPart, toolExecutionErrorPayload, toolResultTextForApi } from "../tools/format";
import { conversationFunctionTools } from "../tools/bound";
import { conversationToolsWithDiscovery, isToolDiscoveryEnabled, } from "../tools/discovery-store";
import { applyToolDiscovery, discoverableToolPool, isMcpFunctionTool, type FunctionToolDeclaration } from "../tools/discovery";
import { promotePendingToolActivation, pruneToolActivation, readToolActivation } from "./tool-activation";
import { executeToolCall, realizeToolResult, toolResultToParts } from "../tools/execution";
import { findPlanContext, latestPlan, runResumeTarget, scheduleTarget } from "../tools/plan-context";
import { PLAN_TOOL_NAME } from "../tools/plan";
import type { ToolBoundaryObserver } from "../foundation/tool-boundary";
import {
  
  resolveEngine,
  type EngineAdapter,
  type EngineKind,
  type EngineRunContext,
} from "../engines";
import { applyOutputTransforms } from "../assistants";
import { TITLE_CHARACTER_LIMIT } from "../app-config/prompts";
import { flushConvDirtyNow, getConversation, getConversationsDb, markMessageNodeDirty, persistConversation, scheduleThrottledConvFlush, } from "./index";
import { checkoutConversation, releaseConversation } from "./working-set";
import { conversationExistsInDb } from "./read-queries";
import { reportError } from "../observability/app-errors";
import { abortGeneration, abortReasonOf, awaitingApproval, compressing, generating } from "./generation-state";
import { isRuntimeEpochCurrent, runtimeEpoch } from "./runtime-epoch";
import { cancelWaitingQueuedMessages, deliverQueuedReply, holdMessageQueue, isQueueHeldByInterrupt, isQueuePaused, notifyQueuedGenerationDispatched, pauseMessageQueue, queueSnapshotFor, removeQueuedMessage, setOnQueuedGenerationDispatched, shiftNextQueued } from "./message-queue";
import { clearSteeringChannel, drainSteeringMessages } from "./steering-channel";
import {
  appendTextPart,
  canResumeToolExecution,
  ensureUsage,
  findAssistant,
  finishMessage,
  hasPendingToolApproval,
  hasResumableToolParts,
  toolApprovalType,
} from "./helpers";
import { generateSuggestionsForConversation, generateTitleForConversation, limitAuxiliaryText, modelExists, resolvePostGenerationModelIds, shouldAutoGenerateTitle } from "./auxiliary";
import { assertContextFits, maybeAutoCompactChat } from "./auto-compaction";
import { beginAgentRun, createRunBoundaryObserver, type AgentRunTracker } from "../agent-loop/run-tracker";
import { markScheduleRun } from "../agent-loop/schedule-store";
import { AgentLoopController } from "../agent-loop/controller";
import { AgentLoopHaltError, runStatusForHalt } from "../agent-loop/halt";

/** 生成入口一次性解析的配置快照（P1-4）。流式生成横跨多个 await 点，用户中途改配置
 *  （换模型/改工具集/删助手）时，updateSettings 会整体替换 state.settings——持有入口
 *  时刻的引用即天然快照（旧对象不会被原地修改），保证同一次生成读到同一代配置。 */
export interface GenerationSnapshot {
  assistant: Assistant;
  provider: Provider;
  model: Model;
}

/** 生成会话句柄（steer 边界节点分裂的统一管理核心，对齐 Codex transcript 逐项累积）。
 *  generateAnswer 装配时创建一次、随本次生成存活。初始落点 = ai_1（ensureAssistantGenerationNode
 *  给出的 assistant 节点）；steer 边界由 steerBoundary 调 retarget 把后续流式换绑进新开的
 *  continuation 节点 ai_2——从而延续输出在数据层落在 steer user 之后（②模型层重答污染的治本）。
 *  引擎/adapter/tool-loop 只见它的只读面 GenerationTarget（活视图，每次现读），落点统一由
 *  session 管；未来新引擎把 onSteerBoundary 指向同一 steerBoundary 即自动继承分裂能力。 */
export interface GenerationSession extends GenerationTarget {
  retarget(next: { node: MessageNode; message: Message }): void;
}

function createGenerationSession(conversationId: string, initial: { node: MessageNode; message: Message }): GenerationSession {
  let node = initial.node;
  let message = initial.message;
  activeGenerationMessages.set(conversationId, message);
  return {
    get node() {
      return node;
    },
    get message() {
      return message;
    },
    retarget(next) {
      node = next.node;
      message = next.message;
      // 所有权记录随落点走:finalizeOutcome 的接管守卫按「新流是否复用同一消息对象」
      // 判定,换绑后不更新会让守卫拿旧 ai_1 比对新流的 ai_2,永远判不中。
      activeGenerationMessages.set(conversationId, message);
    },
  };
}

/** S9:按 provider 形状把 OpenAI 函数工具数组映射成出线 tools。首轮装配与轮边界
 *  刷新共用本函数——两边必须逐字同源,否则刷新前的"未变化"对拍会误判。 */
function discoveryToolsForProvider(
  providerItem: Provider,
  modelItem: Model,
  tools: FunctionToolDeclaration[],
  body: Record<string, unknown>,
): unknown[] {
  if (providerItem.type === "claude") {
    return claudeToolsFromOpenAiTools(tools as any, providerItem) as unknown[];
  }
  if (providerItem.type === "google") {
    // Interactions 请求体有 input;generateContent 有 contents。两条路 tools 形状不同。
    if (Array.isArray(body.contents)) return googleToolsFromFunctionTools(tools, modelItem) ?? [];
    return interactionsToolsFromFunctionTools(tools, modelItem);
  }
  // OpenAI Responses 形态(input 数组)叠加服务端内置工具;chat 形态只有函数工具。
  if (Array.isArray(body.input) && !Array.isArray(body.messages)) {
    return [...tools.map(responseApiFunctionTool), ...responseApiBuiltInTools(modelItem)].filter(Boolean) as unknown[];
  }
  return tools;
}

/** S9 轮边界刷新:有 pending 且当前 body.tools 与"刷新前应得形状"逐字相等时,提升
 *  激活集并把新工具的 schema 写进下一轮。任何一项不满足 → 返回 undefined(请求体
 *  逐字不变,包含用户 customBodies 覆盖 tools 的情形——不擅自 stomp 用户定制)。
 *  export 仅供 S9 轮边界回归直接驱动(生产唯一调用点在 callProvider 内)。 */
export function refreshBodyToolsForDiscovery(
  providerItem: Provider,
  modelItem: Model,
  assistant: Assistant,
  conversationId: string,
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!isToolDiscoveryEnabled(assistant) || !supportsAbility(modelItem, "TOOL")) return undefined;
  let before = readToolActivation(conversationId);
  if (before.pending.length === 0) return undefined;
  const base = conversationFunctionTools(assistant, modelItem) as unknown as FunctionToolDeclaration[];
  if (!base.some(isMcpFunctionTool)) return undefined;
  // S11:先按实时池清理失效的 active/pending(服务器禁用/删除、工具或覆盖关闭),
  // 再以清理后的激活集做"请求体是否原样"的比对与提升。只剩失效待激活时本轮无需刷新。
  const removed = pruneToolActivation(conversationId, new Set(discoverableToolPool(base).map((tool) => tool.name)));
  if (removed.length > 0) {
    before = readToolActivation(conversationId);
    if (before.pending.length === 0) return undefined;
  }
  const beforeMapped = discoveryToolsForProvider(
    providerItem,
    modelItem,
    applyToolDiscovery(base, new Set(before.active)),
    body,
  );
  if (JSON.stringify(beforeMapped) !== JSON.stringify(body.tools ?? null)) return undefined;
  const promoted = promotePendingToolActivation(conversationId);
  if (promoted.length === 0) return undefined;
  const after = applyToolDiscovery(base, new Set(readToolActivation(conversationId).active));
  const mappedAfter = discoveryToolsForProvider(providerItem, modelItem, after, body);
  const next: Record<string, unknown> = { ...body };
  if (mappedAfter.length > 0) next.tools = mappedAfter;
  else delete next.tools;
  const responsesShape = Array.isArray(body.input) && !Array.isArray(body.messages);
  if (providerItem.type === "openai" && !responsesShape) {
    next.tool_choice = mappedAfter.length > 0 ? "auto" : undefined;
  }
  return next;
}

export async function callProvider(
  conversation: Conversation,
  signal?: AbortSignal,
  hooks?: StreamHooksWithSink,
  snapshot?: GenerationSnapshot,
) {
  const assistant = snapshot?.assistant ?? findAssistant(conversation.assistantId);
  // 0 = 未设置哨兵(Kelivo/安卓):top_p=0/max_tokens=0 原样出线会被上游当字面值执行,
  // SiliconFlow Qwen 实测得到 200 + 空回复(前端显示 "(empty response)")。
  const topP = effectiveTopP(assistant.topP);
  const maxTokens = effectiveMaxTokens(assistant.maxTokens);
  // 特性 C：会话首次编码前算一次召回（命中冻结缓存时立即返回）；关闭/失败时保持全量注入。
  await prepareMemoryRecall(conversation, assistant);
  // S9：易变召回块只服务真实会话生成；辅助调用（标题/翻译等无 hooks）保持原样。
  const useDynamicRecall = hooks?.message != null;
  if (useDynamicRecall) await prepareDynamicRecall(conversation, assistant);
  // M2：心情块与易变召回同槽，同样只服务真实生成；辅助调用不准备、不注入。
  if (useDynamicRecall) await prepareMoodInjection(conversation, assistant);
  const picked = snapshot
    ? { provider: snapshot.provider, model: snapshot.model }
    : findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const providerItem = picked.provider;
  // S9:直接走 callProvider 的调用方(不经 callProviderStreaming)同样获得轮边界刷新。
  if (hooks && !hooks.refreshTools && supportsAbility(picked.model, "TOOL")) {
    hooks.refreshTools = (next) =>
      refreshBodyToolsForDiscovery(providerItem, picked.model, assistant, conversation.id, next);
  }
  const selectedModel = picked.model.modelId === "auto" ? "gpt-4o-mini" : picked.model.modelId;
  // 订阅供应商:凭据在服务端 oauth 里,apiKey 恒空——先经 resolveProviderAuthForProvider
  // 解析(可能触发锁内刷新),后续注入点统一用 resolvedCredentialHeaders 而非裸 apiKey。
  const resolvedAuth = await resolveProviderAuthForProvider(providerItem, { signal });
  const credentialHeaders = resolvedAuth.headers;
  // 消息端点在凭据解析后拼:订阅供应商的 baseUrl 可能由凭证派生(Copilot 的 proxy-ep)。
  const url = endpointFor(providerItem, resolvedAuth.baseUrl);
  const headers = applyRequestHeaders({ "Content-Type": "application/json", ...credentialHeaders }, assistant, providerItem, picked.model, conversation.id);
  // 对齐 e63d017：OpenAI 路径才让 includeHistoryReasoning 生效；
  // claude/google 不走 OpenAI assistant 序列化，一律保持 true。
  const includeHistoryReasoning =
    providerItem.type === "openai" ? providerItem.includeHistoryReasoning !== false : true;
  const messagesForApi = conversationMessagesForApi(
    conversation,
    assistant,
    includeHistoryReasoning,
    useDynamicRecall,
    useDynamicRecall,
  );
  // 本轮出站的本地 prompt 估算(消息面 + 工具声明)。两个消费者共用同一份数:
  //   S2 用量自校准:登记**未校准**的本地值,上游回报真实 promptTokens 时由
  //     generation-apply 的 usage 分支配对成样本(乘了 k̂ 就变成自我印证的死循环)。
  //   S3 输出钳制:要的是"真实 token 的最佳估计",所以这里乘 k̂。
  // 只登记真实会话生成(有 hooks.message)——标题/翻译等辅助调用不该污染会话模型的校准环。
  const outboundLocalTokens =
    apiMessagesTokens(messagesForApi) + toolDeclarationTokens(assistant, picked.model, conversation.id);
  const promptEstimate = Math.round(
    outboundLocalTokens * calibrationFactorFor(providerItem.id, picked.model.modelId),
  );
  if (useDynamicRecall) {
    noteOutboundEstimate(conversation.id, providerItem.id, picked.model.modelId, outboundLocalTokens);
  }
  // S3:上限**可选**的协议(OpenAI completions/responses、Google)只在用户已配置时才发
  // 字段,此时按本轮剩余窗口钳一道;剩余空间不足 → 省略字段,让上游用自己的默认
  // (OpenAI 的默认就是"窗口剩多少给多少")。钳制事实由 planOutputCap 上错误中心留痕。
  const optionalOutputTokens = maxTokens == null
    ? null
    : planOutputCap(modelsDevCache, providerItem, picked.model.modelId, maxTokens, promptEstimate).tokens;
  // 动态头取值依据(仅 Copilot 的 X-Initiator/Copilot-Vision-Request 消费)。
  const shapingContext = {
    lastMessageRole: messagesForApi[messagesForApi.length - 1]?.role,
    hasImages: messagesForApi.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url" || p?.type === "input_image"),
    ),
  };
  let body: Record<string, any>;
  // 订阅供应商整形(§13.3 全路径覆盖,与辅助调用同一时机):body 定稿后、applyCustomBody 前。
  const shaped = (draft: Record<string, any>) => {
    if (providerItem.authMode === "oauth" && providerItem.oauth) {
      applyShaping(providerItem.oauth.flow, headers, draft, providerItem.oauth.credential, shapingContext);
    }
    return draft;
  };

  if (providerItem.type === "google") {
    // issue10：Gemini 鉴权走 x-goog-api-key 头（与安卓非 Vertex 路径、Cherry Studio 一致）。
    // 此前用 ?key= query，官方两者都收，但主流中转网关只解析 header，query 会被判 invalid key。
    // 订阅供应商:google 暂无 oauth 形态,apiKey 恒空时 credentialHeaders 已含解析头。
    if (providerItem.authMode !== "oauth") headers["x-goog-api-key"] = providerItem.apiKey;
    const baseUrl = providerItem.baseUrl;
    // Interactions API 开关(APP 2.5.6 2cd62ad2,GA 2026-06):google 型供应商级开关,
    // 默认关走 generateContent。历史 assistant 轮签名保真需要落库 parts(messagesForApi
    // 的 chat-completions 形态不带签名),经 conversationAssistantHistoryParts 取。
    if (providerItem.useInteractionsApi === true && hooks?.message != null) {
      const functionTools = supportsAbility(picked.model, "TOOL")
        ? conversationToolsWithDiscovery(assistant, picked.model, conversation.id)
        : [];
      body = buildInteractionsRequestBody(
        messagesForApi,
        conversationAssistantHistoryParts(conversation, assistant, messagesForApi),
        picked.model,
        assistant,
        functionTools,
      );
      return streamInteractionsChatWithTools(baseUrl, headers, selectedModel, applyCustomBody(shaped(body), assistant, picked.model), providerItem, assistant, signal, hooks);
    }
    body = buildGoogleRequestBody(messagesForApi, picked.model, assistant, conversation.id);
    const finalBody = applyCustomBody(shaped(body), assistant, picked.model);
    // 有 hooks（来自会话）时走 SSE 流式 + 工具循环；辅助调用无 hooks 时退回非流式。
    if (hooks?.message != null) {
      return streamGoogleChatWithTools(baseUrl, headers, selectedModel, finalBody, providerItem, assistant, signal, hooks);
    }
    const googleUrl = `${baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent`;
    return fetchText(googleUrl, headers, finalBody, providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? "").join("") ?? "", signal);
  }

  if (providerItem.type === "claude") {
    // 订阅供应商(Kimi/Claude):oauth 轨已在 credentialHeaders 注入 Authorization: Bearer;
    // apiKey 轨保持 x-api-key。互斥,不双发。
    if (providerItem.authMode !== "oauth") headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    const messages = messagesForApi;
    const systemContent = messages.find((item) => item.role === "system")?.content;
    const functionTools = supportsAbility(picked.model, "TOOL")
      ? conversationToolsWithDiscovery(assistant, picked.model, conversation.id)
      : [];
    const claudeTools = claudeToolsFromOpenAiTools(functionTools, providerItem);
    const normalizedReasoning = reasoningLevelNormalized(assistant.reasoningLevel);
    const reasoningActive = supportsAbility(picked.model, "REASONING") && normalizedReasoning !== "off";
    // Always stream when invoked from a conversation (hooks present). The streaming path handles
    // text + thinking + tool_use deltas live, matching Android (ClaudeProvider.streamText). The
    // non-streaming fallback only runs for auxiliary calls without hooks (title/translate, etc.).
    const canStream = hooks?.message != null;
    body = {
      model: selectedModel,
      // 上限四级(requiredOutputCap 单源,与工作区引擎同一函数):助手设置 > 目录真实
      // 输出上限(按端点身份查,拒 output≥context 的占位行)> 方言兜底,再收进窗口。
      // Anthropic 协议 max_tokens 必填,所以这条路必须给数——但绝不能给"名字撞来的"数:
      // 2026-09-09 智谱 GLM-5.3 的 1210 报障就是旧查表在 213 个目录里撞到某转售商的
      // {context:1048576, output:1048576} 占位行,把窗口尺寸当输出上限发了出去。
      // S3:再减本轮 prompt 估算 + 安全垫。prompt 190k / 窗口 200k / 上限 32k 曾是硬 400。
      max_tokens: requiredOutputCap(modelsDevCache, providerItem, picked.model.modelId, maxTokens, promptEstimate),
      stream: canStream,
      system: claudeSystemContent(systemContent, providerItem),
      messages: claudeMessagesFromApiMessages(messages, providerItem),
      // 顶层 cache_control: 让 Anthropic 自动管理缓存断点
      // 对齐安卓 ClaudeProvider.kt:275-278 (commit d2e52106)
      ...(providerItem.promptCaching === true
        ? { cache_control: claudeCacheControlEphemeral(providerItem) }
        : {}),
      ...(assistant.temperature != null && !reasoningActive ? { temperature: assistant.temperature } : {}),
      ...(topP != null ? { top_p: topP } : {}),
      // thinking + output_config：DeepSeek 走 Claude 格式时用 display:"raw" 展示原始思维链
      ...claudeThinkingPayload(picked.model, assistant.reasoningLevel),
      ...(claudeTools.length ? { tools: claudeTools } : {}),
    };
    if (canStream) {
      return streamClaudeChatWithTools(url, headers, applyCustomBody(shaped(body), assistant, picked.model), providerItem, assistant, signal, hooks!);
    }
    return fetchClaudeTextWithTools(url, headers, applyCustomBody(shaped(body), assistant, picked.model), providerItem, assistant, signal, hooks);
  }

  if (providerItem.authMode !== "oauth") headers.Authorization = `Bearer ${providerItem.apiKey}`;
  // 台账 §7.4,对齐安卓 ChatCompletionsAPI.kt:262 —— OpenRouter 在请求体发 session_id(非
  // 头;网关据此把同会话路由到同一上游实例,前缀缓存更可能命中)。仅 chat-completions 形态
  // 有此事;responses 形态安卓无对应。conversation.id 即会话身份(与 prompt_cache_key 同物)。
  const openRouterSessionId =
    hostOfProvider(providerItem) === "openrouter.ai" ? conversation.id : undefined;
  if (providerItem.useResponseApi) {
    const functionTools = supportsAbility(picked.model, "TOOL") ? conversationToolsWithDiscovery(assistant, picked.model, conversation.id) : [];
    const builtInTools = responseApiBuiltInTools(picked.model);
    const systemContent = conversationResponseApiInstructions(conversation, assistant);
    const reasoning = responseApiReasoningForProvider(providerItem, picked.model, assistant.reasoningLevel);
    const include = responseApiIncludeForProvider(providerItem, picked.model);
    body = {
      model: selectedModel,
      stream: false,
      store: false,
      ...(systemContent ? { instructions: systemContent } : {}),
      input: conversationResponseApiInput(conversation, assistant, useDynamicRecall, useDynamicRecall),
      ...(isModelAllowTemperature(picked.model) ? { temperature: assistant.temperature ?? undefined } : {}),
      ...(isModelAllowTemperature(picked.model) ? { top_p: topP } : {}),
      ...(optionalOutputTokens != null ? { max_output_tokens: optionalOutputTokens } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(include ? { include } : {}),
      ...(providerItem.promptCacheKey === true ? { prompt_cache_key: conversation.id } : {}),
      tools: [
        ...functionTools.map(responseApiFunctionTool),
        ...builtInTools,
      ].filter(Boolean),
    };
    if (!body.tools.length) delete body.tools;
    // 订阅供应商整形:Codex 需 include reasoning.encrypted_content、不识别 max_output_tokens。
    return fetchText(url, headers, applyCustomBody(shaped(body), assistant, picked.model), providerItem, (raw) => raw.output_text ?? raw.output?.flatMap((item: any) => item.content ?? []).map((item: any) => item.text ?? "").join("\n"), signal);
  }
  const tools = supportsAbility(picked.model, "TOOL") ? conversationToolsWithDiscovery(assistant, picked.model, conversation.id) : [];
  body = {
    model: selectedModel,
    // chat-completions 出线前剥 tool 消息的内部字段（name/_rikkahub_tool_output_parts）。
    messages: chatCompletionsWireMessages(messagesForApi),
    temperature: isModelAllowTemperature(picked.model) ? assistant.temperature ?? undefined : undefined,
    top_p: isModelAllowTemperature(picked.model) ? topP : undefined,
    // 上限字段名走统一请求方言（model-providers/request-dialect）：官方 OpenAI 口
    // max_completion_tokens（o 系硬要求），其余 max_tokens（第三方对未知字段静默忽略）。
    ...(optionalOutputTokens != null ? { [openAiMaxTokensField(hostOfProvider(providerItem))]: optionalOutputTokens } : {}),
    ...(providerItem.type === "openai" ? { modalities: openAiChatCompletionsModalities(picked.model, providerItem) } : {}),
    ...reasoningPayloadForProvider(providerItem, picked.model, assistant.reasoningLevel),
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? "auto" : undefined,
    ...(providerItem.promptCacheKey === true ? { prompt_cache_key: conversation.id } : {}),
    ...(openRouterSessionId ? { session_id: openRouterSessionId } : {}),
  };
  return fetchOpenAiText(url, headers, applyCustomBody(shaped(body), assistant, picked.model), providerItem, assistant, signal, hooks);
}

export async function executeApprovedToolPart(
  part: Record<string, JsonValue>,
  assistant: Assistant,
  context?: {
    conversationId?: string;
    messageNodeId?: string;
    signal?: AbortSignal;
    /** O4:执行时点边界观测(续跑路径与正常生成同一口径)。 */
    boundaryObserver?: ToolBoundaryObserver;
  },
) {
  const approvalType = toolApprovalType(part);
  if (approvalType === "answered") return String((part.approvalState as Record<string, JsonValue>)?.answer ?? "");
  if (approvalType === "denied") {
    const reason = String((part.approvalState as Record<string, JsonValue>)?.reason ?? "").trim() || "No reason provided";
    return { error: `Tool execution denied by user. Reason: ${reason}` };
  }
  // 走到这里 = 用户对 pending 卡显式批准：userApproved 是危险命令拦截的
  // 知情同意放行门（workspace/runtime.ts），仅此路径可置 true。
  return executeToolCall(apiToolCallFromPart(part), assistant, { ...context, userApproved: true });
}

export async function resumeApprovedToolParts(
  conversation: Conversation,
  assistant: Assistant,
  assistantMessage: Message,
  assistantNode: MessageNode,
  useResponseInput: boolean,
  signal?: AbortSignal,
  boundaryObserver?: ToolBoundaryObserver,
) {
  const toolMessages: ApiMessage[] = [];
  let changed = false;
  for (const part of assistantMessage.parts) {
    if (!isRecord(part) || part.type !== "tool") continue;
    if (Array.isArray(part.output) && part.output.length > 0) continue;
    if (!canResumeToolExecution(part)) continue;
    let toolResult: unknown;
    try {
      toolResult = await executeApprovedToolPart(part, assistant, {
        conversationId: conversation.id,
        messageNodeId: assistantNode.id,
        signal,
        ...(boundaryObserver ? { boundaryObserver } : {}),
      });
    } catch (err) {
      toolResult = toolExecutionErrorPayload(err);
    }
    const normalized = await toolResultToParts(toolResult);
    part.output = await realizeToolResult(normalized);
    changed = true;
    toolMessages.push(
      useResponseInput
        ? { type: "function_call_output", call_id: String(part.toolCallId ?? ""), output: toolResultTextForApi(part) }
        : { role: "tool", tool_call_id: String(part.toolCallId ?? ""), content: toolResultTextForApi(part) },
    );
  }
  if (changed) {
    // issue #59:审批恢复(批准后重跑/暂停后 resume)直写 output,不经应用器——终点戳
    // 由 finishToolParts 统一补(只补不覆盖,同款语义收进共享函数)。denied 分支的
    // {error} 载荷同样是被用户裁决的终局,一并定格。
    finishToolParts(assistantMessage);
    conversation.updateAt = Date.now();
    touchStream({ message: assistantMessage, conversation, node: assistantNode });
  }
  return toolMessages;
}

function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
}

// 批6复审 G2:当前生成流正在写的消息(按会话)。R2-3 的入口接管 abort 后,旧流异步退出,
// 若新流经 ensureAssistantGenerationNode 复用了同一空占位消息,旧流的收尾不得再触碰它。
// generating 登记判定"是否被接管",本记录判定"新流是否复用了同一消息对象"。
const activeGenerationMessages = new Map<string, Message>();

function completeConversationGeneration(conversationId: string, controller: AbortController) {
  const current = generating.get(conversationId);
  if (current !== controller) {
    // 已被接管(current 为新流 controller):所有权归新流,不得清。
    // 登记被外部清除(stop/删会话,current 为空):顺手清所有权记录,防陈旧 Message 引用滞留。
    if (!current) activeGenerationMessages.delete(conversationId);
    return;
  }
  generating.delete(conversationId);
  activeGenerationMessages.delete(conversationId);
  // The generating Map drives the sidebar's per-conversation streaming indicator
  // (rendered via the conversations-list SSE). Now that broadcastNodeUpdateNow no
  // longer pings the list on every chunk (see comment at api/sse.ts scheduleNodeBroadcast), we have
  // to explicitly refresh on the false→true and true→false transitions so the
  // indicator turns on/off. Caller `generateAnswer` calls broadcastConversation
  // at start which already touches broadcastList, and we cover the end transition
  // right here.
  broadcastList();
  // 1.2.6:流式结束,全量 reconcile 活库——刷残余脏标记 + persistConversation,把流式
  // 期间增量 upsert 的节点和任何新增/删除的节点统一对齐(清孤立节点行)。幂等
  // (upsert 会话行 + 删旧节点 + 重插)。会话已被并发删除时跳过;flushConvDirty
  // 也会跳过已删会话的脏标记。
  flushConvDirtyNow();
  const conv = getConversation(conversationId);
  if (conv) persistConversation(conv);
}

function conversationStillExists(conversationId: string) {
  // DB-first 批1:直查活库。新建会话即时落库(ensureConversation 1.2.6 起),无漏检窗口。
  const db = getConversationsDb();
  return db ? conversationExistsInDb(db, conversationId) : false;
}

/** 队列快照变化 → 会话 SSE 重广播(前端队列面板即据此刷新)。低频事件,不走合帧热路径。 */
function broadcastQueueState(conversationId: string) {
  const conv = getConversation(conversationId);
  if (conv) broadcastConversation(conv);
}

/**
 * steering 轮边界（用户问题②，对齐 Codex pending_input + transcript 逐项累积）：引擎在
 * 「即将构建下一模型请求之前」调用（聊天引擎 = 工具批执行完 / 最终轮无工具；pi = turn_end）。
 * 排水 steering 通道（只取仍在 FIFO 队列的项——被撤回/编辑的不注入），逐条落库 steer user
 * 节点（完整气泡 + `steered` 注解，与 dispatchQueuedHead 同构：正则变换入队时已做）+ 从队列
 * 移除（已注入≠待触发，防收尾再派发一次）+ 刷新面板，返回各消息文本供引擎编码。副作用全部
 * 收在本协调器（落库/队列/广播/换绑），引擎只拿纯文本——层纪律与 executeTool 同。语音回复
 * 通道：被注入项的等待方经 removeQueuedMessage 收 null（该轮回复涵盖全部补发，无单条回复
 * 可播报），语音模式跳过播报直接重开麦。
 *
 * Steer 边界节点分裂（对齐 Codex 数据序 [assistant_r1, user_steer, assistant_r2]）：排水命中
 * 后，把当前 assistant 节点收口定格（finishReasoningParts + finishedAt），落库 steer user，
 * 再新开一个 continuation assistant 节点接管后续流式（session.retarget，引擎经 GenerationTarget
 * 活视图自动跟随）。于是延续输出在数据层落在 steer user 之后——模型与用户都不会把 steer user
 * 误读为悬空未答。若当前节点还是无任何可见内容的空占位（isEmptyAssistantPlaceholder），不
 * 固化、直接剔除，避免「空气泡 + 插话」。整批多条 steer 只分裂一次（一个 ai_2 接住这批之后
 * 的全部延续）。
 *
 * 不变式：返回非空 ⟺ 发生了分裂（pushSteeringMessage 不收纯附件项，通道里每项都有文本），
 * 引擎侧据此把累计文本/耗时切到「当前段」口径。
 */
function steerBoundary(conversationId: string, session: GenerationSession): string[] {
  const conversation = getConversation(conversationId);
  if (!conversation) return [];
  const taken = drainSteeringMessages(conversationId, (itemId) => queueSnapshotFor(conversationId)?.items.some((it) => it.id === itemId) ?? false);
  if (taken.length === 0) return [];

  // 1) 收口/剔除当前 assistant 节点。空占位剔除而非定格，避免空气泡。
  const prevMessage = session.message;
  const nodeIndex = conversation.messages.findIndex((n) => n.id === session.node.id);
  if (nodeIndex >= 0) {
    if (isEmptyAssistantPlaceholder(prevMessage)) {
      conversation.messages.splice(nodeIndex, 1);
    } else {
      // 收口 ai_1：定格为一段已完成的「答复」。它留在 steer user 之前，观感=真的答完了。
      finishReasoningParts(prevMessage);
      stripLoadingPlaceholder(prevMessage);
      prevMessage.finishedAt = new Date().toISOString();
    }
  }

  // 2) 逐条落库 steer user 节点（完整气泡）。steered 注解是可选元数据（非功能依赖），
  //    默认不做任何特殊渲染；PC→APP 导出经 PC_ONLY_ANNOTATION_TYPES 剥离。
  const texts: string[] = [];
  for (const item of taken) {
    const userMessage = message("USER", item.parts.map((p) => ({ ...p })));
    userMessage.annotations.push({ type: "steered" });
    const turnMode=prevMessage.annotations.find((a:any)=>a?.type === "execution_mode");
    if(turnMode)userMessage.annotations.push(structuredClone(turnMode));
    const userNode = { id: id(), messages: [userMessage], selectIndex: 0 };
    conversation.messages.push(userNode);
    texts.push(textFromParts(item.parts));
    removeQueuedMessage(conversationId, item.id);
  }

  // 3) 新开 continuation assistant 节点 ai_2 接管后续流式（整批只开一个）。与生成入口
  //    同款 loading 占位:用户看到的是「新一轮正在思考」的打字点,首个 delta 自动摘除。
  const continuationMessage = message("ASSISTANT", [], prevMessage.modelId);
  continuationMessage.finishedAt = null; // 新节点进入生成态
  continuationMessage.annotations = [{ type: "execution_mode", mode: (session.message.annotations.find((a:any)=>a?.type === "execution_mode") as {mode?:string}|undefined)?.mode ?? "agent" }];
  setMessageLoading(continuationMessage);
  const continuationNode: MessageNode = { id: id(), messages: [continuationMessage], selectIndex: 0 };
  conversation.messages.push(continuationNode);

  conversation.chatSuggestions = [];
  conversation.updateAt = Date.now();
  persistConversation(conversation);
  broadcastConversation(conversation);
  broadcastQueueState(conversationId);

  // 4) 换绑：之后所有 sink 事件落进 ai_2（引擎无感）。
  session.retarget({ node: continuationNode, message: continuationMessage });
  return texts;
}

/** 队首派发核心(前置:调用方已确认空闲且未暂停)。 */
function dispatchQueuedHead(conversationId: string) {
  const conversation = getConversation(conversationId);
  if (!conversation) return;
  const next = shiftNextQueued(conversationId);
  if (!next) return;
  // 把队首的用户消息本体落库进历史(与 send 入口同构;parts 入队时已做正则变换),再基于最新历史点火下一条。
  const userMessage = message("USER", next.parts.map((p) => ({ ...p })));
  // 生命周期 L3:调度投递的 scheduled 注解随消息落库(恢复/审计与计划边界的判定依据)。
  for (const annotation of next.annotations ?? []) {
    userMessage.annotations.push(annotation);
  }
  const userNode = { id: id(), messages: [userMessage], selectIndex: 0 };
  conversation.messages.push(userNode);
  conversation.chatSuggestions = [];
  conversation.updateAt = Date.now();
  persistConversation(conversation);
  broadcastConversation(conversation);
  // 队列状态已变(少一条),面板立即刷新。
  broadcastQueueState(conversationId);
  // 语音模式回复通道:登记本条生成源自哪个排队项(经 message-queue 回调,仅 waitingReply 项生效)。
  notifyQueuedGenerationDispatched(conversationId, next);
  // 点火下一条。generateAnswer 入口自带「先中止旧流」不变式,但此处旧流已收尾(generating
  // 登记刚被 completeConversationGeneration 清除),它登记新 controller 并正常驱动。
  void generateAnswer(conversation);
}

/**
 * 消息发送队列派发(跨引擎统一):空闲 && 未暂停 && 未被打断冻结 && 队非空时,从队首
 * 取下一条待生成并点火。触发点:generateAnswer 收尾(经 stillMine 快照判「未被接管」后
 * 调用)+ queue/resume 端点(空闲时)。队列对引擎种类无感——它只调 generateAnswer,
 * 而那是聊天/pi 唯一注册生成的入口,新增引擎自动继承。
 * 终局三态门控(对齐 Codex ThreadIdleCause):heldByInterrupt(用户 stop/写入口接管
 * 中止)时 return——打断意图支配派发,冻结的队列等用户显式 resume。
 */
export function dispatchMessageQueue(conversationId: string) {
  if (generating.has(conversationId)) return; // 占用中:不打断,等当前流收尾续跑。
  // 压缩窗口互斥(与 send/enqueue 入口的 409 同一理由:压缩完成时整体覆盖 messages,
  // 窗口内点火的生成会被吞)。压缩端点 finally 解锁后接续调用本函数续跑。
  if (compressing.has(conversationId)) return;
  if (isQueuePaused(conversationId)) return;
  if (isQueueHeldByInterrupt(conversationId)) return;
  dispatchQueuedHead(conversationId);
}

/** 语音模式回复通道:登记「当前正在跑的排队生成」的源排队项 id。值仅存于内存,随收尾结算
 *  后删除;并发安全靠 generateAnswer 的「先 abort 再接管」不变式(同会话同一时刻只跑一条)。 */
const queuedGenerationSource = new Map<string, string>();
/** 已交付回复的排队项 id(防同消息被接管重跑时重复交付)。键同排队项生命周期,交付后即弃。 */
const deliveredQueuedGenerations = new Set<string>();
/** 运行态整体替换(备份导入)时清空回复通道记账——旧排队项的 id 作废,不得漂到
 *  新会话状态里影响后续「本轮是否源自排队生成」的判定。 */
export function clearQueuedReplyBookkeeping(): void {
  queuedGenerationSource.clear();
  deliveredQueuedGenerations.clear();
}
// 排队项被派发即登记来源。回复等待只在语音模式注册(waitingReply),键盘排队不触发回复通道。
setOnQueuedGenerationDispatched((conversationId, item) => {
  if (item.waitingReply) queuedGenerationSource.set(conversationId, item.id);
});

async function runPostGenerationTasks(conversationId: string, snapshot: Conversation, assistantMessageId: string, epoch: number) {
  // 收尾任务在生成登记清除后仍可能跑数秒(标题/建议各一次模型调用)。导入替换运行态
  // 之后,旧任务的产物不得写回——即便备份原样恢复了同一会话 id,代际也已失效。
  const liveConversation = () => (isRuntimeEpochCurrent(epoch) ? getConversation(conversationId) : undefined);
  // 快速模型解析一次,两个后台任务共用。null = 没配(空/出厂哨兵/指向已删模型)或对应
  // 子功能被用户在设置里关停 → 两者都静默跳过:标题退成首条消息文本,建议不生成,不弹
  // 任何失败提示,也不擅自拿主模型跑(建议回复每轮一次,用主模型不划算)。用户想要 AI
  // 标题就去设置里配快速模型;只要其一就在快速模型卡的 Prompt 页关掉另一个。
  const { title: titleModelId, suggestion: suggestionModelId } = resolvePostGenerationModelIds();
  if (shouldAutoGenerateTitle(snapshot) && titleModelId) {
    try {
      const title = await generateTitleForConversation(snapshot, titleModelId);
      const live = liveConversation();
      if (live && shouldAutoGenerateTitle(live)) {
        live.title = title;
        persistConversation(live);
        broadcastConversation(live);
      }
    } catch (titleError) {
      addLog({
        providerId: "",
        providerName: "RikkaHub PC",
        url: "conversation:title",
        ok: false,
        status: 0,
        kind: "aux:title",
        error: titleError instanceof Error ? titleError.message : String(titleError),
      });
      // info 级:标题只是便利功能,回退首条消息文本后用户无感损失。只进错误中心供排查,
      // 不弹全局 toast——后台任务的失败不该打断用户手上的事。
      reportError("provider", "info", "标题自动生成失败，已回退为首条消息文本", titleError, "title_generation_failed");
      // Title generation failed → fall back to first user message text (Android parity).
      const live = liveConversation();
      if (live && shouldAutoGenerateTitle(live)) {
        const firstText = textFromParts(live.messages[0]?.messages[0]?.parts ?? []).trim();
        const fallback = limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation";
        live.title = fallback;
        persistConversation(live);
        broadcastConversation(live);
      }
    }
  } else if (shouldAutoGenerateTitle(snapshot)) {
    // 未配快速模型 → 不调任何模型,直接用首条用户消息文本命名(与 Android 同口径)。
    const live = liveConversation();
    if (live && shouldAutoGenerateTitle(live)) {
      const firstText = textFromParts(live.messages[0]?.messages[0]?.parts ?? []).trim();
      const fallback = limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation";
      if (fallback !== live.title) {
        live.title = fallback;
        persistConversation(live);
        broadcastConversation(live);
      }
    }
  }

  if (!suggestionModelId) return;
  try {
    const suggestions = await generateSuggestionsForConversation(snapshot, suggestionModelId);
    const live = liveConversation();
    const lastNode = live?.messages[live.messages.length - 1];
    const lastMessage = lastNode?.messages[lastNode.selectIndex] ?? lastNode?.messages[0];
    if (live && lastMessage?.id === assistantMessageId && !generating.has(live.id)) {
      live.chatSuggestions = suggestions;
      live.updateAt = Date.now();
      persistConversation(live);
      broadcastConversation(live);
    }
  } catch (suggestionError) {
    // Suggestions are auxiliary;正文生成状态不应受影响。info 级同标题:少几个建议 chip
    // 不构成需要打扰用户的故障。
    reportError("provider", "info", "会话建议生成失败", suggestionError, "suggestion_generation_failed");
  }
}

const ENGINE_REGISTRY: EngineAdapter[] = [{
  kind: "kernel", matches: () => true, resumeSemantics: "run-and-suspend", steering: "boundary",
  run: runKernelGeneration,
}];

/** 纯生成逻辑：经引擎注册表分发到命中 adapter,由 sink 发出生成事件。
 *  本函数不直接写 state.json、不直接广播 SSE、不直接落盘 SQLite——这些副作用由
 *  协调器 generateAnswer 统一处理。 */
async function runGeneration(
  deps: EngineRunContext & { adapter: EngineAdapter },
  sink: GenerationEventSink,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
  // T1:布尔路由退役——引擎选择已收敛为 resolveEngine 选出的 adapter.run。pi 专属
  // 决策(piRuntime)由 pi adapter 在 matches()/run() 内部携带,不再污染本层。
  return deps.adapter.run(deps, sink, signal);
}

/** 引擎原生压缩入口(压缩路由收编:经注册表分发,与生成路由同源)。返回 null =
 *  命中引擎未声明 compact 能力(chat 无引擎记忆)——调用方回落 UI 历史压缩(聊天
 *  引擎从 UI 历史构建请求,压 UI 历史即压上下文)。工作区不可用(缺根/未信任)时
 *  pi 的 matches() 不命中、落到 chat 兜底,同样回落——与生成路由的降级天然一致。
 *  压缩期间 engine_status 直通状态条,finally 兜底清除(取消/失败不挂"压缩中");
 *  瞬态状态的「怎么发」是引擎的事(经 sink),「怎么播/怎么兜底清」是本层的事,
 *  与 generateAnswer 的 sink 职责划分一致。 */
export async function compactEngineConversation(
  conversation: Conversation,
  customInstructions: string,
  signal?: AbortSignal,
): Promise<{ engine: EngineKind; summary: string; tokensBefore: number; estimatedTokensAfter: number | null } | null> {
  const epoch = runtimeEpoch();
  const assistant = findAssistant(conversation.assistantId);
  const adapter = resolveEngine(ENGINE_REGISTRY, conversation, assistant);
  if (!adapter.compact) return null;
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  // 压缩模型公共化(「设置 → 模型 → 场景模型」是公共基础设施):配置了压缩模型则
  // 所有引擎的摘要生成都用它,未配置回退会话模型。modelExists 先行:压缩模型被
  // 删除后设置残留 id 不该改变语义(findModel 对不存在 id 会兜底 chatModelId,
  // 那是"默认聊天模型"不是"用户指定的压缩模型",宁可回退会话模型)。
  const summarizerPicked = modelExists(state.settings.compressModelId)
    ? findModel(state.settings.compressModelId)
    : picked;
  try {
    const result = await adapter.compact(
      {
        conversation,
        assistant,
        provider: picked.provider,
        model: picked.model,
        summarizer: { provider: summarizerPicked.provider, model: summarizerPicked.model },
        customInstructions,
      },
      (event) => {
        if (event.kind === "engine_status") broadcastEngineStatus(conversation.id, event.status);
      },
      signal,
    );
    // 引擎实现内部的落库点(pi applyCaptured)已自校验;这里再守一道,覆盖未来
    // "引擎只返回结果、编排器落库"的 adapter——导入后绝不能对调用方报成功。
    if (!isRuntimeEpochCurrent(epoch)) throw new Error("运行态已在压缩期间被导入替换，压缩结果作废");
    return {
      engine: adapter.kind,
      summary: result.summary,
      tokensBefore: result.tokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter,
    };
  } finally {
    broadcastEngineStatus(conversation.id, { busy: false });
  }
}

/** 会话的引擎判定(注册表路由的只读查询)。编排器外的消费点(审批端点等)用它替代
 *  自行判定(如以"工作区可用"旁路推断引擎),保证与生成/压缩路由永远同源——
 *  第三引擎接入时这些消费点自动跟随注册表,无需再改。 */
export function resolveEngineForConversation(conversation: Conversation): EngineAdapter {
  return resolveEngine(ENGINE_REGISTRY, conversation, findAssistant(conversation.assistantId));
}

export async function generateAnswer(conversation: Conversation, regenerateAtNodeId?: string) {
  const lastUser=[...conversation.messages].reverse().map(n=>n.messages[n.selectIndex]).find(m=>m?.role === "USER");
  const selected=lastUser?.annotations.find((a:any)=>a.type === "execution_mode") as {mode?:"agent"|"chat"}|undefined;
  const executionMode=conversation.conversationKind === "chat" ? "chat" : selected?.mode ?? conversation.executionMode ?? "agent";
  // The picker persists until changed; queued turns retain their submitted mode.

  // R2-3:入口自带"先中止旧流"不变式。端点级守卫(send/edit/regenerate 的先 abort)挡不住
  // OCR 续体窗口:两条消息的续体先后异步触发本函数时,后者若直接 generating.set 会顶掉
  // 前者的 controller——前者成无主流,两路流式交错写同一节点(parts 交叉污染)、且无人能停。
  // 把端点级纪律下沉为编排器不变式:同会话已有登记流,先 abort 再接管(后到者胜,与端点
  // 语义一致)。completeConversationGeneration 按 controller 身份幂等,旧流收尾不会误删新登记。
  // 意图 replaced:接管即继续对话,旧流收尾不冻结队列。
  abortGeneration(conversation.id, "replaced");
  const controller = new AbortController();
  generating.set(conversation.id, controller);
  // D2 运行态代际:备份导入会整体替换会话/队列/审批/记忆运行态。此后本流的任何写入、
  // 广播、队列派发与后台任务都必须作废——即便导入恰好恢复了同一会话 id,旧实例也
  // 不是新库里那条会话。入口一次捕获,异步边界(sink/收尾/后台任务/finally)逐点复检。
  const generationEpoch = runtimeEpoch();
  // DB-first:整个生成期持有引用(与 finally 的 release 恰好配对一次;
  // completeConversationGeneration 有多处幂等调用,release 不能放那里)。
  // generating 条件本身也挡 sweep,refs 是纵深防御(abort 后 generating 先被清的窗口)。
  checkoutConversation(conversation.id);
  const assistant = findAssistant(conversation.assistantId);
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  // T1:路由在入口一次判定并贯穿本次生成(与 P1-4 配置快照同理)——引擎选择收敛为
  // 注册表 resolveEngine(pi 命中工作区三道闸即接管,否则 chat 兜底)。续跑/暂停语义
  // 不再写死 "!piRuntime",改读 adapter.resumeSemantics。
  const adapter = resolveEngine(ENGINE_REGISTRY, conversation, assistant);
  // 阶段三:聊天模式自动压缩。工作区(pi)有引擎原生 threshold/overflow 压缩,不重复。
  // 必须在 ensureAssistantGenerationNode 之前——本轮的空白助手占位不该进摘要输入;
  // 自动压缩 best-effort(失败只报 warn),取消/接管则立即退出本次生成。
  if ((adapter.kind === "chat" || adapter.kind === "kernel")) {
    try {
      await maybeAutoCompactChat({
        conversation,
        assistant,
        provider: picked.provider,
        model: picked.model,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        completeConversationGeneration(conversation.id, controller);
        // 导入替换后 working set 已被整体清空,旧流的 checkout 引用不复存在;
        // 此时 release 会误减导入后新条目的引用计数,跳过。
        if (isRuntimeEpochCurrent(generationEpoch)) releaseConversation(conversation.id);
        return;
      }
      throw error;
    }
  }
  // 自动压缩期间发生导入替换:旧实例的节点/消息不再属于任何可信会话,直接放弃本次生成。
  if (!isRuntimeEpochCurrent(generationEpoch)) {
    completeConversationGeneration(conversation.id, controller);
    return;
  }
  const isRunAndSuspend = adapter.resumeSemantics === "run-and-suspend";
  // 重新生成 ASSISTANT:调用方已在该 node 追加空占位 message 并把 selectIndex 指向它,
  // 直接复用,绕开 ensureAssistantGenerationNode(它会复用末尾 assistant 或新建 node,
  // 都不是"在指定 node 上新增分支")。find 不到时安全回退到默认逻辑。
  let assistantNode: MessageNode;
  if (regenerateAtNodeId) {
    const found = conversation.messages.find((n) => n.id === regenerateAtNodeId);
    assistantNode = found ?? ensureAssistantGenerationNode(conversation, picked.model.id);
  } else {
    assistantNode = ensureAssistantGenerationNode(conversation, picked.model.id);
  }
  const currentMessage = assistantNode.messages[assistantNode.selectIndex];
  // Steer 边界节点分裂：本次生成的流式落点句柄。初始 = ai_1；steer 边界由 steerBoundary
  // 经 retarget 换绑到 ai_2。下方 sink/applyEvent/finalization/abort/失败/审批判定全部改读
  // session 当前值，不再硬编码 assistantNode/currentMessage——steer 后延续输出自然落进新节点。
  // 所有权记录(activeGenerationMessages)由 session 内部随落点维护。
  const session = createGenerationSession(conversation.id, { node: assistantNode, message: currentMessage });
  // P1-3:四条出口路径(pending/done/aborted/failed)的共同收尾序列。差异只在 parts 与
  // finishedAt 处理,由 applyParts 注入。completeConversationGeneration 幂等,finally 兜底。
  // 落点读 session 当前值:无 steer 时=ai_1,有 steer 时=ai_2——四条路径同正确。
  const finalizeOutcome = (applyParts: () => void) => {
    // D2:导入已替换运行态 → 旧流的收尾(变换/usage/广播/落库标脏)一律不执行。
    if (!isRuntimeEpochCurrent(generationEpoch)) return;
    // 批6复审 G2:接管守卫——被新流接管且新流复用同一消息对象时,旧流的收尾若继续执行,
    // 会对新流正在写的回答做 transforms/盖 finishedAt/写估算 usage,失败分支甚至把
    // "请求失败"文本和 model_call_error 注解追加进去。此时静默退出(消息已易主,由新流
    // 负责收尾);新流用的是新消息对象时,旧流仍照常收尾自己的消息,行为不变。
    const owner = generating.get(conversation.id);
    if (owner && owner !== controller && activeGenerationMessages.get(conversation.id) === session.message) return;
    applyOutputTransforms(session.message, assistant);
    finishReasoningParts(session.message);
    // #59 补完:工具卡与思维链同规则收口——本流终局仍无终点戳的已执行工具在此定格
    // (停止/失败路径的卡不走 applier 的 tool_result 终局,不补则前端按孤儿卡隐藏时长)。
    // pending 待审批卡由 finishToolParts 自行跳过(等待期间照走表)。
    finishToolParts(session.message);
    // 终局一律摘 loading 占位:正常路径由首个 delta 摘,但空回复 / 首个 delta 前中止 /
    // 删会话接管等路径没人摘,前端"打字点"会永久残留在已完结消息上。四条出口统一在此收口
    // (stop 端点因不经本函数仍自行摘除)。
    stripLoadingPlaceholder(session.message);
    applyParts();
    ensureUsage(session.message, conversation);
    conversation.updateAt = Date.now();
    completeConversationGeneration(conversation.id, controller);
    broadcastNodeUpdate(conversation, session.node);
    broadcastConversation(conversation);
  };
  // T1:续跑语义读 adapter 声明——仅 pause-resume 引擎(聊天)有"整批暂停→逐卡批准→
  // 重触发续跑";run-and-suspend 引擎(pi)的工具审批由 approval-gate 挂起汇合,不重触发。
  const resumingApprovedTools = adapter.resumeSemantics === "pause-resume" && hasResumableToolParts(currentMessage);
  // 自主循环(S1):运行记录是纯观察者——总开关关闭时不建 run、不挂边界回调,sink 出口
  // 也不补 runId,两条引擎通路与引入前逐字一致。聊天引擎"审批暂停→批准后重触发续跑"
  // 接续最近一条 suspended run(一次逻辑任务一条记录),而不是把同一次任务拆成两条。
  // 生命周期 L2/L3:最近一条 USER 消息的注解决定本次 run 的来源(恢复/调度)。
  // 审批后接续(suspended)不是新 run,链接字段无意义,保持空。
  const resumedFromRunId = resumingApprovedTools ? null : runResumeTarget(conversation);
  const scheduleId = resumingApprovedTools ? null : scheduleTarget(conversation);
  const runTracker: AgentRunTracker | null = executionMode !== "chat"
    ? beginAgentRun({
        conversationId: conversation.id,
        nodeId: assistantNode.id,
        engine: adapter.kind,
        resumeSuspended: resumingApprovedTools,
        resumedFromRunId,
        scheduleId,
      })
    : null;
  // 调度记录回写 last_run_*(展示/审计用;失败不影响生成)。
  if (runTracker && scheduleId) markScheduleRun(scheduleId, runTracker.runId, Date.now());
  // O4:审批/执行两处观测统一适配到当前 run tracker;没有 run(开关关闭/落库失败)就不注入。
  const boundaryObserver = runTracker ? createRunBoundaryObserver(runTracker) : undefined;
  // 自主循环(S3):判定表。开关关闭时不建控制器,也不向引擎传任何判定回调——两条
  // 引擎通路与引入前逐字一致。控制器是纯判定器,计划每次现读会话消息流(steer 换绑/
  // 工具结果回写都自动可见),replan/stall 经 runTracker 落流水。
  const loopConfig = state.settings.agentLoop;
  const loopController: AgentLoopController | null = executionMode !== "chat" && loopConfig != null
    ? new AgentLoopController(
        {
          maxReplans: loopConfig.maxReplans,
          stallRepeatLimit: loopConfig.stallRepeatLimit,
          sameErrorLimit: loopConfig.sameErrorLimit,
          requireVerifiedCompletion: loopConfig.requireVerifiedCompletion,
          roundBudgetTokens: loopConfig.roundBudgetTokens ?? 0,
        },
        {
          readPlan: () => latestPlan(conversation),
          onGoal: (goal) => runTracker?.setGoal(goal),
          onReplan: ({ reason, replanCount }) => runTracker?.noteReplan(reason, latestPlan(conversation)?.goal ?? null),
          onStall: ({ reason }) => runTracker?.noteStall(reason),
        },
      )
    : null;
  currentMessage.annotations = [...(currentMessage.annotations ?? []).filter(a => !isRecord(a) || a.type !== "execution_mode"), { type: "execution_mode", mode: executionMode }];
  currentMessage.finishedAt = null;
  // R7-2:重入生成(续写/重试复用同一消息对象)时清掉上一轮的失败标记,
  // 本轮成功后前端错误横幅不再残留;本轮再失败会在 catch 里重新落标记。
  // 异常数据容忍:annotations 缺失(手改/极老数据)不能让生成入口崩死整个会话——
  // 这里顺手自愈为数组,后续 push 同样安全(用户数据安全优先)。
  currentMessage.annotations = (currentMessage.annotations ?? []).filter(
    (item) => !(typeof item === "object" && item !== null && (item as { type?: unknown }).type === "model_call_error"),
  );
  // Allow createdAt to be re-stamped on the first content chunk of this generation pass —
  // supports regenerate, which reuses the same message object.
  streamStartedMessages.delete(currentMessage);
  if (!resumingApprovedTools) {
    // 专题11复审:非续跑的重入生成(重试等复用同一消息对象)清掉上一代 usage——
    // mergeTokenUsage 的“新值>0 才覆盖”会把上一代的 cachedTokens/completionTokens
    // 带进本轮统计。续跑(工具审批恢复)是同一请求的延续,保留。
    currentMessage.usage = null;
    // Show a loading placeholder immediately so the UI has visual feedback during the
    // upstream first-token wait. addStreamText / replaceLoadingReasoningWithTool will
    // strip this placeholder as soon as the first real delta arrives.
    setMessageLoading(currentMessage);
  }
  conversation.updateAt = Date.now();
  broadcastNodeUpdate(conversation, assistantNode);
  try {
    // 上下文预算总开关开启时:压缩已尽力(若用户开了自动压缩),仍超窗口则在任何
    // 网络调用前拒绝本次生成——不发请求 = 零计费、零 400。窗口未知时该检查自跳过。
    // 放在 try 内:失败路径走统一收尾(摘 loading、落错误注解、释放 working-set 引用)。
    if ((adapter.kind === "chat" || adapter.kind === "kernel")) {
      await assertContextFits({
        conversation,
        assistant,
        provider: picked.provider,
        model: picked.model,
      });
    }
    if (resumingApprovedTools) {
      await resumeApprovedToolParts(
        conversation,
        assistant,
        currentMessage,
        assistantNode,
        false,
        controller.signal,
        boundaryObserver,
      );
    }
    // 工具执行闭包：把 server.ts 里的 executeToolCall 包装成 ToolExecutor 接口。
    // 这里保留对全局 state 的读写（如 saveToolBinaryContent），因为协调器仍然是唯一拥有
    // state 写权限的层；后续 Phase 会再把文件落盘拆到 files/ 模块。
    const executeTool: ToolExecutor = async (toolCall, context) => {
      // 注入生成级 signal（工作区工具据此取消，bash 连杀进程树）与部分输出回写
      // （bash 执行中把尾部输出写进 tool part，走现有 touchStream 合帧管线）。
      const raw = await executeToolCall(toolCall, assistant, {
        ...context,
        signal: controller.signal,
        // O4:执行时点边界观测(与审批观测同源、stage 不同)。
        ...(boundaryObserver ? { boundaryObserver } : {}),
        // 自主循环(S2):计划改写保护的前值。只有 update_plan 需要,避免每工具调用扫消息流。
        ...(String(toolCall.function?.name ?? "") === PLAN_TOOL_NAME
          ? { planContext: findPlanContext(conversation, String(toolCall.id ?? "")) }
          : {}),
        onToolPartialOutput: (output) => applyEvent({ kind: "tool_result", toolCallId: toolCall.id, output, final: false }),
        // 聊天引擎的子智能体桥：子会话跑 pi 生成,但没有工作区——只挂通用工具
        // (search_web/scrape_web),cwd 用独立 scratch 目录,项目 AGENTS.md 不参与。
        // 每次 dispatch 现取新 runner(独立 dispatchId → 独立审批 scope)。

      });
      // ask_user / MCP 审批等 pending 状态直接作为单 output 载荷返回，让协调器走暂停路径。
      if (isRecord(raw) && "pending" in raw) {
        return { output: [raw as unknown as ToolPendingOutput] };
      }
      const normalized = await toolResultToParts(raw);
      const output = await realizeToolResult(normalized);
      return { output };
    };
    // P2(pi 引擎):内联 applyEvent 抽取为共享应用器(conversations/generation-apply.ts,
    // 逐字搬迁行为零变)——聊天引擎与 pi 事件桥共用同一份"事件→parts"写入字典。
    // 落点 = session 活视图:steer 换绑后,后续事件自动应用到 ai_2(应用器每事件现读)。
    const applyEvent = createGenerationEventApplier({
      conversation,
      get node() {
        return session.node;
      },
      get message() {
        return session.message;
      },
    });
    const sink: GenerationEventSink = (event) => {
      // D2:导入替换后旧流的每个事件都属于旧实例——应用器会 touchStream 标脏落库,
      // 不拦截就会把旧内容写进刚导入的新库(含同一会话 id 的恢复)。
      if (!isRuntimeEpochCurrent(generationEpoch)) return;
      // 自主循环(S1):观察者先记账(只记摘要与计数),再把 runId 补进出站事件。
      // 开关关闭时与引入前逐字一致(不观察、不加字段)。
      runTracker?.observe(event);
      const outbound: typeof event = runTracker ? { ...event, runId: runTracker.runId } : event;
      // P5:引擎瞬态状态(压缩中/自动重试)不落库不产 part,直通会话 SSE 状态条;
      // 其余事件照走应用器。generateAnswer finally 兜底 busy:false,中途 abort 不挂条。
      if (outbound.kind === "engine_status") {
        broadcastEngineStatus(conversation.id, runTracker ? runTracker.enrichStatus(outbound.status) : outbound.status);
        return;
      }
      applyEvent(outbound);
    };
    // 续跑审批工具可能已跑过一段异步(工具执行/子代理);导入发生后不得再发起模型请求。
    if (!isRuntimeEpochCurrent(generationEpoch)) throw new DOMException("Runtime replaced", "AbortError");
    const content = await runGeneration(
      {
        conversation,
        executionMode,
        target: session,
        assistant,
        provider: picked.provider,
        model: picked.model,
        executeTool,
        // steering 轮边界(用户问题②):唯一装配点。聊天引擎在工具循环轮边界与最终轮调用;
        // pi 引擎在 turn_end 调用;未来引擎在「即将构建下一模型请求前」调用同一回调即自动
        // 继承分裂能力(收口当前节点、落库 steer user、新开 continuation 节点并换绑)。
        // 声明 steering:"none" 的引擎不下发——排水即分裂,不能注入的引擎不该有机会排水;
        // 其补发留在队列由收尾派发兜底。
        ...(adapter.steering === "boundary" ? { onSteerBoundary: () => steerBoundary(conversation.id, session) } : {}),
        // 自主循环(S1):轮边界观察点(chat = 工具循环每轮;pi = turn_start)。
        ...(runTracker ? { onRunBoundary: (round: number) => runTracker.boundary(round) } : {}),
        // 自主循环(S3):判定表(chat = 工具批边界 + 最终轮;pi = turn_end)。
        ...(loopController
          ? {
              // S-F4/F5:轮级体积由 run-tracker 从同一批事件现算(与富化裁剪同一
              // clipToolResultText/estimateTokens 口径),判定表按它做预算刹车。
              onToolRoundEnd: (observations: LoopToolObservation[]) =>
                loopController.evaluateToolRound(observations, runTracker?.roundSummary() ?? null),
              onFinalCandidate: () => loopController.evaluateFinal(),
            }
          : {}),
        // 多步可观测性(O4):审批最终判定处的边界观测(chat 工具循环 / pi 工作区工具)。
        ...(boundaryObserver ? { onToolBoundary: boundaryObserver } : {}),
        adapter,
      },
      sink,
      controller.signal,
    );
    if (controller.signal.aborted) throw new DOMException("Generation stopped", "AbortError");
    // runGeneration 正常返回但导入已发生(abort 与新流收尾的竞态窗口):结果同样作废。
    if (!isRuntimeEpochCurrent(generationEpoch)) throw new DOMException("Runtime replaced", "AbortError");
    if (adapter.resumeSemantics === "pause-resume" && hasPendingToolApproval(session.message)) {
      // 注:hasPendingToolApproval 判定在 applyOutputTransforms 之前与旧实现一致——
      // 旧实现先 transform 再判定,但 transform 只改 text/reasoning parts,不触碰 tool
      // parts 的 approvalState,判定结果不受影响;两分支的 transform 都由 finalize 统一做。
      // 自主循环(S1):暂停不是终局——run 记 suspended,批准后重触发续跑接续同一条记录。
      runTracker?.suspend();
      finalizeOutcome(() => {
        session.message.finishedAt = null;
      });
      return;
    }
    finalizeOutcome(() => {
      if (session.message.parts.length === 0) {
        finishMessage(session.message, [{ type: "text", text: content }]);
      } else {
        const hasText = textFromParts(session.message.parts).trim().length > 0;
        if (!hasText && content && content !== "(empty response)") {
          appendTextPart(session.message, content);
        }
        session.message.finishedAt = new Date().toISOString();
      }
    });
    // 自主循环(S1):终局 succeeded。开启 S3 后此处接入完成校验,不满足则注入/停滞。
    runTracker?.finishTerminal("succeeded");
    // 导入替换后 finalizeOutcome 已静默作废;后台任务/回复交付同样不得在新运行态上执行。
    if (!isRuntimeEpochCurrent(generationEpoch)) return;
    // 记忆自动整理：仅助手开启且到达 N 轮门槛才真正入队，默认关闭时零成本。
    scheduleMemoryOrganize(conversation.id);
    // 第二轮提及计分：只扫用户消息；实验开关关闭时零副作用。
    scheduleMentionScoring(conversation.id);
    const snapshot = cloneConversation(conversation);
    void runPostGenerationTasks(conversation.id, snapshot, session.message.id, generationEpoch);
    // 实验：心情判定。异步入队，与回复交付解耦；总开关关闭时函数直接早退。
    scheduleMoodJudgeForTurn({
      conversation: snapshot,
      assistant,
      assistantMessageId: session.message.id,
    });
    // 语音模式回复通道:本条若源自「等回复的排队生成」,把该轮 assistant 文本交付等待方。
    // 空正文交付 null(语音模式据此跳过播报)。已交付集合防「同消息被接管重跑」重复交付。
    const replySourceId = queuedGenerationSource.get(conversation.id);
    if (replySourceId && !deliveredQueuedGenerations.has(replySourceId)) {
      deliveredQueuedGenerations.add(replySourceId);
      deliverQueuedReply(conversation.id, replySourceId, textFromParts(session.message.parts));
    }
  } catch (err) {
    // D2:导入替换运行态 → 旧流出错不产出任何处置(队列/审批/广播/失败注解都属于旧实例)。
    if (!isRuntimeEpochCurrent(generationEpoch)) {
      completeConversationGeneration(conversation.id, controller);
      return;
    }
    if (!conversationStillExists(conversation.id)) {
      completeConversationGeneration(conversation.id, controller);
      return;
    }
    // 批6复审 G3:abort 意图支配错误分类——部分 fetch 实现/上游在 abort 时抛的是普通
    // 网络错误而非 AbortError,若走失败分支会给用户主动停止的回答追加"请求失败"+错误
    // 注解并弹全局错误。只要本流已被要求中止,一律按中止收尾。
    if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      // 终局三态之 Interrupted:本流以中止收尾。队列命运由中止方声明的意图决定(见
      // generation-state GenerationAbortReason):interrupted(用户 stop)→ 冻结,等显式
      // resume(对齐 Codex Interrupted 不派发);replaced(写入口接管)→ 不冻结,新流收尾
      // 照常派发(对齐 Codex 新输入开 turn 后 Completed 续跑);deleted → 队列随会话已清,
      // 无事可做。无意图的中止(外部/未知来源)按最保守的 interrupted 处理——宁停勿乱跑。
      // 此前靠「登记在册是否另一个 controller」推断接管,在 OCR 续体窗口里旧流的 catch
      // 会抢在新流登记前执行,把接管误判成打断并冻结队列(2026-09-20 用户测试 1 症状)。
      const reason = abortReasonOf(controller.signal) ?? "interrupted";
      // 自主循环(S1):停止是终局,不是失败;stop_reason 沿用现有意图三态。
      runTracker?.finishTerminal("stopped", { stopReason: reason });
      if (reason === "interrupted") {
        holdMessageQueue(conversation.id);
        // 等待专属回复的排队项(IM/语音)随停止一并取消并 resolve null:留在冻结队列里
        // 等待方永久悬挂,解冻后又会变成无人接收的静默生成。普通键盘排队保持原样。
        cancelWaitingQueuedMessages(conversation.id);
        broadcastQueueState(conversation.id);
      }
      finalizeOutcome(() => {
        session.message.finishedAt = new Date().toISOString();
      });
      return;
    }
    // 自主循环(S3):判定表终局(stalled / awaiting_user / exhausted)。这不是上游失败:
    // 不弹请求失败、不报供应商错误;保留已生成内容与计划,消息上留结构化注解(前端按
    // 注解渲染停滞提示),运行记录里给"继续 / 改目标"的锚点。队列暂停——等待用户消息
    // 才能恢复(awaiting_user 的定义),不能被下一条排队消息悄悄续跑。
    if (AgentLoopHaltError.is(err)) {
      runTracker?.finishTerminal(runStatusForHalt(err.status), { error: err.reason });
      pauseMessageQueue(conversation.id);
      cancelWaitingQueuedMessages(conversation.id);
      broadcastQueueState(conversation.id);
      finalizeOutcome(() => {
        session.message.finishedAt = new Date().toISOString();
        session.message.annotations.push({
          type: "agent_loop_halt",
          status: err.status,
          reason: err.reason,
        });
        if (!textFromParts(session.message.parts).trim()) {
          appendTextPart(session.message, err.reason);
        }
      });
      return;
    }
    // 匿名遥测:只记"发生了一次 provider 失败",不采集错误内容/模型/服务商。
    bumpAnalyticsErrCount();
    const rawContent = err instanceof Error ? err.message : String(err);
    const proxyHint = classifyProxyError(err, state.settings.proxyConfig);
    const failureText =
      proxyHint
      ?? classifyContextOverflowError(err)
      ?? classifyOutputCapError(err)
      // 限流排在凭证失效之前:refresh 撞上游 429 时,错误串同时含 "OAuth refresh failed"
      // 与 "429",此刻"稍后重试"比"重新登录"准确(transient 不该引导重登)。
      ?? classifyRateLimitError(err)
      ?? classifyOAuthCredentialError(err)
      ?? `请求失败：${rawContent}`;
    // 自主循环(S1):失败终局(错误摘要截断落库,不存堆栈与正文)。
    runTracker?.finishTerminal("failed", { error: failureText.slice(0, 500) });
    // P2-1(N-7 归宿):失败文本除了落在消息注解上(仅会话内可见),还上报全局通道——
    // 用户不在该会话页时也能收到通知(批2 接前端 toast)。
    reportError("provider", "error", failureText, err);
    // 消息发送队列:失败自动暂停(保留全部排队项,待用户手动 resume 续跑)。对齐 APP
    // onGenerationFinished(cause != null) → pause。仅真失败暂停——用户主动 stop/中止在上面
    // 已 return,不会到这;故 stop 不会暂停队列,只停在「无下一条自动点火」。
    pauseMessageQueue(conversation.id);
    // 失败暂停的队列不会自动续跑;等待专属回复的排队项(IM/语音)必须在此结算 null,
    // 否则 IM 串行链卡在 waitForQueuedReply,后续命令全部失效。
    cancelWaitingQueuedMessages(conversation.id);
    broadcastQueueState(conversation.id);
    finalizeOutcome(() => {
      // 错误零污染正文(对齐 Android addError):失败详情只活在 model_call_error 注解的
      // message 字段,由前端错误卡呈现;正文保留半截真实产出。既无正文也无错误的流
      // (中止/纯失败)不会走到这里——中止分支已先行返回。
      session.message.finishedAt = new Date().toISOString();
      // R7-2:结构化错误标记——前端错误卡由它驱动,详情取注解的 message 字段,
      // 不再对正文做关键词正则(讨论 HTTP 状态码/超时的正常回答不误报)。
      session.message.annotations.push({ type: "model_call_error", message: failureText });
    });
  } finally {
    // 自主循环(S1):兜底收敛——导入替换/会话删除等提前 return 的路径不会走到上面的
    // 显式终局;仍 running 的 run 在此收成 stopped,suspended/已终局的不动。
    runTracker?.ensureSettled(
      abortReasonOf(controller.signal) ?? (isRuntimeEpochCurrent(generationEpoch) ? "interrupted" : "replaced"),
    );
    // D2:导入替换运行态 → 旧流的一切收尾副作用(回复记账、审批/steering 清扫、广播、
    // 队列派发)全部跳过:导入方已整体作废这些表并清空 working set。释放引用同理跳过,
    // 否则会误减导入后新条目的引用计数。controller 身份幂等,作废登记仍可安全归还。
    if (!isRuntimeEpochCurrent(generationEpoch)) {
      completeConversationGeneration(conversation.id, controller);
      return;
    }
    // 语音模式回复通道兜底:成功路径已交付;走到 finally 仍未交付 = 本条排队生成以
    // abort/失败/被接管收尾(均无可播报回复),交付 null 让语音模式跳过播报、直接重开麦。
    const replySourceId = queuedGenerationSource.get(conversation.id);
    if (replySourceId && !deliveredQueuedGenerations.has(replySourceId)) {
      deliveredQueuedGenerations.add(replySourceId);
      deliverQueuedReply(conversation.id, replySourceId, null);
    }
    // 消息发送队列续跑的归属:被 replaced(写入口接管)的旧流不派发——接管方自己的收尾
    // 负责续跑(compress 无新流,其端点 finally 显式续跑)。若旧流在此派发,慢 OCR 窗口里
    // 会抢在接管方登记之前点火队首,把排队消息排到用户刚发/刚编辑的消息之前。deleted
    // 同理无事可做(队列已随会话清除)。interrupted/正常/失败收尾照常尝试派发,由
    // dispatchMessageQueue 的门控(占用/压缩/失败暂停/打断冻结)各自停稳。
    const abortReason = controller.signal.aborted ? abortReasonOf(controller.signal) ?? "interrupted" : null;
    const continuationOwnedByReplacer = abortReason === "replaced" || abortReason === "deleted";
    // P5:生成终局兜底清引擎状态条——压缩/重试进行中 abort/失败时,end 事件可能永远
    // 不来,不清会挂死"压缩中"。幂等,聊天引擎路径广播空集合无副作用。T1:判定改读
    // resumeSemantics——只有 run-and-suspend 引擎(pi)会发瞬态状态条,聊天引擎不发。
    if (isRunAndSuspend) broadcastEngineStatus(conversation.id, { busy: false });
    // 域4-1:审批等待注册表兜底清除——gateToolApproval 的正常路径(决定/中止)已注销,
    // 这里是"生成终局但审批仍挂着"的防御(引擎 run 因故结束而 execute 未走到注销)。
    // 幂等(delete 不存在键无副作用),与 busy:false 同点收口。
    awaitingApproval.delete(conversation.id);
    // steering 通道残留清扫:生成收尾时仍未被注入的补发(引擎无轮边界可注入:纯文本
    // 流无工具轮、pi 会话收束竞态等)直接作废——FIFO 队列仍持有同一条消息,上方
    // dispatchMessageQueue 派发兜底,零丢失。不清扫会让残留漂到下一轮生成被误注入。
    clearSteeringChannel(conversation.id);
    if (conversationStillExists(conversation.id)) {
      broadcastNodeUpdate(conversation, session.node);
      broadcastConversation(conversation);
    }
    completeConversationGeneration(conversation.id, controller);
    releaseConversation(conversation.id);
    // 生成真正结束(登记已清)→ 派发队列下一条。终局三态门控(对齐 Codex
    // ThreadIdleCause):失败已在 catch 里 pause、用户中止已在 abort 分支 hold——
    // dispatchMessageQueue 的门控让它们各自停稳;正常收尾则接续点火。被接管时跳过
    // (接管方自会续跑)。审批暂停(pause-resume 引擎的 pending 工具卡)也拦住:
    // 审批中的 turn 在 Codex 语义里仍是 active turn(start_turn_if_idle 返回 NotIdle),
    // 用户批准/拒绝后重触发的 generateAnswer 再走到这里时续派发。pi 引擎的审批在
    // execute 内挂起(generating 仍在册),generating 门已天然拦住,不到此判。
    if (!continuationOwnedByReplacer && !hasPendingToolApproval(session.message)) dispatchMessageQueue(conversation.id);
  }
}

export function ensureAssistantGenerationNode(conversation: Conversation, modelId: string): MessageNode {
  const last = conversation.messages[conversation.messages.length - 1];
  if (last?.messages[last.selectIndex]?.role === "ASSISTANT") {
    const msg = last.messages[last.selectIndex];
    msg.modelId = modelId;
    return last;
  }
  const assistantNode: MessageNode = {
    id: id(),
    messages: [message("ASSISTANT", [], modelId)],
    selectIndex: 0,
  };
  conversation.messages.push(assistantNode);
  // 新节点立即标脏:节点创建到第一个 chunk 之间存在窗口,若此窗口内导出/统计(DB-first
  // 读活库)或进程崩溃,未标脏的节点不在任何落库计划里。标脏后 flushConvDirtyNow 可见,
  // 与旧"读内存必含该节点"行为对齐。
  markMessageNodeDirty(conversation.id, assistantNode.id);
  scheduleThrottledConvFlush();
  return assistantNode;
}
