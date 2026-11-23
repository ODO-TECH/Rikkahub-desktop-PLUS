export interface ModelConfig {
  favoriteModels: string[];
  chatModelId: string;
  // 快速模型(对齐 APP 2.4.16):标题生成、建议回复等轻量后台任务统一走这一个模型。
  // 取代旧版独立的 titleModelId / suggestionModelId(已被 fastModelId 收敛,见 state-load 回填)。
  fastModelId: string;
  // 快速模型两个子功能的各自开关(默认开)。enableSuggestion 与 APP Settings 数据类同名字段
  // 逐字节对齐(备份双向互通:手机关掉建议,导入 PC 后 PC 也关);titleGenerationEnabled 是
  // PC 先行字段(APP 尚无,导出时 APP 安全忽略,将来可同名对齐)。开关只决定「配了快速模型后
  // 该子功能跑不跑」:标题关 = 退回未配模型的行为(首条消息文本命名),建议关 = 不生成。
  enableSuggestion: boolean;
  titleGenerationEnabled: boolean;
  translateModeId: string;
  imageGenerationModelId: string;
  ocrModelId: string;
  // ── DeepSeek 官方 OCR（PC-only：安卓 Settings 无对应字段，跨端导出整键剥离）──────────
  // 语义是「换 OCR 引擎」，不是「多一个场景档」：开启后图片与「本地读不出字」的文档
  // 附件都改调官方 POST /v1/tools/ocr，`ocrModelId` 退为失败时的回落引擎（见 §3 决策）。
  // 默认关——关闭时 OCR 行为与引入前逐字一致（房规 §5「新能力默认关」）。
  // 计费：1.5 元/1000 页，按识别成功的页数计，客户端断开不取消识别、完成的照常计费。
  deepseekOcrEnabled: boolean;
  /** 官方 API Key。空串 = 未配置：此时不静默回落，直接给人话错误（凭据口径见 docs/plan-deepseek-tools.md §3）。 */
  deepseekOcrApiKey: string;
  /** 官方 purpose：text_recognition（默认，不含图片的 Word/PPT 直接提字、其余逐页）
   *  | rich_layout_recognition（一律逐页，保留版式标记与坐标）。值域外的写入按默认落。 */
  deepseekOcrPurpose: string;
  compressModelId: string;
  // 聊天模式自动压缩(PC 独有):生成前若上下文估算越过 contextWindow - reserveTokens,
  // 先按与手动压缩完全相同的记录/编码路径压一次再发请求。默认关——压缩会调用压缩模型,
  // 不能在不告知用户的情况下消耗额度;开=用户明确授权自动维护。工作区引擎 pi 有原生
  // 自动压缩,不受此开关影响。
  chatAutoCompact: boolean;
  // 模型 ID,用于对话界面"优化提示词"按钮。空串 = 未配置(按钮会提示去设置页配置)。
  promptOptimizeModelId: string;
  // 全局「嵌入 / 重排」场景档(PC 独有:APP Settings 无对应字段,导出时被 ignoreUnknownKeys 忽略)。
  // 指向 provider.models 里 type === "EMBEDDING" / "RERANK" 的模型;空串 = 未配置。
  // 语义检索类功能(记忆向量索引 / 召回重排)统一按这两档取模型,不再各自存一份设置。
  embeddingModelId: string;
  rerankModelId: string;
  // 记忆去重 / 定期整理共用的场景模型（聊天类模型）。空串 = 未配置，仅做精确去重。
  memoryModelId: string;
  assistantId: string;
}
