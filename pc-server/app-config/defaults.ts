// app-config/defaults.ts — 出厂默认设置与默认 State（含跨端契约 ID，不可改动）
// 纪律：纯搬迁自 server.ts（阶段 5.3h），行为不变。

import type { State } from "../foundation/types";
import type { Settings } from "../foundation/types/settings";
import { defaultImAccess } from "../foundation/types/settings/im-access";
import { defaultAgentLoopConfig } from "../foundation/types/settings/agent-loop-config";
import { defaultContextBudgetConfig } from "../foundation/types/settings/context-budget-config";
import { defaultContextToolsConfig } from "../foundation/types/settings/context-tools-config";
import { defaultDebugServerConfig } from "../foundation/types/settings/debug-server-config";
import { defaultPtcConfig } from "../foundation/types/settings/ptc-config";
import { defaultResultClipConfig } from "../foundation/types/settings/result-clip-config";
import { defaultSubagentConfig } from "../foundation/types/settings/subagent-config";
import { defaultWorkspaceToolsConfig } from "../foundation/types/settings/workspace-tools-config";
import { id } from "../foundation/utils";
import { RUNNING_IN_CONTAINER } from "../foundation/platform";
import { DEFAULT_AUTO_MODEL_ID, defaultProviders } from "../model-providers";
import { DEFAULT_SYSTEM_TTS_ID, defaultTtsProviders } from "../media/tts";
import { defaultAssistant } from "../assistants";
import { defaultRequestStats } from "../api/logs";
import { DEFAULT_MEMORY_VECTOR_SETTINGS } from "../memory/vector-settings";
import { DEFAULT_MEMORY_EXPERIMENT_SETTINGS } from "../memory/experiment/config";
import { DEFAULT_MOOD_EXPERIMENT_SETTINGS } from "../mood/config";
import {
  DEFAULT_COMPRESS_PROMPT,
  DEFAULT_OCR_PROMPT,
  DEFAULT_PROMPT_OPTIMIZE_PROMPT,
  DEFAULT_SUGGESTION_PROMPT,
  DEFAULT_TITLE_PROMPT,
  DEFAULT_TRANSLATION_PROMPT,
} from "./prompts";

export const DEFAULT_LEARNING_MODE_ID = "b87eaf16-f5cd-4ac1-9e4f-b11ae3a61d74";
// 一次性下架的预置 TTS 供应商。留在 server.ts 是因为 normalizeState 仍需要它;
// 等 media/ 模块拆分后再迁走。
export const SUNSET_TTS_PROVIDER_IDS = new Set<string>([
  "e36b22ef-ca82-40ab-9e70-60cad861911c", // AiHubMix (TTS)
]);
// Mirrors `MemoryRepository.kt:11` in the original RikkaHub project. Keeping the literal
// value identical means a `state.json` produced on one platform can be imported on the
// other without losing the global-scope memory records.
// ── Analytics (anonymous DAU tracking) ────────────────────────────────────
// One ping per app start + periodic updates during the session.  Sends only:
//   device UUID, date, version, OS, cumulative message count for the day.
// No user content, no IP storage, no model names, no file names.
//
// 设计准则:
//   - 完全静默:无网络/DNS 失败/防火墙拦截都不能让用户看到任何报错
//   - 不阻塞:fetch 出错只能被 Promise 链吞掉,绝不能冒泡成 UnhandledRejection
//   - 不持久错误状态:连续失败不退避、不停跳,因为我们根本不关心是否送达

/** 默认助手系统提示词(a63d46b 起为天级 Date: {{cur_date}}——秒级 cur_datetime 会让
 *  每条消息的 system 都变,从该行起前缀缓存全部失效)。改动本串时注意 state-load 的
 *  D7 迁移链:旧串由本串反推,"与旧默认逐字相等"才替换。 */
export const DEFAULT_ASSISTANT_SYSTEM_PROMPT =
  "You are a helpful assistant, called {{char}}, based on model {{model_name}}.\n\n## Info\n- Date: {{cur_date}}\n- Locale: {{locale}}\n- Timezone: {{timezone}}\n- Device Info: {{device_info}}\n- System Version: {{system_version}}\n- User Nickname: {{user}}\n\n## Hint\n- If the user does not specify a language, reply in the user's primary language.\n- Remember to use Markdown syntax for formatting, and use latex for mathematical expressions.\n\n## Search\n- You must use English keywords when searching to get higher quality sources.\n- Chinese sources are generally of low quality.";

export function defaultSettings(): Settings {
  const assistant = defaultAssistant();
  return {
    dynamicColor: true,
    themeId: "default",
    developerMode: false,
    displaySetting: {
      userAvatar: { type: "dummy" },
      userNickname: "",
      showUserAvatar: true,
      showAssistantBubble: false,
      showModelIcon: true,
      showModelName: true,
      showTokenUsage: true,
      showThinkingContent: true,
      uiFontFamily: "Noto Sans SC",
      chatFontFamily: "",
      uiFontFamilyCss: "\"Noto Sans SC\", \"Microsoft YaHei\", sans-serif",
      chatFontFamilyCss: "",
      autoCloseThinking: true,
      codeBlockAutoWrap: false,
      codeBlockAutoCollapse: false,
      showLineNumbers: false,
      // 域13-2(交互审查 3C):默认 Enter 发送(对齐主流桌面 IM)。normalizeState 用
      // { ...defaults, ...persisted } 合并——存量用户显式保存过的 false 原样保留,
      // 本默认值只影响新装机与缺省字段回填。前端 chat-input 的 ?? true 兜底同向。
      sendOnEnter: true,
      enableAutoScroll: true,
      // 一键折叠工作步骤:开=思考链卡默认只留一行「展开 N 条工作步骤」,流式中仍露最新
      // 一条(进度可见)。PC-only 显示项,导出安卓前剥离;用户手动展开过的卡不受影响。
      collapseAllSteps: false,
      // 工具调用折成一行(Claude Code 式 trace):开=每个工具步骤默认只占一行(参数摘要 +
      // 状态徽标同行,点开才出预览)。默认开;关掉即回到旧的「每步都带内联预览」形态。
      // PC-only 显示项,导出安卓前剥离。
      toolTraceCompact: true,
      // 计划面板。开=向模型挂 update_plan 工具(多步任务时它会先发布一份步骤清单,随进度
      // 整份更新),右侧工作台把最后一条渲染成可跟随的 TODO 面板;标题行的清单入口只在真的
      // 出现过计划后才出现。默认开——与 toolTraceCompact 同为「不写即开」的常规显示项。
      // 关掉只是不再向模型声明这个工具,历史里已写下的计划照常可读。PC-only,导出安卓前剥离。
      planPanel: true,
      fontSizeRatio: 1,
      // 界面字号缩放(建议 0.85–1.20)。null = 不缩放,根字号保持浏览器默认 16px。PC-only,
      // 已在 pcOnlyDisplayFields 清单里,导出备份时剥离,Android 不可见。
      uiFontSize: null,
      pasteLongTextAsFile: false,
      pasteLongTextThreshold: 1000,
      // PC 端「粘贴超长文本转 txt」独立字段:安卓同名设置默认关、且会随备份导入覆盖,
      // 不能复用。PC 默认开、阈值 5000,导出安卓时剥离。
      pcPasteLongTextAsFile: true,
      pcPasteLongTextThreshold: 5000,
      // 朗读过滤开关(台账 §4.1):字段名 byte-match Android displaySetting,跨端备份透传。
      // 默认关 —— 角色扮演用户按需开「只读引号内」只念台词、「不读括号」跳过注释。
      ttsOnlyReadQuoted: false,
      ttsOnlyReadOutsideBrackets: false,
      // User-resizable chat input height in px (null = default min). Persisted across
      // restarts via displaySetting. PC-only — stripped before syncing to Android.
      chatInputHeight: null,
    },
    enableWebSearch: false,
    favoriteModels: [],
    chatModelId: DEFAULT_AUTO_MODEL_ID,
    fastModelId: DEFAULT_AUTO_MODEL_ID,
    // 快速模型子功能开关默认开(= 历史行为):老 state 无此字段经 normalize 回填 true,
    // 行为不变;APP 备份带来的 enableSuggestion:false 以备份为准(parsedSettings 覆盖默认)。
    enableSuggestion: true,
    titleGenerationEnabled: true,
    translateModeId: DEFAULT_AUTO_MODEL_ID,
    translateThinkingBudget: 0,
    imageGenerationModelId: "",
    ocrModelId: "",
    // DeepSeek 官方 OCR(PC-only,默认关):关闭时 OCR 只走 ocrModelId 视觉模型,与引入前逐字一致。
    // 开启即按页计费(1.5 元/1000 页),所以绝不默认开、也绝不默认带上 Key。
    deepseekOcrEnabled: false,
    deepseekOcrApiKey: "",
    deepseekOcrPurpose: "text_recognition",
    compressModelId: DEFAULT_AUTO_MODEL_ID,
    // 自动压缩默认关:它会静默调用压缩模型(可能计费),只在用户主动打开后生效。
    // 关闭时上下文接近上限仍由最后一条回复后的提示条提醒手动压缩。
    chatAutoCompact: false,
    // 子智能体(PC-only):默认关。开关/并发/任务上限/token 预算/子面工具,见
    // foundation/types/settings/subagent-config.ts(区间校验与默认值单源)。
    subagent: defaultSubagentConfig(),
    // 工作区工具面契约(PC-only):默认全关,关闭时 read/edit 输出与历史逐字一致。
    workspaceTools: defaultWorkspaceToolsConfig(),
    // 上下文预算与工具输出老化(PC-only):默认全关,关闭时请求逐字节与引入前一致。
    contextBudget: defaultContextBudgetConfig(),
    // 模型驱动的上下文工具面(PC-only,仅工作区):默认关,关闭时一个工具都不注入。
    contextTools: defaultContextToolsConfig(),
    // 本地调试端口(PC-only):默认关,开启后只绑回环。
    debugServer: defaultDebugServerConfig(),
    // 工具结果头尾裁剪(PC-only):默认开。阈值内的结果逐字节不变,超阈值只留头尾,
    // 原文仍在时间线里,可用 read_original / read 的 offset 逐字取回。
    resultClip: defaultResultClipConfig(),
    ptc: defaultPtcConfig(),
    promptOptimizeModelId: "",
    // 全局嵌入 / 重排场景档:默认未配置(空串),由用户在「设置 › 模型 › 场景模型」里
    // 从已添加的 EMBEDDING / RERANK 模型中选。两者都是「报错档」语义:没选 = 相关功能不可用。
    embeddingModelId: "",
    rerankModelId: "",
    memoryModelId: "",
    promptOptimizePrompt: DEFAULT_PROMPT_OPTIMIZE_PROMPT,
    titlePrompt: DEFAULT_TITLE_PROMPT,
    translatePrompt: DEFAULT_TRANSLATION_PROMPT,
    suggestionPrompt: DEFAULT_SUGGESTION_PROMPT,
    ocrPrompt: DEFAULT_OCR_PROMPT,
    compressPrompt: DEFAULT_COMPRESS_PROMPT,
    asrProviders: [],
    selectedASRProviderId: null,
    ttsProviders: defaultTtsProviders(),
    selectedTTSProviderId: DEFAULT_SYSTEM_TTS_ID,
    // 特性 B：外挂媒体生成。默认空供应商、无上传桶、无默认模型——功能整体处于关闭态。
    mediaGenerationProviders: [],
    uploadS3Config: null,
    defaultMediaImageModel: null,
    defaultMediaVideoModel: null,
    // 媒体提示词改写模型:默认未配置(空串),由用户在 /images 工作台顶栏选择。
    mediaPromptRewriteModelId: "",
    assistantId: assistant.id,
    providers: defaultProviders(),
    // 预置项删除墓碑(R1-12 同款,见 model-layer.ts 字段注释):老 state 无此字段 → 空墓碑,
    // 行为与旧版完全一致。
    dismissedProviderIds: [],
    dismissedAssistantIds: [],
    assistants: [
      assistant,
      {
        ...defaultAssistant(),
        id: "3d47790c-c415-4b90-9388-751128adb0a0",
        systemPrompt: DEFAULT_ASSISTANT_SYSTEM_PROMPT,
      },
    ],
    assistantTags: [],
    // 默认搜索服务清单,顺序对齐 APP SearchServiceOptions.TYPES("add provider" 选择器顺序)。
    // bing_local/rikkahub 是免测预置;其余带空 key 待用户配置。custom_js 不进默认(需写脚本,由用户手动添加)。
    searchServices: [
      { type: "bing_local", id: id(), name: "Bing" },
      { type: "rikkahub", id: id(), name: "RikkaHub", apiKey: "", depth: "standard" },
      { type: "zhipu", id: id(), name: "智谱", apiKey: "" },
      { type: "doubao", id: id(), name: "豆包", apiKey: "", mode: "custom" },
      { type: "tavily", id: id(), name: "Tavily", apiKey: "", depth: "advanced" },
      { type: "exa", id: id(), name: "Exa", apiKey: "" },
      { type: "searxng", id: id(), name: "SearXNG", url: "", engines: "", language: "" },
      { type: "linkup", id: id(), name: "LinkUp", apiKey: "", depth: "standard" },
      { type: "brave", id: id(), name: "Brave", apiKey: "" },
      { type: "metaso", id: id(), name: "秘塔", apiKey: "" },
      { type: "ollama", id: id(), name: "Ollama", apiKey: "" },
      { type: "perplexity", id: id(), name: "Perplexity", apiKey: "" },
      { type: "firecrawl", id: id(), name: "Firecrawl", apiKey: "" },
      { type: "jina", id: id(), name: "Jina", apiKey: "" },
      { type: "bocha", id: id(), name: "博查", apiKey: "" },
      { type: "grok", id: id(), name: "Grok", apiKey: "", customUrl: "https://api.x.ai/v1/responses", model: "grok-4-fast" },
      { type: "tinyfish", id: id(), name: "Tinyfish", apiKey: "" },
      { type: "serper", id: id(), name: "Serper", apiKey: "" },
      { type: "deepseek", id: id(), name: "DeepSeek", apiKey: "" },
    ],
    searchCommonOptions: { resultSize: 10 },
    searchServiceSelected: 0,
    dismissedSearchServiceTypes: [],
    mcpServers: [],
    sshDevices: [],
    imAccess: defaultImAccess(),
    modeInjections: [
      {
        type: "mode",
        id: DEFAULT_LEARNING_MODE_ID,
        name: "Learning Mode",
        enabled: true,
        priority: 0,
        position: "after_system_prompt",
        content: "Use Socratic guidance. Ask questions, give hints, and help the user build understanding.",
        injectDepth: 4,
        role: "USER",
      },
    ],
    lorebooks: [],
    quickMessages: [],
    webDavConfig: {
      url: "",
      username: "",
      password: "",
      path: "rikkahub_backups",
      items: ["DATABASE", "FILES"],
    },
    s3Config: {
      endpoint: "",
      accessKeyId: "",
      secretAccessKey: "",
      bucket: "",
      region: "auto",
      pathStyle: true,
      items: ["DATABASE", "FILES"],
    },
    // Kelivo 兼容包按细项生成，和「全部数据」完整备份不对齐，故默认关闭；开启后会锁定
    // 为细项导出（见 state-load 与 settings/kelivo-sync）。导入默认全选。
    exportKelivoBackup: false,
    kelivoSyncOptions: {
      conversations: true,
      assistants: true,
      memories: true,
      models: true,
      worldBooks: true,
      promptInjections: true,
      quickMessages: true,
      searchServices: true,
    },
    // 「全部数据」默认开启：与上游桌面端的完整备份一致，忽略下面的逐项开关。
    backupAllData: true,
    // 关闭「全部数据」后才生效的逐项选择；默认全开（= 与旧版无选择性备份逐字节等价）
    backupScope: {
      conversations: true,
      assistants: true,
      memories: true,
      models: true,
      worldBooks: true,
      promptInjections: true,
      quickMessages: true,
      searchServices: true,
      attachments: true,
      skills: true,
      fonts: true,
      globalAgents: true,
    },
    proxyConfig: {
      // 容器部署默认 env(docker 注入 HTTPS_PROXY); 桌面默认 auto(跟随系统代理)
      mode: RUNNING_IN_CONTAINER ? "env" : "auto",
      url: "",
      username: "",
      password: "",
      bypassRules: "",
    },
    webServerJwtEnabled: false,
    preferredPort: null,
    // 受限沙盒默认关(S2b):开启即"agent 只能写工作区与数据目录,其余位置只读"——
    // 重启时经 workspace/restricted-launch.ts 标注目录并降级自重启,改动才会生效。
    sandboxRestricted: false,
    // 额外可写目录(全局):受限档下给技能工具等声明的沙盒例外;空 = 只有数据目录与工作区可写。
    sandboxExtraWritableDirs: [],
    workspaceLastPermissionPreset: null,
    shellPath: "",
    keybindings: {
      newConversation: { keys: ["Ctrl", "N"], enabled: true },
      prevConversation: { keys: ["Alt", "Up"], enabled: true },
      nextConversation: { keys: ["Alt", "Down"], enabled: true },
      renameConversation: { keys: ["F2"], enabled: true },
      searchConversations: { keys: ["Ctrl", "Shift", "F"], enabled: true },
      toggleFilesPanel: { keys: ["Ctrl", "Shift", "E"], enabled: true },
      openSettings: { keys: ["Ctrl", ","], enabled: true },
      openImageGeneration: { keys: ["Ctrl", "I"], enabled: true },
      // 滚轮缩放:binding 固定为 Ctrl+Wheel,无法录制,只有 enabled 开关。
      zoomInOut: { enabled: true },
    },
    // 默认开启全局记忆层(叠加注入开箱可用)。老用户迁移时由 normalizeState 的 M1 逻辑
    // 推断:若所有助手 enableMemory=false,改为 false(避免被动注入全局记忆)。
    memorySettings: {
      globalEnabled: true,
      writeStrategy: "ask",
      dedupEnabled: true,
      memoryModelThinkingEnabled: false,
    },
    // 特性 C：默认关闭——零网络请求，注入行为与未引入时逐字节一致。
    memoryVectorSettings: { ...DEFAULT_MEMORY_VECTOR_SETTINGS },
    // 实验：记忆与上下文的失真/遗忘。默认全关 + dry-run，关闭时零副作用。
    memoryExperimentSettings: { ...DEFAULT_MEMORY_EXPERIMENT_SETTINGS },
    // 实验：心情状态。默认全关 + dry-run，关闭时不判定、不调模型、不写库。
    moodExperimentSettings: { ...DEFAULT_MOOD_EXPERIMENT_SETTINGS },
    // 实验：自主循环。默认关闭，关闭时运行记录/判定/重试全部不生效(零行为差)。
    agentLoop: defaultAgentLoopConfig(),
  };
}

export function defaultState(): State {
  return {
    settings: defaultSettings(),
    conversations: [],
    files: [],
    generatedImages: [],
    generatedMedia: [],
    logs: [],
    stats: defaultRequestStats(),
    nextFileId: 1,
    nextGeneratedImageId: 1,
    launchCount: 0,
  };
}
