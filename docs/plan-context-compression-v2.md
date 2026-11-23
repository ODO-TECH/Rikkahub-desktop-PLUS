# 上下文压缩 v2：计费口径、留存结构与前缀缓存

- 范围：聊天引擎 + 工作区（pi）引擎共用的上下文计费层、自动压缩触发、发送前兜底；压缩记录结构与前缀渲染（S5/S6）；模型驱动压缩工具面（S7，仅工作区）
- 状态：**S1–S7 已全部落地**（2026-11-20）。S1–S4 已实机验收通过；S4b（应急截断顺序）与 document 计费洞已补；S5/S6 改默认结构、S7 默认关。参照源码已拉到 `../reference/billion-context`（GitHub `ranxianglei/billion-context`，MIT，含论文 `paper/模型驱动的分层增量压缩-免训练多代上下文管理.md`）
- 前置文档：`docs/plan-context-compaction.md`（v1，已落地）。本文是它的**算法层续作**，不推翻 v1 的三条不变量
- 并行编辑警示：撰写本文时 `pc-server/app-config/defaults.ts`（00:04）、`pc-server/conversations/auto-compaction.ts`（23:54）正被另一会话修改，工作区有 82 项未提交改动。**用户已决定等该会话收口再实施**；`context-budget.ts` 等关键文件是 untracked，worktree 隔离不可行（从 HEAD 开的树没有这些文件）

---

## 0. 结论先行

**采纳 billion-context 的三件事，拒绝整内核移植。**

1. **计费口径**（S1–S3）：它的 token 估算同样是启发式（CJK 1:1 + 其余 /4），但多了三样我们没有的东西——**图片按 tile 计费**、**按供应商真实 usage 学一个校准系数**、**预留量跟着输出上限走而不是写死 16384**。我们这三样全缺，且缺的方式是**系统性少算**。
2. **留存结构**（S5–S6）：它把历史折成**多个可独立恢复的块**，每段原文一生只在 tier-1 被折一次，摘要**就地锚定**渲染；我们是**单切点 + 头部链式摘要 + 超预算整链再浓缩**，正是论文 §4.2 证明会按 ρ^k 几何衰减到零的那一类。
3. **常开兜底**（S4）：它在 95% 占用时无条件截断最大的工具输出；我们的硬闸和自动压缩**双双默认关**，出厂设置下长会话直接吃供应商 400。

**红线（继承 v1，不得破）**

- 原文只增不删：时间线、搜索索引、导出、备份永远看得到全部历史。
- 安卓导出边界：压缩记录、`compaction_cut`/`pinned` 注解、PC 专属设置一律剥离。
- 前后端估算镜像必须同步改（`foundation/utils.ts` ↔ `web-ui/app/lib/compaction.ts`），否则圆环与后端阈值打架。
- 验收零计费：只用 `demo-profiles/userdata-compaction` + 本地 mock `127.0.0.2:18124`，不点真实供应商。

**一句话判断**：我们不是"压缩算法不够聪明"，而是**先算错了账，再用一个会几何衰减的结构去省错误的账**。S1–S4 是修账 + 补兜底，低风险高收益，先做；S5–S7 是换结构，收益更大但要动数据模型、时间线与导出——已于同日获批并落地，S7 默认关由用户自行开启。

---

## 1. 现状证据表（全部已核实，带 文件:行号）

路径相对仓库根 `rikkahub-desktop-plus/`。

| # | 缺陷 | 证据 | 后果 |
| --- | --- | --- | --- |
| D1 | **CJK 系数 0.9 且字符集漏项** | `pc-server/foundation/utils.ts:75-79`：`cjk = text.match(/[㐀-鿿]/g)`，`ceil(cjk*0.9 + other/4)`。范围仅 U+3400–U+9FFF | 漏掉平/片假名（U+3040–30FF）、谚文（U+AC00–D7AF）、全角标点（U+3000–303F）、兼容表意文字（U+F900–FAFF）。中文按 0.9 计，参照项目按 1.0 计且自述仍低估约 5%（`src/server/budget.ts:73-77`）→ 我们中文场景**低估 15% 量级** |
| D2 | **图片计 0 token** | `context-budget.ts:48-59` 只累加 `textFromParts` + 工具文本；`utils.ts:38-46` 的 `textFromParts` 只取 `type === "text"`。`ImagePart = { type:"image"; url:string }`（`foundation/types/parts.ts:49-52`），`message-builder.ts:87-106` 原样内联 base64 | 十张大图可达 2.8 万 token（10×2805 上限）**完全不在账上**。图片多的会话自动压缩永不触发，直接撞窗口 |
| D3 | **工具声明不进触发估算** | `auto-compaction.ts:105-106`：`encoded.reduce(... contextTokensOf ...)`；`conversation-encoding.ts:226` 只返回 `{ messages, picked }`，工具 JSON 仅在 `:171-175` 供 `contextBudget` 用 | 挂满 MCP 的会话，工具声明可达 1–3 万 token，触发判定看不见 → 压缩触发过晚 |
| D4 | **预留写死 16384，与输出上限无关** | `engine-compaction.ts:70-78`：`COMPACTION_RESERVE_TOKENS = 16384`，`threshold = window − 16384`；`window ≤ 16384` 返回 `null` | 小窗口模型（8k/16k）**完全没有自动压缩**；32k 窗口在 50% 就压（过激）；1M 窗口到 98.4% 才压，16k 预留吸收不了 D1+D2 的误差 |
| D5 | **聊天路径没有输出闸** | `model-providers/model-limits.ts:236-263` `requiredOutputCap` = `min(outputLimit, contextWindow)`，**不减 prompt 估算、无安全垫**；调用方 `orchestrator.ts:357`（Claude 必填）。减 prompt 的逻辑只在 vendored pi 引擎内部（`model-limits.ts:14-17` 注释自述） | prompt 190k / 窗口 200k / max_tokens 32k → Anthropic 硬 400。参照项目有显式钳制：`max_tokens ≤ window − 1.12×est − max(2048, 5%×est)`（`src/server/budget.ts:345-382`） |
| D6 | **常开兜底不存在** | `auto-compaction.ts:229`：`if (state.settings.contextBudget?.enabled !== true) return;`（默认 false，`settings/context-budget-config.ts:25`）；`auto-compaction.ts:127`：自动压缩 gated by `chatAutoCompact !== true`（默认 false，`app-config/defaults.ts:133`） | **出厂设置下聊天路径无任何溢出保护**，请求照发、供应商 400。工具输出老化 `ageToolOutputs` 同样默认关 |
| D7 | **单切点 + 头部链式摘要 + 整链再浓缩** | `engine-compaction.ts:51-63` `findEffectiveCompaction` 取 `.at(-1)`，只有最新记录生效；`:112-124` `mergeCompactionSummary` 直接 `prev\n\nfresh` 拼接；`auxiliary.ts:567-569` 预算 `max(1024, 2×target)`，`:702-735` 超预算对**整条链**再浓缩一次；`message-enrichment.ts:382-388` 摘要 `injected.unshift(...)` 钉在序列最前 | ① 每次再浓缩都是对"上一代摘要"重摘 → 论文 §4.2 的 ρ^k 衰减（ρ≈0.4–0.6，四轮后剩 3–13%）；② 摘要在头部且每次压缩都变 → **整个前缀缓存失效**；③ 早期块不可被模型单独恢复 |

**D7 的前缀缓存细节**：`message-enrichment.ts:240-241` 的注释声称"摘要不变则请求前缀逐字节不变"——这只在**两次压缩之间**成立。压缩一发生，头部摘要改写 + 切点后窗口整体前移，其后所有消息位置全变，缓存全废。参照项目的做法是把每块摘要渲染在**该块最早直接覆盖消息的原位**（`kernel/src/prune.ts:293-305`，issue #2733），并明确记录：改用传递覆盖集锚定曾把缓存前缀"每次再折叠塌到 ~11K"。

---

## 2. 参照项目：采纳 / 拒绝

参照根 `../reference/billion-context/`。

### 采纳

| 机制 | 参照出处 | 落到 rdp 的形态 | 故事 |
| --- | --- | --- | --- |
| CJK 1:1 + 假名/谚文/全角覆盖 | `kernel/src/tokenize.ts:5-13` | 改 `estimateTokens` 正则与系数，前后端镜像同步 | S1 |
| 图片按 tile 计费 | `src/image-tokens.ts:169-193`：短边升到 768、长边封 2048，`85 + 170×ceil(w/512)×ceil(h/512)`，上限 2805；尺寸从容器头解析不全解码（`:74-167`） | 新增 `inference-engine/image-tokens.ts`，接进 `contextTokensOf` | S1 |
| 工具声明计入估算 | `src/server/budget.ts:150-152` `countSystemAndToolsTokens` | 触发估算补上 `JSON.stringify(tools)` | S1 |
| 按真实 usage 学校准系数 k̂ | `src/cache-ledger.ts:1777-1886`：3 样本环、比值准入 0.2–5、≥2 样本互差 ×2 内、发布钳到 **0.25–4**、按 origin+model 匹配 | 请求时记 localEstimate，响应 usage 到达时配对成样本，按 (provider, model) 存环 | S2 |
| 预留跟输出上限走 | `src/server/handle.ts:2899-3065`：`effective = native − min(maxOutput, 0.25×native)` | `reserveTokensFor(window, outputLimit)`，带下限；前端改用服务端下发的预留 | S3 |
| 输出钳制 | `src/server/budget.ts:345-382`：`window − 1.12×est − max(2048, 5%×est)`，低于 1024 放弃 | `requiredOutputCap` 在协议必填/用户已配置时减 prompt 估算 + 安全垫 | S3 |
| 应急截断（常开） | `kernel/src/truncate-tools.ts:29-36,109`：≥95% 触发、≥1000 token 的工具输出、最大优先、排除最近 3 条、留 **头 2000 + 尾 2000 字符** + 标记、替换必须严格更短、结果 latch 后逐字节重放 | 新增纯函数接进 `enrichMessages`，常开；硬闸不再依赖 `contextBudget.enabled` | S4 |
| 多块 + 就地锚定渲染 | `kernel/src/types.ts:68-125` `CompressionBlock`；`prune.ts:293-305,555-567` | 压缩记录升级为带范围与层级的块，摘要渲染在各自锚点 | S5 |
| 分层再蒸馏（只折一次） | `compress.ts:1946-1949`（tier-2 消费子块并置 `active=false`）、`unit-projection.ts:211-219`（tier = min(子 tier)+1，封 3）、论文 §3.6/§4.2 | 再浓缩改为"消费若干块 → 生成上层块"，被消费块保留为可恢复血统，不再对自身输出重摘 | S6 |
| 模型驱动工具面 | `kernel/src/compress-tools.ts:86-100,394-479`：`compress`（模型自己写摘要）/`decompress`/`search_context`/`acp_status` | 仅工作区模式注入，默认关 | S7 |
| nudge 措辞纪律 | `kernel/src/nudge-text.ts:38,46,205-222`；论文 §4 机制 (ii)(iii)(v)：**不告知填充比例**（防锚定）、措辞是"效率提示不是溢出警告"、候选区间**带真实尺寸**、临时尾部 user 消息不落库 | 工作区模式的压缩提示按此重写 | S7 |
| 无损召回占位 | `kernel/src/ccr.ts:160-168`：`📦 [acp-stored #m00423 · shell output · 4,213 tok] → acp_retrieve("m00423")` | rdp 原文本就在 SQLite，占位 + `read_original` 工具即可，无需新存储 | S7 |

### 拒绝（及理由）

| 参照机制 | 拒绝理由 |
| --- | --- |
| 整内核移植（`kernel/` ≈ 2 万行） | 它 70% 的复杂度来自**它是代理、宿主每轮重发全量历史**：ref  reconciliation、snapshot render、identity channels、view latch、plugin/proxy 双模、全量重发水位快路径。**rdp 自己拥有历史**（SQLite 单一事实源），这些结构性问题在我们这里不存在 |
| 1022 行宽容解析器 `parse-compress-input.ts` | 它要 salvage 各家 CLI 的畸形 JSON。rdp 拥有工具循环，可以直接用严格 schema + 把错误作为工具结果回给模型重试 |
| `mNNNNN` 永不重用的引用空间 | 我们的消息 id 本就是稳定 UUID，不需要第二套编号；S5 直接用消息 id 界定范围 |
| SMT 求解器验证 `verif/` | 与我们的测试栈（bun test）不匹配，投入产出不成立 |
| 图片不可解析 →  flat **16384** | 对聊天应用是毒丸：用户粘十张图就虚增 16 万 token，触发无意义压缩。改用 tile 上限 2805 作兜底（见 §7 待定） |
| 摘要模型外链候选链 `external-summary-*` | rdp 已有 `compressModelId`（`defaults.ts:130`）与场景档，不需要第二套凭据/超时/并发体系 |
| 平坦 50K 增速门控 nudge | 那是编码 agent 的量级（工具输出主导）。聊天会话增量小得多，照搬会让 nudge 永不触发；S7 需按 rdp 实际分布重定标 |
| "省 5 倍 token" 的预期 | 该数字来自编码 agent 的海量工具输出语料（论文 §6）。rdp 聊天流量以人类文本为主，**不承诺同等倍数** |

---

## 3. 数据模型

### 3.1 S1–S4：无 schema 变更

全部是纯函数与既有字段的新算法。唯一新增持久化是 S2 的校准环：

- 位置：`pc-data/token-calibration.json`（运行时遥测，**不进 settings**，因此天然不参与安卓导出）
- 形状：`{ [providerId + "::" + modelId]: { samples: Array<{ local: number; billed: number; at: number }>, factor: number } }`，每键 ≤8 样本，原子写
- 准入：`billed/local ∈ [0.2, 5]`；≥2 个样本互差在 ×2 内才发布；发布值钳到 `[0.25, 4]`；无样本 → 1.0（行为与今天逐字节一致）

### 3.2 S5/S6：压缩记录升级为块（已落地）

`conversation.engine_compactions` 已经是**数组**（`conversations/index.ts:77`），今天只是"取最新一条生效"。升级是**追加字段 + 改生效判定**，不是换表：

```jsonc
{
  "cutMessageId": "…",          // 既有：范围终点（不含）
  "startMessageId": "…",        // 新增：范围起点（含）；缺省 = 上一条块的 cut
  "summary": "…",               // 既有
  "tokensBefore": 12345,        // 既有
  "tier": 1,                    // 新增：1|2|3，缺省 1
  "consumedRecordIds": ["…"],   // 新增：tier≥2 时指向被消费的下层块
  "active": true,               // 新增：被上层消费后置 false，记录不删
  "createdAt": "…"              // 既有
}
```

- **旧记录兼容**：无 `startMessageId` 的老记录按 v1 语义解释（覆盖切点之前全部），`tier=1`、`active=true`。不做数据迁移。
- **生效判定**：从 `.at(-1)` 改为"所有 `active` 块按锚点排序"。`findEffectiveCompaction` 保留为兼容入口（pi 路径与旧测试仍用）。
- **渲染（实施取 Design B，与初稿的"原位渲染"不同）**：块必须首尾相接，富化窗口锚 = **末块**切点；第 5 步把 k 条摘要行按序 unshift 到序列最前，外层沿用 v1 的 `<context_summary>` 框（`message-enrichment.ts:245-263`）但改为逐块。第 1–4 步与 v1 逐字节相同 → 摘要行永不被模板化/时间提醒/预算头切/应急占用统计碰到。钉住消息仍逐字附在**其所属块**的摘要后。
  - 为什么不原位渲染：原位插入会让摘要行落进历史中段，被后续每一步富化/裁剪当成普通历史处理，前缀缓存与"摘要恒在窗口内"两条纪律同时破。Design B 用"多行摘要 + 单锚点"拿到等价信息量，且不动 v1 的任何一步。
- **安卓导出**：`backup/export.ts:487` 的剥离逻辑不变（整条记录数组本来就剥）。

---

## 4. 硬保证 vs 只能降险

**能保证（有测试可钉）**

- 原文一条不删；S5/S6 的块停用只改 `active`，记录与消息行都在。
- 关闭新开关后逐字节回到旧行为（S2 校准无样本 = 1.0；S4 截断只在 ≥95% 触发；S5 旧记录走 v1 解释）。
- 前后端估算口径一致（同一份纯函数语义 + 镜像测试）。
- 工具 call/result 配对不被劈开（沿用 `alignContextStart`，S4 截断只改 output 文本不动配对）。
- 安卓导出不含任何新字段。
- 验收全程零计费（mock 供应商）。

**只能降险（无法硬保证）**

- **启发式估算永远不是真 tokenizer**。参照项目也没有 tiktoken，它靠 k̂ 校准把误差压到可用。S2 同理：校准能修正系统性偏差，但修不了单条消息的方差。
- **图片 tile 公式是 OpenAI 口径**。Anthropic 按 `(w×h)/750`、Gemini 按 768 tile，三者不同。S1 先用 OpenAI 口径（三者中偏大，安全方向），按供应商分化留作后续。
- **摘要保真度靠提示词，不靠机械校验**。参照项目论文明说：没有自动事实核查，只有 KEEP/DROP 规约 + "逐字引用必须带 ref"。S6 能消除几何衰减，但不能保证摘要本身不丢关键细节。
- **前缀缓存命中率取决于供应商**。就地锚定能让我们的出站前缀稳定，但上游 TTL 到期、换模型、中转站改写仍会废缓存——这部分不在我们控制内。
- **模型驱动压缩依赖模型自觉**。论文 §8.1 实测：模型**不会自发调用恢复工具**，需明确指示。S7 不能假设模型会主动 decompress。

---

## 5. 分期与验收

### S1 计费口径修正（无 schema 变更，无 UI 变更）— ✅ 已落地

1. `estimateTokens`：正则扩到 `[㐀-鿿぀-ヿ가-힯　-〿豈-﫿]`，CJK 系数 0.9 → **1.0**；前后端镜像同改。
2. 新增 `inference-engine/image-tokens.ts`：从容器头解析尺寸（PNG IHDR / JPEG SOF / GIF / WebP / BMP，不全解码），data URL 只解头部字节；本地文件读文件头；按 url 哈希 + 长度 memoize。tile 公式 `85 + 170×ceil(w/512)×ceil(h/512)`，短边升 768、长边封 2048、上限 2805；不可解析 → 2805；远端 URL → 1600。
3. `contextTokensOf` 累加图片 token；`textFromParts` 语义不动（它另有消费者）。
4. 触发估算补工具声明：`estimateAutoCompactContext` / `estimateEncodedContext` 的 fallback 分支加 `estimateTokens(JSON.stringify(tools))`。

验收：
```bash
cd pc-server && bun test foundation/utils.test.ts inference-engine/image-tokens.test.ts inference-engine/context-budget.test.ts
cd ../web-ui && bun test app/tests/compaction.test.ts
```
新增断言：假名/谚文/全角各计 1；`"你好"` 仍 = 2（0.9→1.0 后 ceil 不变，旧测试不破）；1024×1024 图 = 85+170×2×2 = 765；不可解析图 = 2805；十张图的会话估算 > 0；挂 N 个工具时触发估算含声明体积。

### S2 用量自校准（新运行时文件，无 settings 变更）— ✅ 已落地

1. 新增 `inference-engine/token-calibration.ts`：样本环、准入、发布钳制、按键读写 `pc-data/token-calibration.json`。
2. 请求出站处记 `localEstimate`（含系统面 + 工具声明 + 图片），响应 usage 到达处（`conversations/helpers.ts:202-242` `ensureUsage` / `usage-merge`）配对成样本，`usage.estimated === true` 的样本**拒收**。
3. 估算消费点乘 k̂：自动压缩触发、预算窗口、发送前硬闸。UI 圆环仍显示供应商真实 usage，不乘。

验收：`bun test inference-engine/token-calibration.test.ts`。断言：单样本不发布；两样本互差 >×2 不发布；比值 0.1 / 10 被准入拒；发布值钳在 [0.25,4]；无样本时估算逐字节等于 S1 结果；estimated usage 不产生样本。

### S3 预留与输出闸（改默认行为，需拍板）— ✅ 已落地

1. `engine-compaction.ts` 新增 `reserveTokensFor(window, outputLimit)` = `clamp(min(outputLimit ?? 0.25×window, 0.25×window), 2048, 0.5×window)`；`compactionThresholdFor` 改用它。`COMPACTION_RESERVE_TOKENS` 保留为无输出上限时的兜底常量。
2. 服务端把算出的预留随 `contextLimit` 一起下发；前端 `contextWarningPercent` 优先用服务端值，缺省回退 `max(2048, min(16384, 0.25×window))`（老数据）。
3. `requiredOutputCap`：协议必填或用户已配置时，减去 `1.12×promptEstimate + max(2048, 5%×promptEstimate)`；结果 <1024 时不发该字段（让供应商用自己的默认）而非发一个非法小值。用户显式配置值的"永不钳制"纪律（`model-limits.ts:229-231`）需重新界定——见 §7。

效果对照（reserve / 触发点）：

| 窗口 | 输出上限 | 今天 | S3 后 |
| --- | --- | --- | --- |
| 8k | 4k | 无自动压缩 | 2048 / 75% |
| 32k | 8k | 16384 / 50% | 8192 / 75% |
| 200k | 32k | 16384 / 91.8% | 32768 / 83.6% |
| 1M（1 000 000） | 64k | 16384 / 98.4% | 65536 / 93.4% |
| 1MiB（1 048 576） | 64k | 16384 / 98.4% | 65536 / 93.75% |

> 表里最后一行是勘误：初稿只写了「1M → 93.75%」，那其实是 1MiB 的数。测试钉的是
> 1 000 000（`engine-compaction-threshold.test.ts`），触发点 934 464 = 93.4%。

验收：`bun test inference-engine/engine-compaction-threshold.test.ts model-providers/model-limits.test.ts` + 前端镜像测试。旧测试里钉死 `16384` / `compactionThresholdFor(32768)=16384` 的断言需按新公式重钉（**这是有意的行为变更，不是回归**）。

### S4 常开兜底（改默认行为，需拍板）— ✅ 已落地

1. 新增纯函数 `emergencyTruncateToolOutputs(messages, { windowTokens })`（`inference-engine/emergency-truncate.ts`）：占用 ≥95% 有效窗口时，按 token 从大到小截断 ≥1000 token 的工具输出，留头 2000 + 尾 2000 字符 + `[truncated for context space — original ~N tokens]`；排除最近 3 条消息、摘要行、钉住消息、error/pending 输出；替换必须严格更短。
   - 实施补了一条初稿没写的**释放线**：一旦触发就截到 90%（`EMERGENCY_TARGET_RATIO`），多让出 5%。与预算窗口同一滞回思路——否则占用在 95% 附近抖动时每轮都要新截一刀，前缀反复失效。
   - 入参名用 `windowTokens`（有效窗口）而不是初稿的 `thresholdTokens`：触发线由函数内部按 95% 算，调用方只负责给窗口，避免两处各写一份比例。
2. 接进 `enrichMessages`（在工具老化之后、模板之前），**常开**，不受 `contextBudget.enabled` 影响。
   - 顺序有讲究：老化先把过旧结果折成短占位，应急截断只处理"折叠后仍塞满窗口"的残余；反过来先截断再老化会把截断标记当原文再折一次。
   - 摘要行此刻还不存在（第 5 步才 unshift），天然不会被截。
   - 调用方：聊天生成（`conversation-encoding.ts`，窗口先扣系统面 + 工具声明再除 k̂）与 pi 工作区生成（`orchestrator.ts`，口径保守，只扣预留不扣 pi 系统面）。**手动压缩路径刻意不接**——摘要要覆盖真实原文，不能被截断产物污染。
3. 截断结果按 `消息id::toolCallId` latch，后续轮逐字节重放（防前缀抖动）。
   - latch 只存 key 不存文本：替换由原文 + 常量确定性重算，内存与原文体积无关。
   - 用户钉住该消息 → 摘除 key、恢复原文（明示意图优先于前缀稳定性）；原文被编辑变短 → 旧截断不再成立，同样摘除。
   - 上限 4096 个 key，超出按插入序淘汰（淘汰只会让该 part 恢复全量，由发送前硬闸兜底）。
4. 发送前硬闸改为常开，但判定口径放宽到**原生窗口**（而非 `window − reserve`）：截断后仍超原生窗口才报可操作错误，避免估算偏大误杀本可成功的请求。
   - 错误文案不再让用户"去开上下文预算"（它已常开），改为建议手动压缩或换更大窗口的模型。
   - `hardLimitFor` 保留为预算口径helper，但硬闸不再用它。

验收：`bun test inference-engine/emergency-truncate.test.ts inference-engine/context-budget.test.ts inference-engine/conversation-encoding.test.ts` → **40 pass / 0 fail**。断言：94% 不触发 / 恰好 95% 触发（双向）；最大优先且截到释放线就停；最近 3 条不动；error/pending/钉住/摘要行不动；混合输出里非文本条目同一引用保留；严格更短（头尾重叠的 1500 token 输出跳过）；低于 1000 token 不截；latch 跨轮逐字节重放 + 同轮幂等 + 钉住摘除 + 编辑摘除；配对不变量（output 非空、toolCallId 不变）；enrichMessages 常开接入与老化共存；零供应商配置下编码层不崩（见 §7 落地后记 15）。

### S5 块化 + 就地渲染 — ✅ 已落地

见 §3.2。时间线从"一条分割线 + 一张摘要卡"变为"多张摘要卡各就各位"；`web-ui/app/lib/compaction.ts` 的分割线/锚点逻辑与 `compaction.test.ts` 已相应扩展。

**渲染取 Design B**：块必须首尾相接，窗口锚 = **末块**切点；富化第 5 步把 k 条摘要行 unshift 到序列最前。第 1–4 步与 v1 逐字节相同，所以摘要行永不被模板化/时间提醒/预算头切/应急占用统计碰到。

验收：`bun test inference-engine/compaction-blocks.test.ts pi-engine/context-encoder.test.ts conversations/pi-route.test.ts` → 块解析 22 pass、编码器 17 pass、pi 路由含 S5/S6 用例全绿；前端 `bun test app` 586 pass / 0 fail。

### S6 分层再蒸馏 — ✅ 已落地

再浓缩改为消费若干 active 块生成上层块；被消费块 `active=false` 但**记录与原文都保留**；每段原文一生只在 tier-1 折一次；`tier = min(子块 tier) + 1`，上限 `COMPACTION_TIER_MAX = 3`；`consumedRecordIds` 留血统。提示词已补 KEEP/DROP 规约。

**蒸馏是精确可逆操作**：停用上层块 + 重新启用 `consumedRecordIds` 指到的子块 → 生效块集逐字段回到蒸馏前（`compaction-blocks.test.ts` 的"S6 血统可恢复"两用例钉死，含"只停上层不复活子块 → 断点降级、原文重新逐字可见"的反向用例）。

验收：8 轮连续压缩的 mock 会话断言早期原文只被折一次、tier-2 的输入是 `<summaries>` 块摘要而非自身上一代输出、上层块区间 = 被吸收块的并区、`tokensBefore` = 子块之和。

### S7 模型驱动工具面 + 无损召回 — ✅ 已落地（仅工作区，默认关）

注入 `context_status` / `compress` / `search_context` / `read_original` / `decompress`（`pc-server/pi-engine/context-tools.ts`）；nudge 按 §2 的措辞纪律（不报百分比、带真实尺寸、追加到本轮 `promptText` 故**不落库**）；压缩哲学段进 `extraAppendSystemPrompt`（常量文本，满足会话级冻结纪律）。增速门控阈值重定标为可配置的 **8000**（不照搬参照项目 50K），单次召回上限 8000。

设置面：`settings.contextTools`（PC-only，导出安卓剥离），端点 `POST settings/context-tools`，UI 挂在「模型 › 场景模型 › 上下文压缩」同一张卡里（总开关 + 效率提示直放行，两个数值进 `SettingsFold`），搜索索引 4 条 + 两份 locale 同义词。

验收：`bun test pi-engine/context-tools.test.ts` → **39 pass / 0 fail**，覆盖范围校验/连续性拒绝、摘要不更短拒绝、错误作为工具结果抛出、原文 parts 逐字节不变、分割线锚点、tier-1 拒绝 decompress 并指路无损召回、tier-2 精确撤销、`read_original` 超预算显式列 id、`search_context` 跨会话索引按 id 过滤、nudge 门控/水位/压缩后安静重新武装、默认关 → 空数组 + 空系统段 + 空 nudge。

---

## 6. 非目标

- 不移植 `kernel/`，不引入第二套消息编号，不做代理/MITM 形态。
- 不改 v1 的"原文只增不删"与安卓导出边界。
- 不做摘要的自动事实核查（参照项目也没有）。
- 不承诺参照项目的"省 5 倍 token"倍数。
- 不动 vendored pi 引擎内部的压缩实现（S1–S4 只改共用计费层，pi 路径自动受益）。
- 不在本轮清理 demo 档案里的旧压缩记录（v1 遗留，删前先问）。

---

## 7. 决策记录

### 已定（2026-11-20 用户拍板）

1. **范围 = S1–S4**。修计费口径 + 用量自校准 + 预留/输出闸 + 常开兜底。S5（块化就地渲染）、S6（分层再蒸馏）、S7（模型驱动工具面）**暂缓**，需后续单独拍板。
2. **时机 = 等并行会话收口**。不在当前这棵被另一会话编辑的树上叠加语义改动。
3. **接受 S3/S4 改变出厂行为**：小窗口模型开始有自动压缩；95% 占用时截断旧工具输出；发送前硬闸常开。选项说明里已明示这些后果，用户选定即视为接受。

### 沿用方案建议值（不再单独问，实施时按此执行）

4. **图片不可解析兜底 = 2805**（tile 上限），不用参照项目的 16384。理由见 §2 拒绝表：聊天应用粘十张图就虚增 16 万 token 会触发无意义压缩。
5. **用户显式配置的 max_tokens 也参与钳制，但钳制事实必须可见**（诊断/提示），不静默缩水。`model-limits.ts:229-231` 那条"永不钳制"纪律的立意是"别偷偷改用户意图"，而非"宁可 400 也不钳"——防 400 与尊重意图可以同时满足：钳了就说。
6. **硬闸判定口径放宽到原生窗口**（而非 `window − reserve`），避免估算偏大误杀本可成功的请求；`window − reserve` 仍是自动压缩的触发线，两条线分开。

### 落地后记（2026-11-20，S1–S4 收口）

8. **S2 实施时发现并补了一个初稿没列的缺口**：`callProviderStreaming` 才是 OpenAI 型供应商的真实会话流式入口（非 openai 型在下面转交 `callProvider`），初稿只登记了 `callProvider`。漏登记等于**最常见的供应商家族永远学不到 k̂**。已在该入口补 `noteOutboundEstimate`，与 `callProvider` 同一份出站估算口径。
9. **k̂ 只乘在"消费估算"上，绝不乘在"登记样本"上**：登记校准后的值会让校准环自我确认（k̂ 越偏越觉得自己对）。样本永远是原始本地估算 vs 上游真实 usage。
10. **pi 桥不参与 S3 输出钳制**：`piModelLimitsFor` 刻意不传 `promptTokens`——pi 引擎内部自己按本轮 prompt 减上限，这里再减一次就是双重扣减。
11. **协议必填 vs 可选，在剩余空间极小时分开处理**：可选协议（OpenAI completions/responses、Google）headroom <1024 时**省略该字段**，让供应商用自己的默认（"能装多少装多少"）；Anthropic 必填，发 `max(1, headroom)`——回答被截短是可感知降级，400 是完全不可用，取后者更差的那一边避开。
12. **仍有一个已知计费洞（与 D2 同类，本轮刻意不修）**：`document` part 展开后的抽取文本在 `contextTokensOf` 里看不见（存储态只有 url，正文在旁车缓存 `files/index.ts:421 readExtractedTextSync`）。修它要读旁车缓存，超出 context-budget 层"只读图片头部字节"的 I/O 边界。影响面有限：`apiMessagesTokens` **能**看见 document 正文（出站已展开），所以 S2 的本地估算与硬闸对文档是正确的；只有"按存储态消息估算"的预算窗口/老化判定会低估文档体积。留作后续单独一拍。
13. **浮点精度坑（已修在实现侧，不是改测试迁就）**：`Math.ceil(prompt * 1.12)` 在 prompt=100000 时得到 112001，因为乘积是 112000.00000000001。`outputHeadroomFor` 改用整数比值 `Math.ceil((prompt * 112) / 100)`，避免凭空多扣 1 token 且随 prompt 取值抖动。
14. **错误中心风暴合并会影响钳制事实的可见性**：`reportError` 按 `code + JSON.stringify(params)` 合并，30s 窗口内只累加 count 并**保留首条 message**。所以每轮变动的 prompt/headroom 数值不能进 params（否则要么刷屏要么被吞），但稳定的区分事实必须进——`output_cap_clamped` 的 params 带 `{ model, configured }`，configured 是助手配置值，稳定且能区分不同钳制事件。

15. **S4 落地时踩到一个真回归（已修 + 已钉测试）**：`findModel` 在"一个供应商都没配"时回退到 `{ provider: undefined, model: Auto }`。窗口/预留/k̂ 的计算原先躲在 `contextBudget.enabled` 闭包里，预算关着就永不执行；S4 把应急截断改成常开后把这些计算提到闭包外，零供应商配置下直接 `TypeError` 炸掉整条编码路径（`memory/dynamic-recall.test.ts` 三个用例红）。
    - 修法：`picked.provider` 一律先判空，算不出窗口就让两条护栏**不参与**（不猜），k̂ 回退 1。同一处隐患在 S2 遗留的 `contextCalibrationFactor` 与 `estimateAutoCompactContext`/`estimateEncodedContext` 里也有，一并修。
    - 新增 `inference-engine/conversation-encoding.test.ts`（4 用例）把"无供应商也必须是合法状态"钉死。教训：**把计算从开关闭包里提出来 = 把它暴露给所有此前被开关挡住的输入域**，常开化必须连带审查前置条件。
16. **应急截断刻意不做 UI/错误中心提示**：它是 95% 占用时的最后兜底，替代方案是 400；标记文本 `[truncated for context space — original ~N tokens]` 对模型可见，原文在 DB/时间线/导出里逐字完好。`EnrichResult.emergencyTruncatedParts/emergencySavedTokens` 已把计数返回，后续若要加徽标或 warn 级上报，接这两个字段即可，不需要再动纯函数层。

### 实机验收（2026-11-20，调试端口 17456 / demo `userdata-kelivo-budget`）

全部走 `debugServer`（`/debug/tree`、`/debug/conversations/:id/{tree,encoded}`、`/debug/requests`、`/api/errors/recent`），
后端先 `POST /debug/restart` 热重启到含 S1–S4 的进程（pid 19916）。出站只打本地 Mock `127.0.0.2:18124`。

| 项 | 实机证据 | 结论 |
| --- | --- | --- |
| S4 常开（**出厂设置 `contextBudget.enabled=false`**） | 单条工具输出注入 238876 字符 / 185944 tokens → `/encoded` 总量 **9279**，该工具消息 **3685** tokens、textLen 95 | D6 在真实实例上关闭：预算关着也截断 |
| S4 wire 侧 | Mock `/__state` 与 `/debug/requests` 均记到标记 `[truncated for context space — original ~185944 tokens]` **恰好一次**，前后各 2000 字符头尾；12 条 wire 消息、promptTokens 6055 | 截断真的进了出站体，不只是编码报告 |
| S4 可选协议纪律 | 同一请求 `max_tokens` **字段不存在**（用户未配置 → 根本不发） | 与 `outboundMaxTokens` 头注一致 |
| 原文只增不删 | 工具节点 2 个 variant：`a22150f4…` 仍 **237 字符**（原文未动），`696d1977…` 238876 字符为选中支 | 编辑只加分支 |
| latch 重放 | 真实生成一轮前后，工具消息 tokens **3685 → 3685**；总量 9279 → 9393 仅因新增 USER/ASSISTANT 对 | 前缀缓存稳定 |
| S4 硬闸 | 1,000,000 个 CJK 字符 → **0 条出站**，错误中心「上下文约 1004K tokens,已超过模型窗口上限(200K)…请做一次手动压缩,或换用更大窗口的模型」 | 本地拒绝，措辞不再让人去开开关 |
| S3 钳制 | 临时助手 `maxTokens=64000`、prompt 估算 147887、窗口 200000 → wire **`max_tokens: 26971`** = `200000 − ceil(147887×112/100) − max(2048,7395)`；warn `output_cap_clamped` params `{model:"claude-sonnet-4-5",configured:64000}` | 逐 token 对得上，留痕不含每轮变动值 |
| S1 图片计费 | 真实节点 `f7bd73fd…`：文本 1036 字符 ⇒ est(text) **927**，`/encoded` **2032** ⇒ 图片贡献 **1105 = 85 + 170×6 tiles**（旧口径计 0） | 图片不再免费 |
| S2 k̂ | 该 profile 的 Mock k̂ ≈ **1.0**（由硬闸报出的 1004K / 1,000,000 CJK 字符反推） | 校准环未引入偏移 |

17. **实机暴露一处顺序缺陷（建议改，尚未动）**：`message-enrichment.ts:344-356` 的预算头切（1.4）跑在应急截断（1.6）**之前**。
    预算开着时，那条 185944 tokens 的工具消息被**整条丢弃**（fork `/encoded` 掉到 7 条 / 4765 tokens，工具行消失），
    应急截断根本没机会把它缩到 3685。把应急截断提到头切之前，同样占用下能保住全部 11 条消息 + 工具输出的头尾——
    **严格更少破坏**（截断保留头尾，头切删整条）。代价只是对"随后会被切掉的消息"多做一次估算，latch 按 key 存储故无副作用。
    属于改动已上线的 opted-in 功能行为，留作单独一拍（S4b）。
18. **验收纪律事故（已披露 + 已止血）**：在 fork 里发一条消息，触发了 `conversations/auxiliary.ts:311` 的**聊天建议**辅助路径，
    打到真实 MIMO（`mimo-v2.6-flash`，200，10721ms，**input 714 + output 193 = 907 tokens**）。
    根因：demo profile 的 `fastModelId` 指向真实供应商，而"只选 Mock"只约束了主对话模型，**管不住辅助路径**。
    止血：`POST /api/settings/default-models {enableSuggestion:false,titleGenerationEnabled:false}`，并核实
    `chatAutoCompact:false`、`memorySettings.writeStrategy:"ask"`、mood `enabled:false`，此后所有生成只到 Mock。
    **教训：零计费验收必须先把 `resolvePostGenerationModelIds()` 的两个开关关掉，再点火**；
    校验脚本要列出本轮**全部**新增出站（`/debug/requests` 返回 `{entries}`，不是数组），只看首条会漏掉辅助调用。
    验收结束后三项临时设置（`assistantId`/`enableSuggestion`/`titleGenerationEnabled`）与 `contextBudget` 已逐项还原。

### 落地后记（2026-11-20，S4b + 计费洞 + S5–S7）

19. **S4b 已改**：应急截断提到预算头切之前（落地后记 17 的顺序缺陷）。同样占用下保住全部消息 + 工具输出头尾，而不是整条丢弃——严格更少破坏。latch 按 key 存储，对"随后会被切掉的消息"多做一次估算无副作用。
20. **document 计费洞已补**（落地后记 12 刻意留的那一拍）：`contextTokensOf` 现在能看见 document part 展开后的抽取文本，预算窗口/老化判定不再低估文档体积。
21. **S5 连续性纪律 = 在第一个断点处停下，绝不跳过继续收后面的块**。中间挖洞会让其后所有块失效；停下则被丢弃块覆盖的原文**重新逐字可见**——这是唯一不丢信息的降级方向（与 v1"陈旧记录回落到更早一条"同哲学）。
22. **`findEffectiveCompaction` 是扁平兼容视图，不是新数据模型**：单块 → 原记录对象本身（身份与字段逐字节不变，v1 会话行为完全一致）；多块 → 合成 `{cut=末块切点, summary=各块摘要按序拼接, tokensBefore=求和}`。pi 原生重放/用量估算/自动压缩触发都只要"一个切点 + 一份摘要"，这个视图让它们零改动受益。
23. **S5 在 pi 通路抓到一个真回归（已修 + 已钉反例测试）**：编排层原先把**原始记录数组**下发给 `runPiGeneration` / `runPiCompaction`。但 pi 的 `buildContextEntries`（`session-manager.ts:418-454`）只认叶路径上**最后一条** compaction，而编码器又按"切点仍在历史中"过滤——窗口锚已把历史裁到末块切点，于是原始数组里**只有末块能过滤出来，早期块的摘要整段静默消失**。
    - 修法：两条 pi 路径都只下发扁平生效视图 `compactions: cut ? [cut] : []`。
    - 同时刻意**不**把 `compactionBlocks` 传给富化层：摘要行由 pi 原生 `appendCompaction` 渲染，两边都给会让同一份摘要在 pi 上下文里出现两次。
    - `pi-engine/context-encoder.test.ts` 新增用例同时断言"扁平视图保住全部摘要"与"原始数组会丢早期块"，防止有人顺手改回去。
24. **工作区 pi 原生压缩仍是 v1 链**：`applyCapturedEngineCompactions` 落的是 legacy 形状记录（无 id/startMessageId/tier），解析器的 legacy 分支覆盖 `[0, cut)`，现代块接在其后。若同一轮里模型先 `compress`、pi 随后又原生压缩，后落的 legacy 记录切点更靠后 → 它覆盖超集区间，模型那块被 supersede（原文不丢，只是那份摘要不再发送）。这是既有 v1 语义，不额外加机器。
25. **S7 `decompress` 只撤销 tier≥2 的蒸馏**，tier-1 明确拒绝并指路 `search_context` + `read_original`。理由：原文一生只在 tier-1 折一次，单独停用一个 tier-1 块会挖出空洞、连带其后所有块失效（S5 连续性）——那是降级不是压缩，不能由模型随手触发。而逐字召回本来就是无损的，不需要"解压"。
26. **S7 `compress` 的摘要由调用它的模型自己写**，不再另烧一次压缩模型（参照项目的外链摘要候选链被拒）。两条硬校验：起点必须**恰好**等于已折叠前缀终点（否则错误里给出正确的锚点 id）；摘要必须比原文短（否则"压缩会把上下文越压越大"）。`cut` 是排他端且必须是真实存在的消息 id → **最新一条消息永不被折**。
27. **S7 工具改动的生效时点是「下一轮请求」，不是本轮**。pi 的会话上下文在生成开始时一次性灌注（`seedPiSessionFromHistory`），工具中途改记录不会重写本轮上下文。工具结果里如实说明，不假装立即腾出了空间；本轮真要塞爆时由 pi 原生压缩与 S4 常开应急截断兜底。
28. **S7 的 `search_context` 是找回消息 id 的唯一入口**：`conversations/helpers.ts` 的 `summaryAsText` 只产 `[role]: text`，**不带消息 id**，所以摘要行里的逐字引用无法直接定位原文。FTS 索引是**跨会话**的（`pc_message_fts`），必须按 `conversationId` 过滤后再给模型，否则会把别的会话原文喂进去；命中落在非选中分支（用户编辑过的旧版本）时如实标注。
29. **S7 nudge 的水位语义**：尾巴变短 = 刚发生过压缩 → 把水位重置到**当前**新增量并安静返回。重置到 0 会让"刚压完、尾巴仍比阈值大"的会话立刻再被唠叨一遍。提示后要再长满一个完整阈值才会再提示。
30. **S7 工具面与发现行/子智能体的关系**：五个工具都不是 `mcp__` 前缀 → `discoverableToolPool` 不会把它们关进待激活池，恒活跃；无 `promptSnippet`（与 general-tools 同纪律），由常量系统段告知模型。子智能体工具面只从 `createPiWorkspaceTools`/`createPiGeneralTools` 现取后按 `allowedTools` 过滤，**上下文工具不会泄漏给子代理**（子代理压缩父会话是越权）。
31. **S7 落库复用压缩同一套纪律**：运行态代际守卫（导入替换后旧写入作废）+ `markCompactionCuts` + 脏标记 + 节流 flush + SSE 广播。`read_original` 对非文本 part 只报真实 token 尺寸，绝不把 base64 灌回模型视野；超单次预算时**第一条恒给**（哪怕它自己就超，否则模型永远取不到那条大消息），其余显式列出 id 与尺寸让模型分批复取——静默丢弃会让模型以为"原文里没有这句话"。
32. **S5–S7 收口验证（2026-11-20）**：`pc-server` 全量 `bun test` → **2954 pass / 9 skip / 2 fail**，两条失败是既有的 Windows `C:\WINDOWS\Temp` EPERM flake（`workspace/runtime.test.ts` 的"宽界 write"/"宽界无黑名单"，单跑复现 `EPERM: operation not permitted, open 'C:\WINDOWS\Temp\rkh-allow-test.txt'`），非回归。两侧 `typecheck` 均 0 错（pi 内部诊断 46 条按既有口径滤除）。前端 `bun test app` → **586 pass / 0 fail**。
    - 顺手修了两处**自己写的**测试类型缺口（`pi-route.test.ts` 里 `Record<string, unknown>` 的宽 cast 与 `id?: string` 数组），不是语义改动。
    - 搜索索引的 `keywords` 选项是 **locale key 后缀**（解析成 `settings:nav_search.keywords.<值>`），不是字面同义词串；第一版写成字面串被 `settings-search-index.test.ts` 当场抓红，已改为注册 `context_tools`/`context_nudge` 两条同义词。

### 仍待定（不挡已落地部分）

7. ~~S5/S6 是否做、S7 是否值得为工作区单独加一套工具面~~ → 2026-11-20 用户批准"继续做之前没做完的开发"，S5/S6/S7 均已落地（默认关的 S7 需用户自行开启）。
8. ~~S4b：应急截断提到预算头切之前~~ → 已改，见落地后记 19。
9. **S7 实机验收待做**：需在工作区会话里开启 `contextTools`，用 Mock 供应商脚本化驱动 `compress`/`read_original`/`decompress`，核对出站工具声明与 nudge 不落库。点火前必须先关 `enableSuggestion`/`titleGenerationEnabled`（落地后记 18 的教训）。

---

## 8. 附录：故事 JSON

```json
{
  "stories": [
    {
      "id": "S1",
      "title": "计费口径修正：CJK 覆盖、图片 tile、工具声明",
      "dependsOn": [],
      "fitsOneRun": true,
      "tasks": [
        "扩 estimateTokens 正则与系数至 1.0，同步 web-ui/app/lib/compaction.ts 镜像",
        "新增 inference-engine/image-tokens.ts：容器头解析尺寸 + tile 公式 + memoize",
        "contextTokensOf 累加图片 token",
        "estimateAutoCompactContext / estimateEncodedContext 补工具声明体积",
        "新增 image-tokens.test.ts，重钉 utils.test.ts 与前端镜像测试"
      ]
    },
    {
      "id": "S2",
      "title": "按供应商 usage 学习校准系数 k̂",
      "dependsOn": ["S1"],
      "fitsOneRun": true,
      "tasks": [
        "新增 token-calibration.ts：样本环 / 准入 / 钳制 / 原子写 pc-data/token-calibration.json",
        "出站记 localEstimate，usage 到达处配对（拒收 estimated）",
        "触发估算 / 预算窗口 / 硬闸消费 k̂，UI 圆环不乘",
        "新增 token-calibration.test.ts 覆盖准入与钳制双向"
      ]
    },
    {
      "id": "S3",
      "title": "预留跟输出上限走 + 聊天路径输出钳制",
      "dependsOn": ["S1"],
      "fitsOneRun": true,
      "tasks": [
        "reserveTokensFor(window, outputLimit) 与 compactionThresholdFor 改造",
        "服务端下发预留，前端 contextWarningPercent 优先消费 + 老数据回退",
        "requiredOutputCap 减 1.12×prompt + max(2048,5%)，<1024 则不发字段",
        "重钉 engine-compaction-threshold.test.ts 与 model-limits 测试"
      ]
    },
    {
      "id": "S4",
      "title": "常开应急截断与发送前兜底",
      "dependsOn": ["S1", "S3"],
      "fitsOneRun": true,
      "tasks": [
        "emergencyTruncateToolOutputs 纯函数：95% 触发 / 最大优先 / 头尾 2000 / 排除项",
        "接进 enrichMessages，常开且 latch 逐字节重放",
        "硬闸改常开，判定口径放宽到原生窗口",
        "新增 emergency-truncate.test.ts，双向断言触发与不触发"
      ]
    },
    {
      "id": "S5",
      "title": "压缩记录块化 + 摘要就地锚定渲染",
      "dependsOn": ["S4"],
      "fitsOneRun": false,
      "tasks": [
        "记录追加 startMessageId/tier/active/consumedRecordIds，旧记录按 v1 解释",
        "生效判定从 .at(-1) 改为 active 块按锚点排序",
        "逐块就地渲染摘要，钉住消息附到所属块",
        "时间线多摘要卡 + 前端分割线/锚点逻辑扩展",
        "断言再折叠不改写更早块的出站前缀"
      ]
    },
    {
      "id": "S6",
      "title": "分层再蒸馏：每段原文只折一次",
      "dependsOn": ["S5"],
      "fitsOneRun": true,
      "tasks": [
        "再浓缩改为消费 active 块生成上层块，子块置 active=false 保留血统",
        "提示词补 KEEP/DROP 与逐字引用带 id 规约",
        "8 轮连续压缩 mock 断言无几何衰减、块可按 id 恢复"
      ]
    },
    {
      "id": "S7",
      "title": "工作区模型驱动压缩工具面 + 无损召回",
      "dependsOn": ["S5", "S6"],
      "fitsOneRun": false,
      "tasks": [
        "注入 context_status/compress/search_context/decompress/read_original，默认关",
        "nudge：不报百分比、带真实尺寸、临时尾部消息不落库",
        "压缩哲学进系统提示词，增速阈值按 rdp 语料定标",
        "范围校验错误作为工具结果回给模型重试",
        "mock 脚本化调用全链路验收 + 关闭开关后工具面消失"
      ]
    }
  ]
}
```