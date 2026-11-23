// inference-engine/message-enrichment.ts — 会话消息 → 模型视野的引擎无关富化层
//
// 定位:把"DB 里用户写的消息"变成"模型该看到的消息"的全部文本加工集中在一处,
// 聊天引擎(conversation-encoding)与 pi 工作区引擎(orchestrator → context-encoder)
// 共用同一份裁决——四件套(消息模板/时间提醒/lorebook+模式注入/上下文窗口化)
// 从此与"谁跑 agent 循环"无关。新增引擎接进来的唯一义务:先过 enrichMessages,
// 再按自己的协议编码。窗口化 = 滞回截断 ∨ 压缩切点锚(P9:pi 的压缩切点经
// windowStartMessageId 接入同一入口——注入行恒在窗口内、恒在切点之后,聊天位
// 注入/时间提醒在两种模式下逐字生效)。
//
// 幂等纪律(双引擎分层的接缝):注入/提醒产生的是合成消息,不写 DB——pi 每轮从
// DB 原文重新富化,注入语义"每次生成重新裁决"不变(安卓 PromptInjectionTransformer
// 同语义),DB 里永远不会沉淀出第二条 lorebook 正文。EnrichResult 用 syntheticIds
// 显式列出它们的 id——pi 生成路径把富化全序列(含合成行)灌进引擎,编码器据 id
// 把合成行挡在压缩切点映射与退化诊断之外(context-encoder 头注);手动压缩则经
// encodableMessages 剥回纯真实行(注入是配置不是对话,不进用户策展的摘要)。
// 消息对象本身零改动(不挂 metadata 标记,不扩 Message 类型)。
//
// 稳定→易变排序的缓存哲学与 conversationTransformedMessages 一致:系统位注入
// (before/after_system_prompt)不进本层消息序列,由调用方并入各自的系统提示词面
// (聊天引擎:internalMessages[0];pi:appendSystemPrompt 条目),保证聊天位序列稳定。

import type { Assistant, Conversation, JsonValue, Message, MessagePart, Model } from "../foundation/types";
import { applyPlaceholders, cloneJson, getStringArray, message, textFromParts } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { ageToolOutputs, budgetStartFor } from "./context-budget";
import { emergencyTruncateToolOutputs } from "./emergency-truncate";
import { clipToolResults, type ResultClip } from "./result-clip";
import {
  activePromptInjections as activePromptInjectionsCore,
  applyMessageTemplateToParts,
  applyPromptInjectionsToMessages,
  templateVariables as templateVariablesCore,
} from "../assistants";

// ---- 模板变量(与 conversation-encoding.templateVariables 同一装配,集中到此) ----

export function templateVariables(messageText: string, role: string, assistant: Assistant, modelItem: Model, at?: Date) {
  return templateVariablesCore(
    messageText,
    role,
    assistant,
    modelItem,
    String(state.settings.displaySetting.userNickname ?? "").trim() || "User",
    at,
  );
}

// ---- 时间提醒(逐字搬迁自 conversation-encoding.timeReminderContent) ----

function messageTimestamp(msg: Message): Date | undefined {
  const parsed = Date.parse(String(msg.createdAt ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

// 间隔超过该阈值才在 USER 消息前补时间提醒(首条恒提醒)。刻意硬编码不开放给用户:
// 这是感知类节奏阈值,用户无需感知;10min 对齐桌面 IM 场景(APP 出厂默认 60min 偏久,
// 间隔 10min~1h 的回来接着聊才是桌面高频)。可调则必须补分钟级文案分支。
const TIME_REMINDER_GAP_THRESHOLD_SECONDS = 10 * 60;

function timeReminderContent(current: Message, previous?: Message) {
  const currentTime = new Date(current.createdAt);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(currentTime);
  const timeText = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(currentTime);
  if (!previous) return `<time_reminder>Current time: ${weekday}, ${timeText}</time_reminder>`;
  const gapSeconds = Math.floor((Date.parse(current.createdAt) - Date.parse(previous.createdAt)) / 1000);
  // createdAt 不可解析时 gapSeconds 为 NaN(NaN<=阈值 为 false),原实现会输出 "NaN d",
  // 用否定式条件一并挡掉。三档文案与 APP TimeReminderTransformer.formatGap 一致(min/h/d)。
  if (!(gapSeconds > TIME_REMINDER_GAP_THRESHOLD_SECONDS)) return "";
  const gapText =
    gapSeconds < 3600
      ? `${Math.floor(gapSeconds / 60)} min`
      : gapSeconds < 86400
        ? `${Math.floor(gapSeconds / 3600)} h`
        : `${Math.floor(gapSeconds / 86400)} d`;
  return `<time_reminder>Current time: ${weekday}, ${timeText} (${gapText} since last message)</time_reminder>`;
}

/** 在 USER 消息前插时间提醒(首条 USER 恒提醒,后续间隔 >10min 提醒)。
 *  previousUserMessage: 调用方若已把 system 等前缀拼在序列前,传最后一条非 USER
 *  消息作为"首条 USER 的前一条"基准,保持与聊天引擎原语义(首条提醒看 gap)一致。
 *  返回新数组;提醒消息是新对象,调用方经 EnrichResult.syntheticIds 识别。 */
export function applyTimeReminders(
  messages: Message[],
  assistant: Assistant,
  previousUserMessage?: Message,
): { messages: Message[]; syntheticIds: Set<string> } {
  if (!assistant.enableTimeReminder) return { messages, syntheticIds: new Set() };
  const out: Message[] = [];
  const syntheticIds = new Set<string>();
  let firstUserReminderInjected = false;
  let previous = previousUserMessage;
  for (const selected of messages) {
    if (selected.role === "USER") {
      const reminder = timeReminderContent(selected, firstUserReminderInjected ? previous : undefined);
      if (reminder) {
        const reminderMessage = message("USER", [{ type: "text", text: reminder }]);
        syntheticIds.add(reminderMessage.id);
        out.push(reminderMessage);
      }
      firstUserReminderInjected = true;
    }
    out.push(selected);
    previous = selected;
  }
  return { messages: out, syntheticIds };
}

// ---- lorebook / 模式注入 ----

export interface ConversationInjectionOverride {
  modeInjectionIds: string[];
  lorebookIds: string[];
}

/** 生效注入集合(专题9:助手允许会话级绑定时,生效 id 集完全来自会话)。 */
export function activePromptInjections(
  conversation: Conversation,
  assistant: Assistant,
  messages: Message[],
): Array<Record<string, JsonValue>> {
  const override = assistant.allowConversationPromptInjection === true
    ? {
        modeInjectionIds: getStringArray(conversation.modeInjectionIds),
        lorebookIds: getStringArray(conversation.lorebookIds),
      }
    : undefined;
  return activePromptInjectionsCore(assistant, messages, state.settings.lorebooks, state.settings.modeInjections, override);
}

/** 注入按位置分两路:系统位(before/after_system_prompt)返回文本,由调用方并入
 *  系统提示词面;聊天位(top/bottom/at_depth)走 applyPromptInjectionsToMessages
 *  插队,插队消息带 enrich:synthetic 标记。 */
export function splitInjectionsByPlacement(injections: Array<Record<string, JsonValue>>) {
  const system = injections.filter((injection) => {
    const position = String(injection.position ?? "").toLowerCase();
    return position === "before_system_prompt" || position === "after_system_prompt";
  });
  const chat = injections.filter((injection) => {
    const position = String(injection.position ?? "").toLowerCase();
    return position !== "before_system_prompt" && position !== "after_system_prompt";
  });
  return { system, chat };
}

// ---- 消息模板(占位符 + 模板包装,逐消息应用) ----

/** 对单条消息应用占位符(非 ASSISTANT 的 {{message}} 等)与模板包装。
 *  与 conversation-encoding 里两条消费路径(OpenAI messages / Responses input)
 *  共用的 per-message 加工,抽出来供 pi 编码器复用。 */
export function applyTemplateToMessage(
  selected: Message,
  template: string,
  role: string,
  assistant: Assistant,
  modelItem: Model,
): MessagePart[] {
  const rawContent = textFromParts(selected.parts);
  const messageAt = messageTimestamp(selected);
  if (selected.role === "ASSISTANT") {
    // 助手消息无占位符展开(rawContent 不进模板变量),只套模板。
    return applyMessageTemplateToParts(selected.parts, "assistant", template, messageAt);
  }
  const placeholderParts = selected.parts.map((part) =>
    part.type === "text"
      ? { ...part, text: applyPlaceholders(String(part.text ?? ""), templateVariables(rawContent, role, assistant, modelItem, messageAt)) }
      : part,
  );
  return applyMessageTemplateToParts(placeholderParts, role, template, messageAt);
}

// ---- 上下文滞回截断(专题11-P2-1) ----

/** 滞回窗口起点:limit>0 且超长时,起点按步长 S=ceil(limit×0.2) 量化前移。
 *  与 conversationTransformedMessages 同一公式,抽出来供两引擎共用。 */
export function truncationStartFor(messageCount: number, contextLimit: number): number {
  if (!(contextLimit > 0) || messageCount <= contextLimit) return 0;
  const step = Math.max(1, Math.ceil(contextLimit * 0.2));
  return Math.floor((messageCount - contextLimit) / step) * step;
}

/** 已执行工具 = 有 output(与安卓 UIMessagePart.Tool.isExecuted 同义:output.isNotEmpty())。 */
function toolPartExecuted(part: MessagePart): boolean {
  return part.type === "tool" && Array.isArray(part.output) && part.output.length > 0;
}

/** 截断起点回退到安全边界,避免把 tool call 与其 result 拆散、或让上下文从半截工具
 *  调用开始——对齐安卓 limitContext 的 alignContextStart。滞回/锚点起点是纯算术,不看
 *  消息内容,可能恰好压在一对工具中间;一旦切开,编码侧会把"无对应 call 的 tool result"
 *  发给上游,OpenAI/Claude 直接 400,且因前缀稳定会连续多轮 400。
 *
 *  只向前(下标减小)调整,因此不破坏"最多保留 limit 条"的下界;调整只依赖 [0,start)
 *  区间,这部分对追加消息稳定。判定规则(与安卓一致):
 *   R1 起点消息含已执行 tool → 其 call 在更早处已被切掉,往前找到那条"尚未执行(纯 call)"
 *      的消息作为新起点(即这次调用真正的发起处)。
 *   R2 起点消息含未执行 tool(纯 call) → 它是某次工具链的发起,往前归并到触发它的最近
 *      一条 USER(工具链入口)。 */
export function alignContextStart(messages: Message[], start: number): number {
  let adjusted = Math.min(start, messages.length);
  const visited = new Set<number>();
  let needsAdjustment = true;
  while (needsAdjustment && adjusted > 0) {
    needsAdjustment = false;
    if (visited.has(adjusted)) break; // 防御:环则停(正常路径不会触发)
    visited.add(adjusted);
    const current = messages[adjusted];
    if (!current) break;
    const tools = current.parts.filter((p): p is Extract<MessagePart, { type: "tool" }> => p.type === "tool");
    // R1:当前含已执行 tool → 往前找对应的纯 call(未执行 tool)
    if (tools.some((t) => toolPartExecuted(t))) {
      for (let i = adjusted - 1; i >= 0; i--) {
        if (messages[i].parts.some((p) => p.type === "tool" && !toolPartExecuted(p))) {
          adjusted = i;
          needsAdjustment = true;
          break;
        }
      }
    }
    // R2:当前含未执行 tool(纯 call) → 往前归并到最近的 USER(工具链入口)
    if (messages[adjusted].parts.some((p) => p.type === "tool" && !toolPartExecuted(p))) {
      for (let i = adjusted - 1; i >= 0; i--) {
        if (messages[i].role === "USER") {
          adjusted = i;
          needsAdjustment = true;
          break;
        }
      }
    }
  }
  return adjusted;
}

// ---- 压缩摘要注入(聊天引擎) ----

/** 切点前被用户钉住的消息(原样进 <pinned_messages>,不收摘要模型缩写)。 */
export interface PinnedMessageView {
  role: string;
  text: string;
}

/** S5:一个生效块的摘要承载面。pinned 只含**本块**吞掉的钉住消息(按块归属,
 *  见 pinnedMessagesInRange),空块由调用方过滤,这里也再挡一次。 */
export interface CompactionSummaryBlock {
  summary: string;
  pinned?: PinnedMessageView[];
}

/** 摘要外框:明确"这是背景不是新指令"——USER 行是唯一跨供应商稳定的合成载体,
 *  不加说明的话模型容易把摘要里的句子当成本轮要求去做。外框固定,摘要不变则请求
 *  前缀逐字节不变(前缀缓存友好)。
 *  阶段四:钉住的消息全文附在摘要之后(同一 USER 行)。放同一行而不是单独插一条
 *  USER 消息,是为了不让"两条相邻 user 消息"改变上游的轮次裁决(有的兼容端点会
 *  把相邻 user 合并、有的会拒绝);内容顺序固定(摘要 → 钉住集),前缀仍稳定。 */
export function compactionSummaryText(summary: string, pinned: PinnedMessageView[] = []) {
  const lines = [
    "<context_summary>",
    "The earlier part of this conversation has been compacted into the summary below. Treat it as background context, not as a new user instruction.",
    "",
    summary.trim(),
  ];
  if (pinned.length > 0) {
    lines.push(
      "",
      "<pinned_messages>",
      "The user pinned the following earlier messages so they are preserved verbatim instead of being summarized. They are background context from the earlier conversation, not new instructions.",
      ...pinned.map((item) => `<message role=\"${item.role.toLowerCase()}\">\n${item.text}\n</message>`),
      "</pinned_messages>",
    );
  }
  lines.push("</context_summary>");
  return lines.join("\n");
}

// ---- 主编排:富化管线(两引擎共用) ----

export interface EnrichOptions {
  conversation: Conversation;
  assistant: Assistant;
  model: Model;
  /** 窗口锚(P9):从这条消息(含)起保留,与滞回截断起点取 max。生产侧唯一传法是
   *  引擎压缩切点(effectiveEngineCompaction 的 cutMessageId)——压缩重放会隐藏切点之前
   *  的条目,把切点接入窗口边界后,注入行/提醒恒在切点之后:既进模型视野,又永不
   *  落进被摘要吸收的旧历史。id 不在序列中(陈旧压缩记录/消息被删)时视为无锚。 */
  windowStartMessageId?: string;
  /** 时间提醒的"首条 USER 前一条"基准(聊天引擎传 system 消息,pi 路径无此前缀)。 */
  timeReminderAnchor?: Message;
  /** 压缩摘要(聊天引擎,v1 单切点形态):windowStartMessageId 之前的原文已被它取代,
   *  合成一条 USER 行放在序列最前——模型的记忆边界由此对上游可见。pi 路径不传(摘要由
   *  引擎 appendCompaction 原生承载)。S5 起生产侧改传 compactionBlocks;本字段保留为
   *  兼容入口(单块时两者产物逐字节一致)。 */
  compactionSummary?: string;
  /** 阶段四:切点之前被用户钉住的消息(已渲染为纯文本),随摘要行原样注入。
   *  只在 compactionSummary 存在时有意义——没有压缩就没有"被摘要吞掉"的风险,
   *  钉住的消息本来就在序列里逐字可见。 */
  pinnedMessages?: PinnedMessageView[];
  /** S5 块化摘要(聊天引擎):每块一行,按锚点顺序并列放在序列最前,原文从最后一块的
   *  切点起保留(块必须首尾相接,见 resolveCompactionBlocks 的连续性纪律)。
   *
   *  为什么不把摘要行插回各块 startMessageId 的"原位":生效块是连续平铺的,中间没有
   *  原文缝隙,所以"原位"必然就是序列最前——并列 unshift 与就地锚定产物相同,却能让
   *  老化/应急截断/预算头切/模板/提醒/注入整条管线继续只作用于真实原文,与 v1 逐字节
   *  一致(摘要不套模板、不带时间提醒、不参与 lorebook 匹配、不被预算切掉)。
   *
   *  前缀稳定性:第 i 行的文本只由第 i 块的记录决定,追加新块不改写任何旧行——
   *  这是 v1"每次压缩重写一份链式摘要"做不到的。 */
  compactionBlocks?: CompactionSummaryBlock[];
  /** 上下文边界锚(PC 专属,S7):从这条消息(含)起保留。来源见
   *  Conversation.contextBoundaryMessageId(安卓检查点 / Kelivo truncate_index)。
   *  与滞回起点、压缩锚、预算起点一并取 max;id 不在序列中视为无边界。 */
  boundaryMessageId?: string;
  /** 上下文预算窗口(PC 专属,默认关):net tokens = 模型窗口 − 预留 − 系统面/工具声明。
   *  与滞回起点、压缩锚一并取 max;0/缺省 = 不参与(行为与引入前一致)。
   *  S4b 起按**老化 + 应急截断之后**的体积裁决(见管线 1.4):头切删整条消息,
   *  截断只缩工具输出,先截断能让同样的预算保住更多历史。 */
  contextBudget?: { tokens: number };
  /** 工具输出老化(PC 专属,默认关):只改编码产物,原文与压缩记录不动。 */
  toolAging?: { keepTurns: number; excerptChars: number };
  /** 工具结果头尾裁剪(常开,可关):只作用于发送面,DB 原文不动。
   *  与 toolAging 独立:老化看"第几轮之前",裁剪看"这条有多长"。 */
  resultClip?: ResultClip;
  /** 常开应急截断(压缩 v2 · S4):有效窗口 = 模型窗口 − 本轮预留。占用 ≥95% 时无条件
   *  截短最大的旧工具输出。**与 contextBudget.enabled 无关**——出厂设置下也必须有溢出
   *  保护,否则"没开预算"就等于"没有任何护栏"。窗口未知时调用方不传(不猜)。
   *  占用按结构窗口计(锚已生效、预算未生效),且跑在预算头切之前(S4b)。
   *  只接生成路径:手动压缩的摘要要覆盖真实原文,不能被截断产物污染。 */
  emergencyWindowTokens?: number;
}

export interface EnrichResult {
  /** 富化后的消息序列(系统位注入不在内——那是系统提示词面的事)。 */
  messages: Message[];
  /** 系统位注入文本(before/after 已按序拼接;调用方并入系统提示词面)。 */
  systemInjectionBefore: string;
  systemInjectionAfter: string;
  /** 命中的注入条目(诊断/测试断言用)。 */
  injections: Array<Record<string, JsonValue>>;
  /** 本轮产生的合成消息 id(时间提醒/聊天位注入);生成路径随全序列灌进 pi 编码器
   *  (挡在切点映射/退化诊断之外),手动压缩路径经 encodableMessages 剥除。 */
  syntheticIds: Set<string>;
  /** 窗口起点(0 = 全量;>0 = 前 n 条未进本次请求)。供诊断/徽标使用。 */
  windowStart: number;
  /** 工具输出老化结果(0 = 未老化)。 */
  agedToolParts: number;
  agedToolBytes: number;
  /** 工具结果头尾裁剪(0 = 无超阈值结果)。chars = 被丢弃的中段字符总数。 */
  clippedToolParts: number;
  clippedToolChars: number;
  /** 常开应急截断结果(0 = 本轮产物里没有截断占位)。含 latch 重放。 */
  emergencyTruncatedParts: number;
  emergencySavedTokens: number;
}

/** 消息富化主管线:结构窗口(滞回截断 ∨ 压缩切点锚 ∨ 上下文边界) → 工具老化 →
 *  常开应急截断 → 预算头切 → 模板/占位符 → 时间提醒 → 注入(聊天位)。系统位注入单列
 *  返回。产物 messages 已完成模板渲染——调用方(聊天编码器/pi 编码器)直接消费,
 *  不得再套 applyMessageTemplateToParts,否则 {{message}} 会被双重包装。纯函数:
 *  不改 conversation/assistant,合成消息 id 经 syntheticIds 显式返回。 */
export function enrichMessages(baseMessages: Message[], options: EnrichOptions): EnrichResult {
  const { conversation, assistant, model } = options;
  const template = assistant.messageTemplate?.trim() || "{{ message }}";

  // 1. 结构窗口:滞回截断、压缩切点锚、上下文边界三者取 max(锚不在序列中视为无锚)。
  //    预算起点刻意**不**在这里算——它必须看"老化 + 应急截断之后"的体积(S4b,见 1.4)。
  //    与聊天引擎"先截断、后提醒/注入"同序——合成行天然落在窗口内、压缩切点之后。
  const hysteresisStart = truncationStartFor(baseMessages.length, assistant.contextMessageLimit);
  const anchorIndex = options.windowStartMessageId
    ? baseMessages.findIndex((msg) => msg.id === options.windowStartMessageId)
    : -1;
  // S7 上下文边界(安卓检查点 / Kelivo truncate_index):与压缩锚同权,只影响窗口起点。
  const boundaryIndex = options.boundaryMessageId
    ? baseMessages.findIndex((msg) => msg.id === options.boundaryMessageId)
    : -1;
  const structuralRaw = Math.max(
    hysteresisStart,
    anchorIndex >= 0 ? anchorIndex : 0,
    boundaryIndex >= 0 ? boundaryIndex : 0,
  );
  // 算术起点经 alignContextStart 回退:保证切点不劈开任何 tool call/result 配对
  // (对齐安卓 limitContext),否则编码侧会发出"无 call 的孤儿 result"触发上游 400。
  // floor 是最终起点的**下界**:预算只会把起点往后推,所以先按 floor 加工消息,
  // 最终窗口里的每一条都必定经过老化与应急截断(不会出现"半加工"的尾巴)。
  const floor = alignContextStart(baseMessages, structuralRaw);
  const floorMessages = floor > 0 ? baseMessages.slice(floor) : baseMessages;

  // 1.15 工具结果头尾裁剪(常开,可关):按"这条有多长"裁,与轮次/窗口余量无关——
  //      50 KB 的 bash 输出从这里开始就不进请求。放在老化之前:老化按轮次折成更短的
  //      占位,裁剪先做不改变老化判定(老化看的是消息序号,不看长度);反过来先老化再
  //      裁剪则会给占位再做一次无意义的长度判断。阈值内逐字节不变(返回原数组)。
  const clippedResult = options.resultClip ? clipToolResults(floorMessages, options.resultClip) : null;
  const floorClipped = clippedResult ? clippedResult.messages : floorMessages;

  // 1.2 工具输出老化(只改编码产物):折叠过旧结果,占位仍留在 output 数组里,
  //     toolPartExecuted 语义与工具配对不变量不变。保护集是"从尾往前数 K 个含工具
  //     的消息",与前端切掉多少条无关,故放在头切之前对存活消息逐字节等价。
  const aged = options.toolAging ? ageToolOutputs(floorClipped, options.toolAging) : null;
  const visible = aged ? aged.messages : floorClipped;

  // 1.3 常开应急截断(S4):在老化之后、头切与模板之前。与老化的顺序有讲究——老化先把
  //     过旧结果折叠成短占位,应急截断只需处理"折叠后仍然塞满窗口"的残余;反过来先截断
  //     再老化会把截断标记当成原文再折一次。摘要行此刻还不存在(第 5 步才 unshift),
  //     天然不会被截。占用按**结构窗口**计(锚已生效、预算未生效):压缩锚已排除的历史
  //     不该把占用抬高,而预算即将丢弃的历史正是截断要抢救的对象。
  const emergency = options.emergencyWindowTokens
    ? emergencyTruncateToolOutputs(visible, { windowTokens: options.emergencyWindowTokens })
    : null;
  const guarded = emergency ? emergency.messages : visible;

  // 1.4 预算头切(S4b:必须在应急截断**之后**)。实机验收纠正的顺序缺陷:头切删的是
  //     **整条消息**,截断只把超大工具输出缩成头尾 + 标记。先头切时,一条本可缩到
  //     几千 token 的工具消息会被整条丢掉(连同它前面为凑预算而牺牲的历史);先截断
  //     则同样占用下保住全部消息与工具输出的头尾——严格更少破坏。
  //     预算路只在调用方明确传入时参与(默认关,关闭时该值为 0,结果与引入前逐字节一致)。
  const budgetStart = options.contextBudget?.tokens
    ? budgetStartFor(guarded, options.contextBudget.tokens)
    : 0;
  const rawStart = Math.max(structuralRaw, floor + budgetStart);
  // 夹到 floor:alignContextStart 只向前回退且 floor 自身是安全边界不动点,正常路径
  // 不会低于它;但 align 并非严格单调(见其头注 R1/R2 的"最近前驱"搜索),夹一道把
  // "最终窗口 ⊆ 已加工区间"变成不变量而不是推论。夹到的仍是安全边界,不劈配对。
  const start = Math.max(floor, alignContextStart(baseMessages, rawStart));
  const windowed = guarded.slice(start - floor);

  // 2. 模板/占位符逐消息渲染(一次到位:pi 编码器与聊天编码器吃同一份渲染产物)。
  const templated = windowed.map((msg) => {
    const role = msg.role === "SYSTEM" ? "system" : msg.role === "TOOL" ? "tool" : msg.role === "ASSISTANT" ? "assistant" : "user";
    return { ...msg, parts: applyTemplateToMessage(msg, template, role, assistant, model) };
  });

  // 3. 时间提醒(在模板之后、注入之前——提醒本身不套模板,与聊天引擎现状一致)。
  const { messages: withReminders, syntheticIds: reminderIds } = applyTimeReminders(
    templated,
    assistant,
    options.timeReminderAnchor,
  );

  // 4. lorebook/模式注入:系统位文本抽出,聊天位消息插队(合成 id 并入返回集)。
  const injections = activePromptInjections(conversation, assistant, withReminders);
  const { system, chat } = splitInjectionsByPlacement(injections);
  const withRemindersIds = new Set(withReminders.map((msg) => msg.id));
  const injected = applyPromptInjectionsToMessages(withReminders, chat);
  const syntheticIds = new Set(reminderIds);
  for (const msg of injected) {
    if (!withRemindersIds.has(msg.id)) syntheticIds.add(msg.id);
  }

  // 5. 压缩摘要(聊天引擎):切点之前的原文根本不在序列里,摘要就是模型对早期对话的
  //    全部记忆。放在提醒/注入裁决之后:
  //    - 不套消息模板、不带时间提醒(摘要是压缩产物,没有"消息时间");
  //    - 不参与 lorebook 关键词匹配(它不该二次触发注入);
  //    - 排在 top_of_chat 注入之前——它是被取代的历史,不是本轮配置。
  //    合成行每次生成从 DB 记录重建,不落库(幂等)。
  //    S5:生效块不止一个时逐块成行(按锚点顺序),每行文本只由本块记录决定——
  //    追加新块不改写旧行,出站前缀逐字节稳定。单块时与 v1 产物完全一致。
  const summaryBlocks = options.compactionBlocks?.length
    ? options.compactionBlocks
    : options.compactionSummary?.trim()
      ? [{ summary: options.compactionSummary, pinned: options.pinnedMessages }]
      : [];
  const summaryMessages = summaryBlocks
    .filter((block) => block.summary?.trim())
    .map((block) => message("USER", [
      { type: "text", text: compactionSummaryText(block.summary, block.pinned) },
    ]));
  for (const summaryMessage of summaryMessages) syntheticIds.add(summaryMessage.id);
  // 整组 unshift 保持块序(逐条 unshift 会把顺序颠倒)。
  if (summaryMessages.length > 0) injected.unshift(...summaryMessages);

  const systemTextOf = (position: string) =>
    system
      .filter((injection) => String(injection.position ?? "").toLowerCase() === position)
      .map((injection) => String(injection.content ?? "").trim())
      .filter(Boolean)
      .join("\n");

  return {
    messages: injected,
    systemInjectionBefore: systemTextOf("before_system_prompt"),
    systemInjectionAfter: systemTextOf("after_system_prompt"),
    injections,
    syntheticIds,
    windowStart: start,
    agedToolParts: aged?.agedParts ?? 0,
    agedToolBytes: aged?.agedBytes ?? 0,
    clippedToolParts: clippedResult?.clippedParts ?? 0,
    clippedToolChars: clippedResult?.clippedChars ?? 0,
    emergencyTruncatedParts: emergency?.truncatedParts ?? 0,
    emergencySavedTokens: emergency?.savedTokens ?? 0,
  };
}

/** 手动压缩路径专用:把富化产物剥回"可编码"的纯真实行(P9 起生成路径不再剥——
 *  合成消息随全序列灌进 pi 引擎,聊天位注入/时间提醒在工作区会话同样生效)。
 *  手动压缩的摘要应只覆盖真实对话:注入是配置不是对话,提醒只描述节奏,均不进
 *  用户策展的摘要。 */
export function encodableMessages(enriched: Message[], syntheticIds: Set<string>): Message[] {
  return enriched.filter((msg) => !syntheticIds.has(msg.id)).map((msg) => cloneJson(msg));
}
