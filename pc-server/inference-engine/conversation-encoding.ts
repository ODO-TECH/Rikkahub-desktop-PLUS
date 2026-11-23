// inference-engine/conversation-encoding.ts — 会话 → 三家 Provider 请求体的编码层
// （模板变量、提示词注入、OpenAI messages / Responses API input / Google contents 构建）
// 纪律：纯搬迁自 server.ts（阶段 5.3d），行为不变。

import type { ApiMessage, Assistant, Conversation, JsonValue, Message, Model } from "../foundation/types";
import { applyPlaceholders, cloneJson, estimateTokens, getStringArray, message, renderTemplate, textFromParts } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { frozenContextBlocks } from "./context-snapshots";
import { buildSearchContext } from "../search";
import { findModel } from "../model-providers";
import { contextWindowFor, outputLimitFor } from "../model-providers/model-limits";
import { listSkills } from "../tools/skills";
import { conversationToolsWithDiscovery, toolDiscoverySystemContext } from "../tools/discovery-store";
import { GOOGLE_SAFETY_SETTINGS, apiContentFromParts, apiContentText, appendAssistantApiMessages, googleContentsFromApiMessages, googleFunctionDeclarations, googleGenerationConfig, hasBuiltInTool, hostOfProvider, responseApiMessagesFromUiMessages, supportsAbility, supportsOutputModality } from "./message-builder";
import { responsesHistoryReasoningAllowed } from "../model-providers/request-dialect";
import { isEmptyAssistantPlaceholder } from "./parts";
import { enrichMessages, templateVariables } from "./message-enrichment";
import { parseEngineCompactions, pinnedMessagesInRange, reserveTokensFor, resolveCompactionBlocks } from "./engine-compaction";
import { modelsDevCache } from "./providers";
import { readDynamicRecallBlock } from "../memory/dynamic-recall";
import { readMoodInjectionBlock } from "../mood/injection";
import { calibrationFactorFor } from "./token-calibration";

// 消息模板/时间提醒/lorebook+模式注入/滞回截断 已上收至 message-enrichment.ts
// (引擎无关层);本文件只负责"富化产物 → 三家 Provider 请求体"的编码。

function buildSkillsContext(assistant: Assistant) {
  const enabled = new Set(getStringArray(assistant.enabledSkills));
  const available = listSkills().filter((skill) => enabled.has(skill.name));
  if (available.length === 0) return "";
  const body = available
    .map((skill) => `  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n  </skill>`)
    .join("\n");
  return `**Skills**
You have access to the following skills. Use the \`use_skill\` tool to load a skill's instructions when the user's request matches.
<available_skills>
${body}
</available_skills>`;
}

/** 本轮会话模型的用量校准系数 k̂(S2)。模型解析与 conversationTransformedMessages 同源,
 *  避免"估算用 A 模型、校准查 B 模型"。无样本 → 1,判定与引入前逐字节一致。
 *  只给**判定**用(自动压缩触发/预算窗口/发送前硬闸);UI 圆环显示上游真实 usage,不乘。 */
export function contextCalibrationFactor(assistant: Assistant): number {
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  // provider 可能为空(findModel 在零供应商配置时回退 Auto):无键即无样本,k̂=1。
  return calibrationFactorFor(picked.provider?.id ?? "", picked.model.modelId);
}

/** 本轮请求携带的工具声明体积(token)。工具 schema 不在消息序列里,数消息永远数不到它
 *  ——挂满 MCP 的助手可达上万 token,漏算会让自动压缩在真实窗口早已见底时仍不触发。
 *  单源:预算 fixedTokens 与自动压缩触发估算共用本函数,口径不允许各写一份。
 *  模型不支持 TOOL 时出线 tools 为空(与 orchestrator 四处装配同判定),计 0。 */
export function toolDeclarationTokens(
  assistant: Assistant,
  model: Model,
  conversationId?: string | null,
): number {
  if (!supportsAbility(model, "TOOL")) return 0;
  const tools = conversationToolsWithDiscovery(assistant, model, conversationId);
  return tools.length > 0 ? estimateTokens(JSON.stringify(tools)) : 0;
}

/** Google generateContent 的 tools 数组:内置工具优先(目前与函数工具互斥,镜像安卓
 *  buildCompletionRequestBody:446-468),否则函数声明。导出给 S9 工具发现行的轮边界
 *  刷新复用,保证首轮与刷新同源。 */
export function googleToolsFromFunctionTools(
  functionTools: any[],
  modelItem: Model,
): Record<string, JsonValue>[] | undefined {
  const functionDeclarations = googleFunctionDeclarations(functionTools);
  const builtInTools: Record<string, JsonValue>[] = [];
  if (hasBuiltInTool(modelItem, "search")) builtInTools.push({ googleSearch: {} });
  if (hasBuiltInTool(modelItem, "url_context") || hasBuiltInTool(modelItem, "urlContext")) {
    builtInTools.push({ urlContext: {} });
  }
  return builtInTools.length
    ? builtInTools
    : functionDeclarations.length
      ? [{ functionDeclarations }]
      : undefined;
}

export function buildGoogleRequestBody(
  messagesForApi: ApiMessage[],
  modelItem: Model,
  assistant: Assistant,
  /** S9:会话 id 让工具发现行按激活集裁剪 MCP 声明;缺省 = 不裁剪(旧行为)。 */
  conversationId?: string | null,
) {
  const systemContent = messagesForApi.find((item) => item.role === "system")?.content;
  const hasImageOutput = supportsOutputModality(modelItem, "IMAGE");
  const functionTools = supportsAbility(modelItem, "TOOL")
    ? conversationToolsWithDiscovery(assistant, modelItem, conversationId)
    : [];
  const tools = googleToolsFromFunctionTools(functionTools, modelItem);
  const body: Record<string, JsonValue> = {
    // system 在图片输出模型上不发送，对齐安卓 buildCompletionRequestBody:352。
    ...(systemContent && !hasImageOutput
      ? { systemInstruction: { parts: [{ text: apiContentText(systemContent) }] } }
      : {}),
    generationConfig: googleGenerationConfig(modelItem, assistant),
    contents: googleContentsFromApiMessages(messagesForApi),
    ...(tools ? { tools } : {}),
    safetySettings: GOOGLE_SAFETY_SETTINGS,
  };
  return body;
}

// 按工具边界把 ASSISTANT 消息的 parts 分组。镜像安卓
// ai/src/main/java/me/rerere/ai/provider/providers/ProviderMessageUtils.kt 的
// groupPartsByToolBoundary：连续的"已执行 tool" parts 合为一组，与它们之前的
// content（含 reasoning）共同组成一条 assistant 消息，避免把同一个 reasoning
// 在多次 tool flush 中提前清空——这是 DeepSeek V4 thinking 模式要求每条带
// tool_calls 的 assistant 消息都必须携带 reasoning_content 的核心修复点。
//
// 本函数现在只做"选路 + system 装配 + 空占位剔除",消息加工(模板/提醒/注入/截断)
// 全部委托 message-enrichment.enrichMessages——pi 工作区引擎吃同一份裁决。
// 导出给自动压缩预检(conversations/auto-compaction.ts)复用:阈值必须按模型真实
// 收到的同一份富化产物估算(含 system / 摘要 / 注入),不能只数原始消息。
export function conversationTransformedMessages(
  conversation: Conversation,
  assistant: Assistant,
  /** dynamicRecall=true 时把按最新用户消息检索的易变召回块追加到该 USER 消息末尾。
   *  只给真实生成/压缩估算开；辅助调用（标题、翻译等）保持关闭，不带实验注入。
   *  moodInjection=true 时再把心情块追加到同一末尾（排在召回块之后）；调用方须先
   *  prepareMoodInjection，否则读不到缓存。 */
  options?: { dynamicRecall?: boolean; moodInjection?: boolean },
) {
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  // 1.5.0 跟进安卓 Migration_16_17:truncateIndex("清除上下文"分割线)机制废弃,
  // 上下文裁剪只剩两条正交机制——助手级 contextMessageLimit 切片 + 压缩对话历史。
  const visibleNodes = conversation.messages;
  // 剔除尾部"正在生成"的空 ASSISTANT 占位后再富化,见 isEmptyAssistantPlaceholder
  // 的说明(issue #16 + 工具恢复兼容)。
  const contextNodes = visibleNodes.filter((node, index) => {
    if (index !== visibleNodes.length - 1) return true;
    const selected = node.messages[node.selectIndex] ?? node.messages[0];
    return !isEmptyAssistantPlaceholder(selected);
  });
  const selectedMessages = contextNodes
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean)
    .map((msg) => cloneJson(msg));

  const conversationSystemPrompt = assistant.allowConversationSystemPrompt
    ? String(conversation.systemPrompt ?? "").trim()
    : "";
  const effectiveSystemPrompt = conversationSystemPrompt || assistant.systemPrompt.trim();
  // 专题11-P1-2:system 各区块按“稳定→易变”排列。专题12 进一步把记忆/最近会话
  // 冻结为会话级快照(context-snapshots.ts)。P6 退役:原居首的工作区段已移除——
  // 工作区可用必走 pi 会话(agent 身份由 pi 系统提示词+appendSystemPrompt 承载)。
  const systemParts = [
    effectiveSystemPrompt
      ? renderTemplate(effectiveSystemPrompt, templateVariables("", "system", assistant, picked.model))
      : "",
    buildSkillsContext(assistant),
    // S9:工具发现行的目录段(开关关闭 / 无 MCP 工具 → 空串,提示词逐字不变)。
    // 内容只随激活集变化:同一激活集下每轮稳定,不破坏前缀缓存。
    toolDiscoverySystemContext(assistant, conversation.id),
    buildSearchContext(),
    ...frozenContextBlocks(assistant, conversation.id),
  ].filter(Boolean);

  const systemMessage = systemParts.length
    ? message("SYSTEM", [{ type: "text", text: systemParts.join("\n\n") }])
    : null;

  // 压缩(P9 双引擎统一 + S5 块化):聊天引擎与 pi 共用同一份会话级记录——切点仍在
  // 选中路径的最新一条生效(编辑/fork 删掉切点行 → 记录自动失效,退回全量原文,绝不丢
  // 历史)。与 pi 的差别只在摘要承载方式:pi 把它交给引擎 appendCompaction(扁平视图,
  // 见 findEffectiveCompaction),聊天引擎把**每个生效块**各合成一条 USER 行并列注入
  // 序列最前(enrichMessages 的 compactionBlocks)。块必须首尾相接,所以"各块原位"
  // 就是序列最前,原文从最后一块的切点起逐字保留。
  const compactionBlocks = resolveCompactionBlocks(
    parseEngineCompactions(conversation.engineCompactions),
    selectedMessages,
    () => true,
  );
  // 阶段四:钉住的消息只补"本块切点之前"那部分——切点之后的钉住消息本来就在窗口里
  // 逐字可见,再注入一遍就是重复内容。工具型消息的纯文本可能为空,Skip。
  // S5:按块归属,早期摘要行不会随新压缩不断变长(前缀缓存的前提)。
  const summaryBlocks = compactionBlocks.map((block) => ({
    summary: block.record.summary,
    pinned: pinnedMessagesInRange(selectedMessages, block.startIndex, block.cutIndex)
      .map((msg) => ({ role: msg.role, text: textFromParts(msg.parts).trim() }))
      .filter((msg) => msg.text.length > 0),
  }));
  // 上下文预算(PC 专属,默认关):net 预算 = 模型真实窗口 − 压缩预留 − 系统面/工具声明。
  // fixedTokens 只覆盖发送时恒定的部分(系统提示词 + 工具 declaration JSON);注入/提醒
  // 由预留吸收。窗口未知 → 不猜,预算路不参与(与自动压缩同口径)。
  const budgetConfig = state.settings.contextBudget;
  const budgetEnabled = budgetConfig?.enabled === true;
  const systemText = systemParts.join("\n\n");
  // S4:有效窗口(模型窗口 − 本轮预留)与预算开关无关地算出来——常开应急截断要用它,
  // 出厂设置(预算关)下也必须有溢出保护。窗口未知 → null,两条路都不猜。
  // findModel 在"一个供应商都没配"时回退到 { provider: undefined, model: Auto },
  // 窗口/预留/k̂ 全都无从算起:此时两条护栏都不参与,与引入前行为一致(不能裸解引用)。
  const pickedProvider = picked.provider;
  const modelWindow = pickedProvider
    ? contextWindowFor(modelsDevCache, pickedProvider, picked.model.modelId)
    : null;
  const effectiveWindow = pickedProvider && modelWindow != null
    ? Math.max(1, modelWindow - reserveTokensFor(modelWindow, outputLimitFor(modelsDevCache, pickedProvider, picked.model.modelId)))
    : null;
  // 发送时恒定、却不在消息序列里的体积:系统提示词面 + 工具 declaration JSON。
  // 预算窗口与应急截断都要先把它扣掉,否则"消息序列刚好塞满窗口"会被误判为安全。
  const fixedTokens = (systemText ? estimateTokens(systemText) : 0)
    + toolDeclarationTokens(assistant, picked.model, conversation.id);
  // S2:窗口是"真实 token 上限",而纯函数层累加的是本地估算。真实 ≈ k̂ × 本地,
  // 所以把窗口除以 k̂ 即等价于把每条消息乘 k̂——不动纯函数层的口径。无样本时 k̂=1。
  const calibrationFactor = pickedProvider
    ? calibrationFactorFor(pickedProvider.id, picked.model.modelId)
    : 1;
  const budgetOptions = (() => {
    if (!budgetEnabled || modelWindow == null || effectiveWindow == null) return undefined;
    // S3:预留与自动压缩触发线同一函数(reserveTokensFor),两处不允许各写一份。
    const netTokens = Math.max(1, effectiveWindow - fixedTokens);
    // 至少 1:窗口被系统面/工具吃掉时也保留最后一条消息,超限由发送前硬闸报错。
    return { tokens: Math.max(1, Math.floor(netTokens / calibrationFactor)) };
  })();
  const toolAging = budgetEnabled && budgetConfig?.toolAgingEnabled === true
    ? { keepTurns: budgetConfig.toolAgingKeepTurns, excerptChars: budgetConfig.toolAgingExcerptChars }
    : undefined;
  // 工具结果头尾裁剪:PC-only 发送面能力,默认开。关闭时传 undefined,产物逐字节不变。
  const resultClipConfig = state.settings.resultClip;
  const resultClip = resultClipConfig?.enabled === true
    ? {
        thresholdChars: resultClipConfig.thresholdChars,
        headChars: resultClipConfig.headChars,
        tailChars: resultClipConfig.tailChars,
      }
    : undefined;
  const enriched = enrichMessages(selectedMessages, {
    conversation,
    assistant,
    model: picked.model,
    windowStartMessageId: compactionBlocks.at(-1)?.record.cutMessageId,
    boundaryMessageId: conversation.contextBoundaryMessageId ?? undefined,
    compactionBlocks: summaryBlocks,
    timeReminderAnchor: systemMessage ?? undefined,
    contextBudget: budgetOptions,
    toolAging,
    resultClip,
    // S4 常开:与 budgetEnabled 无关。窗口未知(effectiveWindow=null)时不传,不猜。
    emergencyWindowTokens: effectiveWindow != null
      ? Math.max(1, Math.floor((effectiveWindow - fixedTokens) / calibrationFactor))
      : undefined,
  });

  // 系统位注入(before/after_system_prompt)并入 system 面:before 在前、after 在后,
  // 与安卓 PromptInjectionTransformer 的 system 位语义一致;无 system 时注入单独成条。
  const systemWithInjections = [
    enriched.systemInjectionBefore,
    systemMessage ? textFromParts(systemMessage.parts) : "",
    enriched.systemInjectionAfter,
  ].filter(Boolean).join("\n");

  const internalMessages: Message[] = [];
  if (systemWithInjections) {
    internalMessages.push(message("SYSTEM", [{ type: "text", text: systemWithInjections }]));
  }
  internalMessages.push(...enriched.messages);
  if (options?.dynamicRecall || options?.moodInjection) {
    // 易变块贴在最新 USER 消息末尾:Google / Responses 会丢弃序列中段的
    // system 消息,尾部 SYSTEM 在三家方言里并不可靠;用户消息是唯一处处保真的插槽。
    // 召回块在前、心情块在后——先给事实,再给当下状态。
    for (let index = internalMessages.length - 1; index >= 0; index -= 1) {
      const candidate = internalMessages[index]!;
      if (candidate.role !== "USER") continue;
      let patched = candidate;
      if (options.dynamicRecall) {
        const recall = readDynamicRecallBlock(conversation.id, assistant, candidate.id);
        if (recall) patched = appendMessageText(patched, recall);
      }
      if (options.moodInjection) {
        const mood = readMoodInjectionBlock(conversation.id, assistant, candidate.id);
        if (mood) patched = appendMessageText(patched, mood);
      }
      internalMessages[index] = patched;
      break;
    }
  }
  return { messages: internalMessages, picked };
}

/** 把一段注入文本追加到消息最后一个 text part（返回副本，不改富化产物/落库消息）。 */
function appendMessageText(msg: Message, extra: string): Message {
  const parts = [...msg.parts];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (part.type !== "text") continue;
    parts[index] = { ...part, text: part.text ? `${part.text}\n\n${extra}` : extra };
    return { ...msg, parts };
  }
  parts.push({ type: "text", text: extra });
  return { ...msg, parts };
}

export function conversationMessagesForApi(
  conversation: Conversation,
  assistant: Assistant,
  // 对齐安卓 commit e63d017：OpenAI providerSetting.includeHistoryReasoning
  // 控制是否把历史 assistant 消息的 reasoning_content 回传给上游。默认 true，
  // 与安卓 ChatCompletionsAPI.buildMessages 的默认值一致。
  includeHistoryReasoning: boolean = true,
  /** 真实生成才置 true：把易变召回块追加到最新 USER 消息（见 S9）。 */
  dynamicRecall: boolean = false,
  /** 真实生成才置 true：把心情块追加到最新 USER 消息（见 mood/injection.ts）。 */
  moodInjection: boolean = false,
) {
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant, { dynamicRecall, moodInjection });

  const items: ApiMessage[] = [];
  for (const selected of transformedMessages) {
    const role = selected.role === "SYSTEM" ? "system" : selected.role === "TOOL" ? "tool" : selected.role === "ASSISTANT" ? "assistant" : "user";
    if (selected.role === "ASSISTANT") {
      appendAssistantApiMessages(items, selected, includeHistoryReasoning);
      continue;
    }
    const rawContent = textFromParts(selected.parts);
    const content = apiContentFromParts(selected.parts, rawContent, picked.model);
    if (!content) continue;
    items.push({ role, content });
  }
  return items;
}

/** Interactions 路的历史 assistant parts:与 messagesForApi 的 assistant 消息按下标
 *  对齐(两者都出自 conversationTransformedMessages 的同一次富化,顺序天然一致)。
 *  供应商签名(interactions_signature)只活在落库 parts 的 metadata 里——chat-completions
 *  形态的 messagesForApi 带不上它,Interactions 的无状态回传必须回源头取。 */
export function conversationAssistantHistoryParts(
  conversation: Conversation,
  assistant: Assistant,
  messagesForApi: ApiMessage[],
): Array<Record<string, unknown>[]> {
  const expected = messagesForApi.filter((item) => item?.role === "assistant").length;
  const { messages: transformedMessages } = conversationTransformedMessages(conversation, assistant);
  const parts: Array<Record<string, unknown>[]> = [];
  for (const selected of transformedMessages) {
    if (selected.role !== "ASSISTANT") continue;
    parts.push(selected.parts as unknown as Array<Record<string, unknown>>);
    if (parts.length >= expected) break;
  }
  return parts;
}

export function conversationResponseApiInput(
  conversation: Conversation,
  assistant: Assistant,
  /** 真实生成才置 true：易变召回块追加到最新 USER 输入项。 */
  dynamicRecall: boolean = false,
  /** 真实生成才置 true：心情块追加到最新 USER 输入项（排在召回块之后）。 */
  moodInjection: boolean = false,
) {
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant, { dynamicRecall, moodInjection });
  // 历史思考项回传方言：仅官方 OpenAI 主机（第三方 Responses 端点形态各异，火山
  // 直接 400，见 responsesHistoryReasoningAllowed 头注）；另尊重 provider 级
  // includeHistoryReasoning 开关（与 chat-completions 路径 e63d017 同语义——
  // Responses 路径只有 openai 型 provider 会走到，无需再判 type）。
  const includeReasoningItems = responsesHistoryReasoningAllowed(hostOfProvider(picked.provider))
    && picked.provider.includeHistoryReasoning !== false;
  return responseApiMessagesFromUiMessages(transformedMessages, picked.model, includeReasoningItems);
}

export function conversationResponseApiInstructions(conversation: Conversation, assistant: Assistant) {
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant);
  return transformedMessages
    .filter((item) => item.role === "SYSTEM")
    .map((item) =>
      applyPlaceholders(
        textFromParts(item.parts),
        templateVariables(textFromParts(item.parts), "system", assistant, picked.model),
      )
    )
    .filter(Boolean)
    .join("\n");
}
