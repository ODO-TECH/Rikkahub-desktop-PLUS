# Kelivo 备份继续聊：上下文预算与导入保真（方案，未实施）

- 版本：方案 v1（2026-11-18）
- 状态：**待批准，未动任何源码**。本次只新增本文件；取证脚本与存档副本在仓外 `../kelivo-backup-check/`。
- 范围：两引擎共用的富化窗口（`pc-server/inference-engine/message-enrichment.ts`）、上下文预算与工具输出老化、备份导入保真（`backup/import.ts`、`backup/kelivo/*`）。
- 命名：对外叫**上下文预算**（含「工具输出老化」子项）；存储键与 API 一律 `contextBudget*` / `toolAging*`。
- 关联：压缩机制见 `plan-context-compaction.md`（本方案不改压缩语义，只改窗口裁决）；通用流程见 `dev-workflow.md`，本文 §7 只补本特性线专用条款。
- 前置决策（沿用讨论结论，可在 §10 推翻）：
  1. **不捆 Python 运行时**。rikkelivo 只当规格书、离线对照 oracle 与测试夹具来源，不进产物、不进安装流程。
  2. **预算窗口与工具老化默认关**；关闭时请求逐字节与改动前一致。
  3. **老化只改编码产物，绝不落库**。原文永远在 DB，与压缩同一非破坏性纪律。
  4. **UI 既有「上下文用量」口径本次不动**（`conversations/helpers.ts:173` 的助手文本不计口径保留），避免默认关也变数；两套口径的差异写进 §9，统一与否另案。

---

## 0. 结论先行

「Kelivo 转来的会话接着聊就炸」**不是丢了压缩状态**，而是两件事叠加：导入后助手的上下文窗口是「不限」，而这些会话的体积根本不在消息条数上——它们在工具输出里。因此解药在**推理引擎的窗口裁决**，不在转换器；换转换器（包括走 rikkelivo → RikkaHub 包 → 现有安卓导入这条链路）能提高保真度，但**买不到「能继续聊」**。

三条不可让渡的红线（直接作为验收标准）：

1. **工具配对不变量**：任何新的窗口起点都必须过 `alignContextStart`（`message-enrichment.ts:195`）；老化后的工具结果仍留在 `output` 数组里，`toolPartExecuted` 判定不变，绝不产生「无 call 的孤儿 result」。
2. **非破坏性**：预算与老化都只作用于本次请求的编码产物；`conversation.messages`、`parts`、`engineCompactions` 一个字节都不改，关掉开关立刻回到原文。
3. **前缀稳定**：窗口起点只前移不后退，且按步长量子化（与现有滞回同一思路），不得每轮抖动——否则前缀缓存全失效，省下的 token 被缓存 miss 吃回去。

判断权归人：预算/老化是自动护栏，**压缩与删除仍由用户决定**；体检只报告不改动数据。

---

## 1. 现状诊断（证据）

### 1.1 我们侧的执行路径

| 环节 | 现状 | 位置 |
| --- | --- | --- |
| 唯一的窗口算术 | 只看条数；`contextLimit<=0` 直接返回 0 = 全量注入 | `inference-engine/message-enrichment.ts:173-177` |
| 窗口裁决 | `max(滞回起点, 压缩切点锚)` → `alignContextStart` → slice | 同文件 `:311-319` |
| 助手默认值 | `contextMessageLimit: 0`（0 = 不限） | `assistants/index.ts:31`；`foundation/types/index.ts:161-164` |
| Kelivo 映射 | `limitContextMessages !== true` → 写 **0** | `backup/kelivo/map-to-pc.ts:44-45,84` |
| 同步合并 | 助手字段整体覆盖，只有记忆开关豁免 → 本地设的窗口被冲掉 | `backup/import.ts:1420` |
| 空白助手兜底 | `defaultAssistant()`（limit 0），不继承 Kelivo 侧设置 | `backup/import.ts:1390` |
| 压缩锚点 | 找不到切点就返回 `null`，**静默退回全量** | `inference-engine/engine-compaction.ts:51-64` |
| 自动压缩 | 默认关；窗口未知直接放弃 | `app-config/defaults.ts:126`；`conversations/auto-compaction.ts:127,131` |
| token 估算 | 已有两套：全覆盖（正文+工具，**不含 reasoning**）与 UI 口径（**助手正文不计**） | `conversations/auto-compaction.ts:51-55`；`conversations/helpers.ts:173-200` |
| 估算公式 | CJK 0.9/字 + 其他 /4，无真实分词器 | `foundation/utils.ts:75-79` |
| 发送前闸门 | **不存在**。只有事后分类 `context_length_exceeded` | `inference-engine/provider-errors.ts:13` |
| 历史思考回传 | 默认 true；仅 openai 型 provider 尊重开关，Responses 路另按主机白名单 | `conversations/orchestrator.ts:269-276`；`conversation-encoding.ts:224,280-281` |
| 安卓检查点 | `isContextCheckpoint` 全仓 **0 命中**，导入白名单不含它 | `backup/import.ts:1888`（`normalizeAndroidMessage`） |
| 安卓记忆 | 只读 `MemoryEntity`；上游 Room 28 已改名 `memory_file` | `backup/import.ts:1194`；上游同源缺陷 `reference/rikkahub-desktop-upstream/pc-server/backup/import.ts:1035` |
| Kelivo 附件 | `filesImported` 恒 0，URI 原样留 `kelivo-file:///…` 死链 | `backup/import.ts:1283`；`kelivoPartToPc`（`:1829`） |
| Kelivo 未读表 | `asset_rows` / `mcp_server_rows` / `extension_entity_rows` / `tts_service_rows` / `user_profile_field_rows` / `provider_artifact_rows` 全部不读 | `backup/import.ts:1319-1711` 的 SELECT 清单 |

### 1.2 用户真实存档实测（`../kelivo-backup-check/`，只读副本）

存档 8,545,208 B，Kelivo archive v3 / Drift schema 3；13 会话 / 280 消息 / 256 修订组。

| 观测 | 数值 | 含义 |
| --- | --- | --- |
| `truncate_index` | 13 个会话**全为 -1** | 没有传统边界可转 |
| `conversationContext` 操作实体 | **0 条** | 现代边界机制也没用过 |
| 三个助手 `limitContextMessages` | **全 false**（`contextMessageSize` 为默认 64） | 映射后窗口 = 0 = 不限 |
| part 字节分布 | tool_call 724 段 **3,756,266 B**；reasoning 495 段 **1,519,088 B**；text 336 段 **265,794 B**（合计 5,542,139 B） | 体积 **95%** 在工具与思考里，正文只占 4.8% |
| 选中版本全量注入 | 帕秋莉线润色 1,365,801 B（≈620K tok 估）；pi系统提示词源码 877,053 B；国庆山西游玩日程安排 613,162 B；版本升级0.0.2发布流程 601,571 B | 单会话即可撞穿任何主流窗口 |
| 「只留最近 20 条」压测 | 国庆山西 **100%**、pi源码 **100%**、版本升级 **95%**、帕秋莉 31% | **条数窗口在这份数据上无效**（18 条 = 613 KB） |
| 手机侧记录 `prompt_tokens` 峰值 | 2,882,199 / 2,606,671 / 508,957 | 聚合语义未核实，只作旁证；字节实测才是判据 |
| 其他资产 | 7 个附件、76 条记忆、19 个 MCP、4 工作区、13 技能、26 家 provider（含明文 key） | 保真缺口与安全注意项 |

**结论**：这份存档里没有任何压缩/边界状态可救。上一轮把方案重心放在「重建 `engineCompactions`」是错的，已作废；「把条数设成 20」同样救不了，已作废。

---

## 2. 用户提案链路评估（rikkelivo → RikkaHub 包 → 现有安卓导入）

**机械上通，今天就能跑，零代码**：`rikkelivo source.zip --to rikkahub` 产出 Room 31 包，改用 RDP 的「导入 RikkaHub 备份」卡。

它真买到的（相对我们手写 Kelivo 映射层）：

| 维度 | rikkelivo | 我们现在 |
| --- | --- | --- |
| 附件 | SHA256-16 扁平化落 `upload/` + URI 重写 + 缺失标 `unavailable` | 死链，`filesImported` 恒 0 |
| schema 契约 | 按上游 commit 钉死的 JSON dump + identity hash + `integrity_check`/`foreign_key_check` + FTS 重建 | 手抄 SQL blob，无读时校验（`backup/kelivo/schema.ts`） |
| 损失记账 | 闭集 `Diagnostic`，**在用户确认前**算完（`convert.py:63-102`） | 零散计数器（`ImportReport`） |
| 发布 | staging → 全量复验 → `os.link` 原子发布，拒绝覆盖源（`convert.py:117-202`） | 直接解包写入 |
| 中断态 | `is_streaming` 归零、生成运行标 `interrupted`（`kelivo.py:2364-2414`） | 不处理 |

它买不到的（三条硬证据）：

1. `reference/rikkelivo/src/rikkelivo/settings.py:1242-1261`：`contextMessageLimit = int(size) if limit else 0` → 这份存档三个助手都是 **0**，与我们直接导入同结果。
2. `kelivo.py:500-501` 只读 `truncate_index`（全 -1）→ `truncate_slot=None` → `mapping.py:287-324` 的 `_apply_context_boundary` 不写检查点；它同样**不读 `conversationContext`**（src+tests 0 命中）。
3. 落地端自己有版本漂移洞：安卓导入只读 `MemoryEntity`，Room 28 起上游改名 `memory_file` → 现代手机包经链路进来，**76 条记忆照样全丢**。这条上游一模一样，且 `backup/import.ts:2` 明写「Android 互导契约冻结，只准原样搬迁」。

**判定**：这是**保真度与架构取舍**，不是功能解锁。而且 `contextMessageLimit` 被冲零是 fork 独有缺陷（上游根本没有 Kelivo 映射，`grep contextMessageLimit backup/` 为空）。所以顺序是：先修引擎（S1–S6），再补导入洞（S7–S11），最后才决定转换器归属（S12）。

---

## 3. 目标与非目标

目标：

1. 任何来源（Kelivo / 安卓 / PC 原生 / 手搓长会话）在**窗口不限**时也不会一头撞穿模型上限。
2. 数量级级别的瘦身手段落在**工具输出**上，而不是消息条数上。
3. 导入时就把「这个会话有多大、会不会炸」摆在用户面前，而不是等第一轮 400。
4. 导入保真补齐四个洞：上下文边界、`memory_file`、Kelivo 附件、助手窗口不被冲零。

非目标（明确不做）：

- 不引入 Python / Nuitka / 任何新运行时或五平台二进制。
- 不引入真实分词器（tiktoken 等）；估算误差用 reserve 吸收，见 §9。
- 不改压缩语义、不改 `engineCompactions` 结构、不动 pi 工具内核。
- 不删数据、不自动压缩、不自动改助手设置。
- 不为省 token 丢正确性：Anthropic 系工具链所需的 thinking 块**不许**当 reasoning 一起老化掉。
- 不动 UI 既有上下文用量口径（前置决策 4）。

---

## 4. 目标架构：单一窗口裁决

现状是「条数滞回 ∨ 压缩锚」两路取 max。改成四路取 max，再统一过安全边界：

```
baseMessages（选中版本序列）
  ├─ hysteresisStart   = truncationStartFor(n, assistant.contextMessageLimit)   [既有]
  ├─ compactionAnchor  = indexOf(engineCompaction.cutMessageId)                 [既有]
  ├─ boundaryAnchor    = indexOf(conversation.contextBoundaryMessageId)         [S7 新增]
  └─ budgetStart       = budgetStartFor(msgs, budgetTokens, fixedTokens)        [S2 新增]
        ↓ max
rawStart → alignContextStart(...)  ← 唯一安全边界裁决，规则 R1/R2 不变
        ↓ slice
windowed → 工具输出老化（S3，仅编码产物）→ 模板 → 时间提醒 → 注入 → 摘要行
```

预算口径：

```
contextWindow = contextWindowFor(modelsDevCache, provider, modelId)   // model-limits.ts:211
budgetTokens  = contextWindow − COMPACTION_RESERVE_TOKENS(16384) − fixedTokens
fixedTokens   = system 提示词 + 工具声明 JSON + 压缩摘要 + 系统位注入（调用方实测传入）
```

- `contextWindow == null` → **不猜**，预算路不参与（与 `auto-compaction.ts:131` 同口径），由 S5 体检给体积提示。
- `fixedTokens` 拿不到 → 保守扣 8192，并记一条 `value_defaulted` 诊断。
- `budgetStartFor` 从尾向前累加 `contextTokensOf(msg)`，超预算即停；**量子化**：只有超出量再增加 ≥ 预算 10% 时起点才前移一次，且同一会话内单调不后退（前缀缓存友好）。
- 与压缩的关系：预算是**硬护栏**（防 400），压缩是**语义手段**（保记忆）。两者可叠加；预算切掉的部分不进摘要，也不写任何记录。

老化口径（S3）：

- 只老化「距最新一轮 > K 个工具往返」的**已执行**工具结果；K 默认 2。
- 保留：tool call 的 `input` 摘要、结果占位文本（工具名 + 原字节数 + 前 N 字符，N 默认 200）、`error` 类输出**逐字保留**。
- 豁免：最近 K 轮、被钉住消息（`isPinnedMessage`）、压缩摘要行、未执行的 call、Anthropic 工具链所需 thinking 块。
- 占位仍写在 `output` 数组内 → `toolPartExecuted` 仍为 true → R1/R2 判定与配对不变量天然成立。

---

## 5. 数据模型与设置增量

| 项 | 类型 / 默认 | 归属与纪律 |
| --- | --- | --- |
| `settings.contextBudgetEnabled` | boolean / **false** | 灰度总开关；关闭时富化产物逐字节不变 |
| `settings.toolAgingEnabled` | boolean / **false** | 子开关，受总开关门控 |
| `settings.toolAgingKeepTurns` | number / 2 | 下限 1，上限 16 |
| `settings.toolAgingExcerptChars` | number / 200 | 0 = 纯占位 |
| `Conversation.contextBoundaryMessageId` | string \| null / null | **PC 专属**，必须登记安卓导出剥离清单（与 `engineCompactions` 同列，`foundation/types/index.ts:383-386`） |
| `ImportReport.contextAudit` | 只增数组 | `{conversationId,title,messages,bytes,estTokens,overWindow}`；**只读报告，默认开**（豁免理由：不改任何既有行为与数据，只多显示一段） |
| `ImportReport.diagnostics` | 只增数组 | 闭集 code + category + count + detail，借 rikkelivo 纪律（§S12） |
| 助手 `contextMessageLimit` | 不新增字段 | 只改合并豁免与空白兜底（S10） |

诊断闭集（首版冻结，测试断言 code 不断言文案）：
`context_boundary_approximated`、`context_boundary_unrepresentable`、`memory_visibility_changed`、`memory_table_renamed`、`source_file_missing`、`unsupported_data`、`value_defaulted`、`selection_unavailable`、`interrupted_state_normalized`。

新增模块：`pc-server/inference-engine/context-budget.ts`（估算 + 预算起点 + 老化，纯函数、无 I/O、无状态）。

---

## 6. 分期与故事

改动面按「预计新增/修改行数」给量级，便于排期；每个故事**做完才允许进下一个**（§7.2）。

### 阶段一：让它真能继续聊（S1–S6）

**S1 抽取统一估算模块**（小，≈120 行）
- 把 `auto-compaction.ts:51-55` 的 `messageContextTokens` 抽到 `context-budget.ts`，导出 `contextTokensOf(msg, {reasoning})`；`reasoning` 覆盖按「本次请求是否真会回传」决定（openai 型看 provider 开关，Responses 看主机白名单，其余按方言）。
- `auto-compaction.ts` 与 `helpers.ts` 改为调用新模块，**语义保持不变**（UI 口径继续不计助手正文）。
- 验收：新增 `context-budget.test.ts` 断言两套口径各自数值与改动前一致；`bun test conversations/*.test.ts inference-engine/engine-compaction-threshold.test.ts` 全绿。

**S2 token 预算窗口**（中，≈200 行）
- `context-budget.ts` 加 `budgetStartFor`；`EnrichOptions` 加可选 `contextBudget?: {tokens, fixedTokens}`；`enrichMessages:311-319` 并入第四路 max，`alignContextStart` 位置不变。
- `conversation-encoding.ts:147-167` 在开关开启时计算并传入；pi 通路同评（§7.3）。
- 验收：① 18 条 / 613 KB 的真实存档会话在 128K 窗口下首轮估算 ≤ 预算；② 起点单调不后退、量子化生效（连续三轮追加消息，前缀逐字节稳定）；③ 工具配对不变量：构造 call/result 跨界样例，断言无孤儿 result；④ 开关关闭时富化产物与基线逐字节相同。

**S3 工具输出老化**（中，≈220 行）
- 按 §4 老化口径实现，只作用于编码产物；返回老化计数供徽标与诊断。
- 验收：① 帕秋莉线润色（全修订 2,561,382 B，其中 tool_call 占 **67.1%**、reasoning 24.9%、正文 8.0%）老化后字节降一个数量级；② DB 原文校验和不变；③ `error` 输出与钉住消息逐字保留；④ 关掉开关立刻回原文；⑤ Anthropic 工具链样例不因老化产生 400（用 mock 断言请求体结构）。

**S4 发送前硬闸**（小，≈90 行）
- 生成入口在**任何网络调用之前**估算；超 `contextWindow − 最小 reserve` 则不发，返回可操作错误（建议开预算 / 手动压缩），与 `provider-errors.ts:13` 的事后分类并列。
- 随同一开关，默认关；窗口未知时不拦（不猜）。
- 验收：mock 供应商断言「超限时零请求发出」；错误文案含会话体积与建议动作；正常路径不受影响。

**S5 导入期体积体检**（中，≈180 行）
- Kelivo / 安卓导入结束时逐会话算 `bytes + estTokens`，写入 `ImportReport.contextAudit`，按体积倒序；超过目标助手模型窗口（未知则用 200K tok 绝对阈值）标 `overWindow`。
- **只报告不改动**：不自动设窗口、不自动压缩、不禁用会话。
- 验收：用 `../kelivo-backup-check/source.zip` 跑真实导入，断言 13 条记录、四个大会话 `overWindow=true`、排序正确；导入前后 DB 会话内容校验和一致。

**S6 前端**（中，≈260 行 + build）
- 设置卡内折叠区（标 `advanced`，让搜索自动展开）：总开关 + 老化子项；单开关不折叠。
- 导入结果卡追加体检列表（就地展示，原文默认折叠）；被老化的消息在时间线加自明徽标，点开看原文。
- 验收：`web-ui` 重新 build 后在 17455 实机走一遍导入 → 体检 → 开预算 → 继续聊；图标像素级验形，不加 tooltip。

### 阶段二：导入保真四个洞（S7–S11）

**S7 上下文边界双向**（中，≈200 行）
- `normalizeAndroidMessage`（`import.ts:1888`）白名单加 `isContextCheckpoint`；导出侧写回该字段。
- 新增 `Conversation.contextBoundaryMessageId`，富化第三路锚接入；Kelivo 侧 `truncate_index >= 0` 时按「消息下标 → 修订组序号」换算（借 `rikkelivo/kelivo.py:1354-1364` 的口径）。
- 无法表达时**fail-closed + 报诊断**，不造空消息（借 `mapping.py:287-324` 与 `docs/spec.md §3`）。
- 验收：安卓往返测试断言检查点存活；Kelivo 老包（有 `truncate_index`）导入后窗口锚生效；本存档（全 -1）断言**不产生**任何边界与诊断噪声。

**S8 `memory_file` 兼容**（小，≈80 行，**需契约偏离申辩**）
- 先 `PRAGMA table_info` 探测：有 `memory_file` 读它，缺表回退 `MemoryEntity`；两条都无 → 记 `memory_table_renamed` / `unsupported_data`，不静默。
- 这是**上游同源缺陷修复**，与 `import.ts:2` 的冻结纪律冲突 → 按 §7.6 单独故事、文件头注记偏离理由、准备给上游的说明；不夹带其他改动。
- 验收：用**本故事自带的最小 `memory_file` 夹具**断言记忆条数 > 0（S12 落地后换成按 commit 钉死的 dump，避免阶段二被阶段三阻塞）；老 Room 包仍走 `MemoryEntity` 分支；`backup/android-contract.test.ts` 全绿。

**S9 Kelivo 附件与资产**（中，≈240 行）
- 读 `asset_rows` + 包内 `upload/`，落地到 PC 文件库并重写 URI；缺失标 `unavailable` + 占位（沿用 `kelivo/encode.ts:589` 文案）；`filesImported` 真计数。
- 顺带评估 `mcp_server_rows`(19) 是否纳入本轮；不纳入就记 `unsupported_data` 诊断，**不再静默**。
- 验收：真实存档 7 个附件全部可点开；缺附件样例报 `source_file_missing`；导出回 Kelivo 时剥离 PC 专属字段。

**S10 助手窗口保真 + 中断态清理**（小，≈100 行）
- `import.ts:1420` 合并豁免加 `contextMessageLimit`（与记忆开关同列）；`ensureBlankAssistant`（`:1390`）继承 Kelivo 侧 limit 而非默认 0。
- 导入时 `is_streaming` 归零、未完成生成运行标中断（借 `kelivo.py:2364-2414`），记 `interrupted_state_normalized`。
- 验收：本地设 32 条 → 同步 → 仍是 32；新建空白助手继承源设置；导入后会话不再显示「正在生成」。

**S11 `ContextOperation` 解析**（中，≈220 行，**优先级最低**）
- 读 `extension_entity_rows` 中 `kind='conversationContext'`，按 Kelivo `ContextHistory.resolve()` 语义投影成边界 + 摘要（`context-summary:` 前缀）；解析失败 fail-closed 报 `context_boundary_approximated`。
- 明确定位：**为将来的包正确**，不是本 bug 的解药（本存档 0 条）。
- 验收：构造带 ops 的夹具断言边界与摘要；ops 缺失/损坏时报诊断而非静默全量。

### 阶段三：转换器归属（S12）

**S12 采纳 rikkelivo 的契约与纪律，不采纳其运行时**（中，≈300 行 + 夹具）
- 把它 `schemas/` 里按 commit 钉死的 `room_24..31.json`、`drift_1..3.json` 当**我们的契约测试夹具**（先过 §9 许可核对），替换手抄 SQL blob 的无校验现状。
- 导入侧引入 staging → 复验 → 原子替换；`ImportReport.diagnostics` 改闭集。
- 结论待定：Kelivo 映射层是「继续自养」还是「改走标准 RikkaHub 包」——**在 S1–S11 完成后**用真实存档对照两条路的保真度再拍。
- 验收：夹具驱动的读时校验能拒掉 identity hash 不符 / 列序漂移的包；诊断 code 集合冻结且有测试。

---

## 7. 流程规范（本特性线专用）

通用条款一律沿用 `dev-workflow.md`（动手前批准、目录归属、双引擎、前端兼容、设置与导出、测试、沙盒、演示进程、Git、文档发布）。以下只补本线新增约束；标 ★ 的三条建议批准后回灌 `dev-workflow.md`。

1. **只读默认**：未获明确批准不改源码。取证一律在仓外副本上做（`../kelivo-backup-check/`），原始存档不动。
2. **故事闸门**：每个故事必须同时具备①可演示边界②回归清单③实跑通过的测试，三者齐了才进下一个。不允许「先都写完再一起验」。
3. ★ **双引擎同评**：`enrichMessages` 是聊天与 pi 共用咽喉，任何窗口/老化改动必须同时给出两条通路的结论与测试；pi 原生压缩与预算叠加时的顺序要写进故事验收。
4. ★ **编码不变量清单**（每个碰窗口的故事都要逐条断言）：工具 call/result 不拆散；`toolPartExecuted` 语义不变；合成消息 id 走 `syntheticIds`；窗口起点单调不后退；请求前缀逐字节稳定；DB 原文校验和不变；开关关闭时产物与基线逐字节相同。
5. **默认关与剥离登记**：新能力默认关；`contextBoundaryMessageId` 等 PC 专属字段必须同批登记安卓导出剥离清单，漏登记视为故事未完成。
6. ★ **上游契约偏离申辩**：`backup/import.ts:2` 声明安卓互导契约冻结。S8 这类上游缺陷修复必须单独成故事、在文件头注记偏离理由与影响面、并准备给上游的说明；禁止夹带在功能故事里顺手改。
7. **验证零计费**：只用本地 mock（`127.0.0.2:18124`，状态端点 `/__state`）与真实存档的离线导入。要打计费接口先报价再动手。体积/ token 结论以**字节实测 + 本地估算**为判据，手机侧 `prompt_tokens` 只作旁证。
8. **演示与进程**：每次改动后走 `demo-server.sh` 重启 17455；前端改动先 build `web-ui`；不脚本直起 `server.ts` 留孤儿；shot-host 退出码 1 属常态。
9. **第三方代码与存档安全**：绝不运行备份包内脚本（本存档含 65 个 `.py`，一律不解包不执行）；如需真跑 rikkelivo，venv 建在 D 盘、只装 `click/rich/questionary`，且先说明它不联网（已核：无 socket/requests/subprocess/eval）。存档含 26 家明文 API key 与个人/医疗 PDF，**验收后按清单征得同意再删**。
10. **并行编辑纪律**：本仓常有并行会话。typecheck 在未触碰文件报错时只做无歧义最小修补（漏 import 之类），语义工作不动、只报告；不暂存/还原/删除他人改动。
11. **文档与发布**：实施记录追加到本文件末尾（与 `plan-context-compaction.md` 同做法）；发布说明只写变更条目、先给短版；不新建重复文档。
12. **完成定义**：S1–S6 全绿 + 真实存档实机「导入 → 体检 → 继续聊」跑通 + 关闭开关逐字节回退验证通过，才算「支持 Kelivo 备份继续聊」。S7–S12 是保真度，不阻塞该结论。

---

## 8. 验收命令与基线

```bash
cd pc-server
bun run typecheck
# 阶段一目标测试
bun test inference-engine/context-budget.test.ts \
         inference-engine/message-enrichment.test.ts \
         inference-engine/engine-compaction-threshold.test.ts \
         inference-engine/provider-errors.test.ts
# 阶段二目标测试
bun test backup/kelivo/roundtrip.test.ts backup/kelivo/options.test.ts \
         backup/android-contract.test.ts backup/android-contract-sync.test.ts \
         backup/import-runtime.test.ts backup/selective-scope.test.ts
# 全量（只在故事收口时跑）
bun test
```

- 已知 Windows flake：`C:\WINDOWS\Temp` EPERM（需管理员）与 e2e EBUSY，恒定 2–3 败不视为回归、不 bisect；smoke EBUSY 同属 flake，清 lock 用 `/api/app/shutdown`。0.1.6 期基线记为 2598 项，全量数字以当次实测为准。
- 「单跑绿、合跑红」先查跨文件 `globalThis` 桩泄漏，不改业务语义迁就测试。
- 真实存档验收脚本沿用 `../kelivo-backup-check/inspect.py` / `inspect2.py`（`PYTHONIOENCODING=utf-8` 跑，避免 CJK 乱码）。

---

## 9. 风险与硬保证口径

**能硬保证**（有代码不变量与测试兜底）：

- 非破坏性：原文与压缩记录不被改写，关开关即回退。
- 工具配对：`alignContextStart` 仍是唯一边界裁决，老化不改变 `output` 非空判定。
- 默认关时行为逐字节一致；新字段全部登记导出剥离。
- 验证过程零计费、不联网、不执行包内程序。

**只能降险**（必须对外说清，不许承诺「一定不炸」）：

| 风险 | 降险手段 | 残余 |
| --- | --- | --- |
| token 估算无真实分词器 | CJK 0.9/字 + 其他 /4，再扣 16384 reserve | 代码/ base64 密集内容仍可能低估；S4 硬闸是最后一道 |
| 供应商方言差异 | 老化豁免 thinking 块；reasoning 覆盖按 dialect 判定 | 第三方兼容端点形态各异，只能实测 |
| pi 原生压缩与预算叠加 | 故事级双通路验收 | 极端序列下可能双重 trimming，需实机观察 |
| 上游 schema 再漂移 | S12 夹具 + 读时校验 + 闭集诊断 | 新表新列仍会落后于上游发布 |
| 两套估算口径并存 | 文档写明差异（前置决策 4） | UI 用量条与预算判据数字不同，用户可能困惑 |
| 许可 | rikkelivo `pyproject.toml` 声明 MIT 但**无 LICENSE 文件**；vendored schema 是 AGPL 上游的数据导出 | 夹具采纳前必须核对，我们 `kelivo/schema.ts` 手抄 SQL 同样面临来源问题 |

---

## 10. 待定决策（默认采用前置决策，可推翻）

1. 预算窗口是否**默认开**？当前默认关（纪律优先）。若默认开，可立刻救所有存量长会话，但违反「新能力默认关」，需要用户明确豁免。
2. 老化保留字符数 N=200 是否够调试？可改 0（纯占位，最省）或 512。
3. `mcp_server_rows`(19) 是否纳入 S9？纳入则故事变大，不纳入则记诊断。
4. UI 上下文用量口径是否与预算口径统一？统一会让用量条数字上升（是纠正不是回归），需单独批准。
5. S12 之后 Kelivo 映射层自养还是改走标准包？等 S1–S11 完成后用真实存档对照再拍。

---

## 附录 A：可执行故事（JSON）

```json
[
  {"id":"S1","phase":1,"title":"抽取统一 token 估算模块","files":["pc-server/inference-engine/context-budget.ts","pc-server/conversations/auto-compaction.ts","pc-server/conversations/helpers.ts"],"size":"~120","accept":["两套口径数值与改动前一致","reasoning 覆盖按 dialect 判定","context-budget.test.ts 实跑绿"],"depends":[]},
  {"id":"S2","phase":1,"title":"token 预算窗口接入富化","files":["pc-server/inference-engine/context-budget.ts","pc-server/inference-engine/message-enrichment.ts","pc-server/inference-engine/conversation-encoding.ts"],"size":"~200","accept":["613KB/18条会话首轮 ≤ 预算","起点单调+量子化，前缀逐字节稳定","无孤儿 tool result","关闭开关产物与基线一致","pi 通路同评"],"depends":["S1"]},
  {"id":"S3","phase":1,"title":"工具输出老化（仅编码产物）","files":["pc-server/inference-engine/context-budget.ts","pc-server/inference-engine/conversation-encoding.ts"],"size":"~220","accept":["帕秋莉会话字节降一个数量级","DB 校验和不变","error/钉住/thinking 逐字保留","关开关回原文"],"depends":["S2"]},
  {"id":"S4","phase":1,"title":"发送前硬闸","files":["pc-server/conversations/orchestrator.ts","pc-server/inference-engine/provider-errors.ts"],"size":"~90","accept":["超限时 mock 收到零请求","错误含体积与建议动作","窗口未知不拦"],"depends":["S2"]},
  {"id":"S5","phase":1,"title":"导入期逐会话体积体检","files":["pc-server/backup/import.ts","pc-server/backup/kelivo/service.ts"],"size":"~180","accept":["真实存档 13 条记录","四个大会话 overWindow=true","只报告不改数据"],"depends":["S1"]},
  {"id":"S6","phase":1,"title":"前端：折叠设置 + 体检卡 + 老化徽标","files":["web-ui/src/**","pc-server/api/**"],"size":"~260","accept":["build 后 17455 实机走通","advanced 折叠可被搜索展开","徽标自明无 tooltip","原文就地可展开"],"depends":["S2","S3","S5"]},
  {"id":"S7","phase":2,"title":"上下文边界双向 + Kelivo truncate_index","files":["pc-server/backup/import.ts","pc-server/backup/export.ts","pc-server/foundation/types/index.ts","pc-server/inference-engine/message-enrichment.ts"],"size":"~200","accept":["安卓往返检查点存活","老 Kelivo 包锚生效","本存档不产生边界噪声","PC 专属字段登记剥离"],"depends":["S2"]},
  {"id":"S8","phase":2,"title":"memory_file 兼容（契约偏离申辩）","files":["pc-server/backup/import.ts"],"size":"~80","accept":["自带最小 memory_file 夹具记忆 > 0","老包回退 MemoryEntity","文件头注记偏离理由","android-contract 全绿"],"depends":[]},
  {"id":"S9","phase":2,"title":"Kelivo 附件与资产落地","files":["pc-server/backup/import.ts","pc-server/backup/kelivo/map-to-pc.ts"],"size":"~240","accept":["7 个附件可点开","缺失报 source_file_missing","filesImported 真计数","未纳入表记诊断"],"depends":[]},
  {"id":"S10","phase":2,"title":"助手窗口保真 + 中断态清理","files":["pc-server/backup/import.ts"],"size":"~100","accept":["本地 32 条同步后仍 32","空白助手继承源 limit","is_streaming 归零并记诊断"],"depends":[]},
  {"id":"S11","phase":2,"title":"ContextOperation 解析","files":["pc-server/backup/import.ts","pc-server/backup/kelivo/map-to-pc.ts"],"size":"~220","accept":["带 ops 夹具投影出边界+摘要","损坏时 fail-closed 报诊断"],"depends":["S7"]},
  {"id":"S12","phase":3,"title":"采纳 rikkelivo 契约夹具与诊断闭集","files":["pc-server/backup/kelivo/schema.ts","pc-server/backup/import.ts","pc-server/backup/__fixtures__/**"],"size":"~300","accept":["许可核对通过","identity/列序漂移包被拒","诊断 code 集合冻结且有测试","staging→复验→原子替换"],"depends":[]}
]
```

---

## 附录 B：证据与参考

- 真实存档取证：`../kelivo-backup-check/`（`source.zip` 副本、只解出 `manifest.json` / `settings.json` / `database/kelivo.db` 三个数据条目、`inspect.py` / `inspect2.py`）。包内 65 个 `.py` 从未解包或执行。
- rikkelivo：`reference/rikkelivo`（8 commits，14,105 行 Python）。关键位置 `settings.py:1242-1261`、`mapping.py:287-324`、`kelivo.py:500-501,1354-1364,2364-2414`、`convert.py:63-202`、`archive.py:600-643`、`model.py:67-113`、`docs/spec.md §3`。
- 上游 schema 钉死 commit：RikkaHub 3.1.0 `eeef60b2…`（Room 24–31）、Kelivo 1.3.1 `4742d2e2…`（Drift 1–3）、Cuplivo 4.3.0 `282dc0b0…`。两家上游均 AGPL-3.0；rikkelivo 自称「未修改的数据导出，非源码衍生」，采纳夹具前需自行核对（§9）。
- 安卓参照：`reference/rikkahub-android` — `Message.kt:172-217`（`CONTEXT_KEEP_RATIO=0.5`）、`Message.kt:37-38`（`isContextCheckpoint`）、`Migration_16_17.kt`（删 `truncate_index`）、`BackupManager.kt:44-85`。
- Kelivo 参照：`reference/kelivo` — `assistant.dart:112-113`（默认 64 / false）、`context_operation.dart`（`conversationContext`、`ContextHistory.resolve`）、`chat_context_repository.dart:269-314`（老 `truncate_index` 迁成 ops 后置 -1）。
- 上游桌面：`reference/rikkahub-desktop-upstream/pc-server` — 无 Kelivo 映射；`backup/import.ts:2` 契约冻结声明、`:1035` 同源 `MemoryEntity` 缺陷；`truncationStartFor` 与其测试断言与我们逐字相同。
---

## 实施记录（2026-11-18）

状态：**S1–S10 已落地并实跑验证**；S11/S12 按 §10 决策推迟（理由见下）。本次改动的文件与验收结果如下。

### 已落地

| 故事 | 落地内容 | 主要文件 |
| --- | --- | --- |
| S1 | `contextTokensOf` / `conversationTokens` / `budgetStartFor` / `ageToolOutputs` / `hardLimitFor` 纯函数层；自动压缩复用同一估算 | `inference-engine/context-budget.ts`（新增）、`conversations/auto-compaction.ts` |
| S2 | 富化窗口四路取 max（滞回 ∨ 压缩锚 ∨ 边界锚 ∨ 预算），仍过 `alignContextStart`；预算净额 = 窗口 − 16384 − 系统面/工具声明 | `inference-engine/message-enrichment.ts`、`inference-engine/conversation-encoding.ts` |
| S3 | 工具输出老化（保留最近 K 轮、error/pending/钉住逐字、占位仍在 `output` 内） | `context-budget.ts`、`message-enrichment.ts` |
| S4 | 发送前硬闸（开关开启且超窗口−预留 → 零网络请求，抛可操作错误）；窗口未知不猜 | `conversations/auto-compaction.ts`（`contextFitError`/`assertContextFits`）、`orchestrator.ts` |
| S5 | `ImportReport.contextAudit` 逐会话体检（只读），Kelivo/安卓两条导入路径都填；警告文案 | `backup/import.ts`、`api/handlers/data.ts` |
| S6 | 设置 › 场景 › 上下文压缩卡内新增「上下文预算」+ 高级折叠（工具老化/保留轮次/占位字符数）；导入卡体检列表 | `web-ui/app/components/settings/default-models.tsx`、`data/backup.tsx`、两份 locale |
| S7 | `Message.isContextCheckpoint` 双向透传；`Conversation.contextBoundaryMessageId`（PC 专属，含 DB 列/迁移/dump）；安卓导入取最后一个检查点；Kelivo `truncate_index` 换算成边界 | `foundation/types/index.ts`、`conversations/index.ts`、`read-queries.ts`、`backup/import.ts`、`message-enrichment.ts`、`conversation-encoding.ts` |
| S8 | `memory_file`（Room 28+）读写：导入按表探测、新表优先并解析 `- [stated]` 条目；导出写 `/profile.md`；旧库回退 `MemoryEntity` | `backup/import.ts`、`backup/export.ts`（含文件头契约偏离申辩） |
| S9 | Kelivo 附件落地：`upload/` 复制进 PC 文件库、sha256 去重、`kelivo-file:///upload/…`（含编码段）改写为 `/api/files/<id>/content`、缺失计数警告、`filesImported` 真计数 | `backup/import.ts` |
| S10 | Kelivo 同步不再把本地 `contextMessageLimit` 冲成 0；空白助手继承源侧条数限制 | `backup/import.ts` |

设置层：新增 `contextBudget` 切片（默认全关、加载宽容归一）、`settings/context-budget` 端点、PC-only 导入保留清单与安卓导出剥离、前端类型自动继承（`Settings extends Omit<ServerSettings, …>`）。

### 真机存档实测（离线、零计费，隔离数据目录）

`kelivo-backup-check/source.zip` → 13 会话 / 256 消息 / 76 记忆 / 26 供应商 / 4 世界书 / 6 注入 / 5 搜索服务；附件 4 个落地、3 个确属包内缺失（引用保留并告警）、4 处引用改写、1 处指向缺失文件原样保留；边界 0（存档 `truncate_index` 全 -1，符合预期）。

体检：3 个会话超窗，最大「帕秋莉线润色」≈661K tokens（2,526KB）。在 120K 预算下富化结果：保留 10 条 / 91K tokens / 351KB，首条不是孤儿工具结果；仅开老化时 82 个工具结果折叠 1,458KB，payload 2,526KB → 1,068KB。

### 刻意未做 / 与方案的偏差

1. **S11（`ContextOperation`）推迟**：本存档 0 条，rikkelivo 同样不解析（src+tests 0 命中），没有可用夹具；按「不猜格式」纪律留给拿到真实样例后单独实现。
2. **S12（钉死 schema 夹具/诊断闭集）推迟**：需要先核对许可（AGPL 数据导出 vs 我们的 `schema.ts`），且诊断闭集是跨导入/导出的大改，按 §10 决策 5 等用户拍板。
3. **pi 引擎未接预算窗口**：pi 有原生 compaction + `piModelLimitsFor`；再叠一层预算会双重裁剪。仅聊天引擎接入，`enrichMessages` 的接口已留给 pi 后续按同一入口接入。
4. **Kelivo 导出仍写 `truncate_index = -1`**：PC 的边界可能指向检查点/摘要消息，与 Kelivo 的「保留自该条起」语义不完全等价；不做没有样例支撑的反向猜测。
5. **`is_streaming` 清理无对应动作**：PC 的生成态只在内存（`generating`），消息里不落 loading 占位；Kelivo 的该标志进 PC 后无读者，落库时随会话内容自然消失。
6. **S1 的 helpers 口径未合并**：`estimatePromptTokensForConversation` 继续「助手正文不计」的历史口径（前置决策 4），避免预算功能关闭时 UI 用量条也变数。

### 验收命令与结果

```bash
# 新增/受影响的目标测试（全部通过）
bun test inference-engine/context-budget.test.ts \
         inference-engine/message-enrichment.test.ts \
         inference-engine/engine-compaction-threshold.test.ts \
         backup/memory-file-format.test.ts backup/context-audit.test.ts
bun test conversations/upsert-cascade.test.ts conversations/lazy-load.test.ts \
         backup/android-contract.test.ts backup/android-import-settings.test.ts \
         backup/kelivo/roundtrip.test.ts backup/zip-structure.test.ts
# 前端
cd web-ui && bun run typecheck && bun run build   # 产物已复制到 dist/web-ui
```

已知未覆盖：S4 的「零请求」只有纯函数级断言（`contextFitError`），没有起假供应商做端到端计数；`memory_file` 导出方向没有真实 3.x 设备回读验证（按上游格式与 rikkelivo 对齐）。这两项列入下次实机验收。

### 演示中发现并修正的问题（2026-11-18 晚）

首次在演示实例里对导入会话发消息时，硬闸按「最后一条 assistant 的 usage」估算（那是手机全量注入时代的
508,957），在已开启预算的情况下仍报「约 510K 超限」。这是口径错误：导入会话的历史 usage 反映的是来源
APP 的旧请求，不是本轮裁剪后的载荷。`assertContextFits` 改为 `estimateEncodedContext`（完整编码当前富化
产物后计数，预算窗口已生效）；自动压缩仍保留 usage 优先口径。修正后同一会话实际请求为 37 条消息，演示用
本地 Mock 记录的正文 token ≈ 66K（Mock 不计 tool_calls/reasoning），对话正常返回。

### 空回复根因：0 哨兵被当成有效采样参数（2026-11-20）

演示实例里改用真实 SiliconFlow（`Qwen/Qwen3-VL-30B-A3B-Instruct`）继续导入会话时，上游返回 200 但
流里没有任何 text delta，界面最终只显示 `(empty response)`。取 `state.logs` 的请求体后定位到：

- `top_p: 0`、`max_tokens: 0` 被原样发给上游。Kelivo 与部分安卓助手 JSON 用 0 表示「未设置」，
  而 OpenAI / Anthropic / Gemini 会按字面值执行——概率质量 0 / 输出上限 0，结果是空回复。
- Mock 供应商不校验这两个字段，所以演示链路当时「正常返回」，掩盖了问题。

修正：新增 `inference-engine/sampling.ts`（`effectiveTopP` / `effectiveMaxTokens`），所有出线路径
（OpenAI chat、Responses API、Claude、Google generationConfig、Interactions）统一把 0/负数视为未设置、
省略字段；`temperature` 不做此处理（0 是合法的确定性采样）。Kelivo 助手导入同时把 0 归一成 `null`。
回归测试：`inference-engine/sampling.test.ts`（含 Google 出线形状与 Kelivo 映射）。

> 真实采样参数是否被上游接受，最终仍以真机请求为准；本次修复只保证不把「未设置」发成 0。

### 本地调试端口（2026-11-20）

新增 PC 专属 `debugServer` 设置切片（默认关闭，只绑 `127.0.0.1`，端口默认 17456，可选 token），
开启/关闭即时生效，不随 `--host 0.0.0.0` 暴露。端点：

| 端点 | 用途 |
| --- | --- |
| `GET /debug` | 自包含 HTML 调试台（日志流 / 请求 / 树 / 重启） |
| `GET /debug/health` | pid、版本、数据目录、主端口、运行时长 |
| `GET /debug/logs` | 控制台环形缓冲（1000 条，level/since/limit 过滤） |
| `GET /debug/logs/stream` | SSE 实时日志 |
| `GET /debug/requests` | `state.logs` 最近请求（已脱敏，含请求/响应体） |
| `GET /debug/tree` | 助手、供应商、会话与设置摘要 |
| `GET /debug/conversations/:id/tree` | 会话节点树（逐 part 类型/长度，只读，不扰动 working set） |
| `GET /debug/conversations/:id/encoded` | 编码产物统计（消息数、逐条 token、工具输出体积、失效附件引用） |
| `POST /debug/restart` | 与 `/api/app/restart` 共用同一停机/自重启编排与四道闸 |

设置入口：数据管理 › Web 服务 › 调试端口。测试：`debug/server.test.ts`（生命周期/令牌/端点/重启桩）。
