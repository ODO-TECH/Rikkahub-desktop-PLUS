# 仿生记忆整合：双车道记忆架构（方案，未实施）

- 版本：方案 v1（2026-11-06）
- 状态：**待批准，未动任何代码**。本文只定义目标架构、采纳/拒绝清单与 S1–S10 的可执行故事。
- 范围：聊天引擎的长期记忆（`pc-server/memory/*` 与实验档 `memory/experiment/*`），以及它与上下文压缩、召回缓存、模型工具面的衔接。
- 命名：现有「实验性记忆（失真 / 遗忘）」对外改称**仿生记忆**；存储键、API 路径、实验 flag 一律保持 `memoryExperiment*` 不变（避免全量数据迁移）。
- 关联：**DSH 插件形态**（独立自带引擎、需同时支持 dsh-web 与 dsh-tui）是另一份交付，见 `../dsh-bionic-memory/PLAN.md`；本文只覆盖 rdp 内置实现，两者共享算法但不共享代码。
- 前置决策（沿用讨论结论，可直接在 §11 推翻）：
  1. **不接 Supermemory 云服务，也不部署它的自托管二进制**；只搬算法纪律。
  2. **不落 L0 文本副本**：原始证据就是会话原文 + 全文索引，记忆侧只存指针。
  3. **精度档不静默切换**：自动检测只给建议，由用户确认；会话内粘性。

---

## 0. 结论先行

把「记忆」从一个扁平条目库改成**证据层 → 语义层 → 折叠视图**三层单向派生，并用**双车道注入**同时满足两个互相矛盾的目标：仿生车道负责上下文瘦身（有损、按时间粗化），工程车道负责高精度（无损、逐字、可回指）。两条车道共用同一份数据、同一个写入口、同一个门控咽喉。

三条不可让渡的红线（直接作为验收标准）：

1. **单向派生**：折叠 / 粗化 / 合并只能新增派生行，源条目的 `content` 永不被改写或删除；任何摘要都可沿指针回到原文。
2. **逐字锁是代码不变式**：`verbatimLocked` 条目不进折叠计划、不被预算截断、不被遗忘；这条由计划器、注入面、应用器三处独立拒绝来保证，不依赖模型配合。
3. **单一写入口与单一门控**：所有采集源（手动 / 工具 / 压缩候选 / 新增的回合信号）都进 `pc_memory_pending`，所有实验行为仍走 `gate.ts`；总开关关闭时与上线前逐字节一致。

判断权归人沿用自主循环的纪律：档位、锁定、遗忘确认由用户决定，模型只能提议。

---

## 1. 现状诊断（证据）

| 环节 | 现状 | 位置 |
| --- | --- | --- |
| 写入来源 | 只有 `save_memory` 工具与用户手动两条；**没有回合级自动沉淀** | `pc-server/tools/definitions.ts:113-168`；`memory/write.ts` |
| 模型工具面 | 仅 1 个写工具；模型**无法检索、展开、追溯、遗忘**记忆 | `pc-server/tools/definitions.ts:126` |
| 注入面 | 可见记忆整体 `JSON.stringify` 注入，**无字符预算、无配额、无长度钳制**；向量关闭（默认）时即全量 | `memory/index.ts:1066-1090`（`buildMemoryPrompt`） |
| 注入排序 | 仅按 `updatedAt` 倒序；**无 importance、无 useCount、无时效加权** | `memory/index.ts:1038` |
| 召回 | 混合 0.45 词法 + 0.55 余弦，CJK 2-gram，邻居扩展 5 种子 / 0.78 / ≤10，可选重排；失败退回全量 | `memory/recall.ts:17-22,201-210,264-273` |
| 前缀缓存 | 召回选择按会话冻结，key = `assistantId + modelKey + generation` | `memory/recall-cache.ts` |
| 去重 | Kelivo Smart Add（NEW/MERGE/SKIP），候选只用于判重，**不用于生成更新版内容** | `memory/dedup.ts:117-186` |
| 自动整理 | 每 N 轮水位触发（默认关），cos≥0.82 提示对，≤30 个合并/删除操作 | `memory/organize.ts`；`conversations/orchestrator.ts:1633` |
| 合并语义 | `applyConsolidation` 直接**移除源条目**，谱系不常驻 | `memory/index.ts:621-666` |
| 折叠护栏 | **无净缩小校验**，无「失败 ≠ 空」语义，无退避 | `memory/organize.ts`；`conversations/auxiliary.ts` |
| 仿生保护 | 按类别：`setting` / `explicitRemember` 永不遗忘，`habit` 可 stale，仅 `event` 可遗忘 | `experiment/entry.ts:60-95` |
| 仿生维护 | `fidelity / coarsen / theme_merge`，7 / 14 天周期，30 天宽限，墓碑审计 + 撤销 | `experiment/maintenance.ts:41,295-446`；`forget.ts` |
| 关系与谱系 | `pc_memory_edge` 只有 `merged_into` / `related`，且只在实验档写入；未暴露给模型或面板 | `experiment/mentions.ts:576`；`forget.ts:411` |
| 命名空间 | 只有 `__global__` 与助手两层，**无工作区 / 项目维度** | `memory/sqlite.ts:36-44` |
| 压缩候选 | 压缩后 LLM 抽取只进 pending，按 (conversation, cut) 幂等 | `experiment/compaction-candidates.ts:80-105` |
| 质量度量 | 基线 2598 项功能测试，**没有任何召回质量分数** | `docs/` 无记忆基准；参照 §9 |
| 已知 flake | Windows 下 `bun test` 恒定 2–3 败（`C:\WINDOWS\Temp` EPERM、e2e EBUSY），非回归 | 见 §10 验收命令注记 |

---

## 2. 参照的采纳与拒绝

### 2.1 dsh-memnexus（本地、分层蒸馏、面板）

| 参照条目 | 处置 | 落到 rdp 的形式 |
| --- | --- | --- |
| 注入预算 `recallMaxChars=1400` + 每层配额 + 单行 400 字截断 + **超长行 `continue` 跳过而非 `break`** | 采纳 | S1；预算默认 2000 字（见 §6），按 `kind` 配额 |
| 打分 `relevance×12×层权重 + importance×0.6 + min(useCount,10)×0.2 + max(0,3-ageDays/10)` | 采纳公式，权重按双车道改写 | S2；`importance` 1–5 只作加分项不作排序键 |
| `captureMaxChars`（200–6000，默认 1200）+ 存量瘦身脚本（保留 `rawChars`） | 采纳 | S1；写入钳制 + 一次性迁移命令 |
| 净缩小护栏 `NET_SHRINK_TOLERANCE=1.05`、`MIN_SCENE_CHARS=8` | 采纳 | S3；折叠 / 粗化 / 压缩摘要共用同一判定函数 |
| 截断即二分批重试（≤3 层）、空回复分级重试（总预算 4）、失败退避 10 分钟、**失败不标记为已处理** | 采纳 | S3；整理与压缩候选共用重试器 |
| `looksLikeBoilerplate` + 提示词禁样板（含「`danger-full-access` 必须加锚，否则吞掉真约束」的教训） | 采纳 | S6；正则黑名单 + 工具描述补充 |
| `distillRules`（≤20 条 × 200 字，压过默认规则） | 采纳 | S6；助手级，设置卡内折叠区 |
| `memory_lineage` / `sourceIds` 传递闭包 | 采纳并改造 | S4/S5；改为指针 + 边，不存文本副本 |
| **L0 回合文本副本（JSONL）** | **拒绝** | rdp 会话原文只增不删且有全文索引；副本是 DSH 没有会话索引时的补丁 |
| **召回文本每步重算** | **拒绝** | rdp 的按会话冻结已解决其头号遗留问题，S8 只允许扩展 key 不允许解冻 |
| 面板删除 = 物理删除；append-only 无并发保护；单实例约束 | **拒绝** | rdp 已有墓碑、宽限期、撤销、SQLite 事务 |
| 无向量语义检索，语义靠外接 Hindsight | **拒绝** | rdp 已有混合 + rerank，不再引入第二套检索后端 |
| 蒸馏只按条数触发 | **拒绝** | 沿用 N 轮水位 + 手动 + 压缩后候选三触发 |

### 2.2 dsh-supermemory（云端 Supermemory 客户端）

| 参照条目 | 处置 | 落到 rdp 的形式 |
| --- | --- | --- |
| 增量游标且**写入成功后才推进** | 采纳 | S6；复用 `pc_memory_organize.watermark` 的形态，新增回合游标 |
| 信号词闸门 + `turnsBefore` 窗口 + 100 字下限 | 采纳 | S6；成本闸门，全部进 pending |
| 会话内 seen-hash 去重（`recalled.json`，上限 500） | 采纳 | S8；动态召回不重复注入同一条 |
| `includeSubagents` 默认 false（子代理不召回不采集） | 采纳 | S6；与自主循环的权限边界一致 |
| 状态命令做**活体探针**，把 401/403 大声解释为「能连上但凭据已撤销」 | 采纳 | S5；设置卡新增「试一次」探针（嵌入 / 重排 / 记忆模型） |
| `◪` 来源标记 + 「与当前请求冲突时以当前请求为准」 | 采纳 | S1；注入块统一标注，附 stale/未核实标记 |
| 容器 tag 归一化（git remote → `repo_<name>__<16hex>`，worktree 隔离） | 采纳其**维度**，不采用其推导 | S9；用 rdp 自己的工作区 id，不引入 git 依赖 |
| 检索侧 `query rewrite`、`rerank: aggregate`、`threshold` 低地板 | 采纳 | S2/S8；`aggregate` 是瘦身车道的合成入口 |
| **检索增强抽取**（`group` 过滤：已有 profile + 相似记忆作为抽取上下文；同 id 再入判为更新） | **采纳，优先级最高** | S7；把 `dedup` 候选池复用为生成上下文 |
| 事实图 `updates / extends / derives` + `isLatest` 单指针 + 自动遗忘 | 采纳 | S4；扩展 `pc_memory_edge`，新增当前真相指针 |
| `dreaming: dynamic / instant`（异步批整理） | 概念同源，**不新增机制** | 现有 N 轮水位 + 维护阶梯即等价物，且多了提案与 dryRun |
| **云端 API / 托管 MCP / Connectors** | **拒绝** | 数据与每次注入前的网络往返都不该依赖第三方 |
| **自托管 `supermemory-server` 二进制** | **拒绝** | 官方自述闭源（separate, non-public codebase）、lite license 上限 10,000 文档、自托管无 MCP/Connectors、Windows 停在 0.0.8；搬过来是黑盒换机房 |
| 把记忆接进 `RAG on docker`（Qdrant / knowledge-mcp） | **拒绝** | 该栈服务文档语料（切块、文件监听、只读 top-k）；记忆是短条目、高频写、带状态机与谱系，两者分层见 §3.4 |

---

## 3. 目标架构

### 3.1 三层单向派生

```
证据层（已存在）  会话原文 + 全文索引 + 压缩切点记录（非破坏式）
      ▲  指针：sourceConversationId + sourceCutMessageId（已有字段）
      │
语义层  pc_memory：content（不可变）+ kind/status + verbatimLocked + importance
      │  + useCount/lastUsedAt + verifiedAt + scope(global/assistant/workspace)
      │  pc_memory_edge：updates / extends / derives / merged_into / related
      │  isLatest：当前真相指针（updates 链的头部）
      │
视图层  派生行（折叠 / 粗化 / 场景 / 画像），derives 指回语义层
      │  只增不改；瘦身车道默认注入视图层，工程车道注入语义层
      ▼
注入面  预算 + 配额 + 打分 + 车道选择 + 按会话冻结（key 增加 precisionMode）
```

### 3.2 双车道

| 参数 | 仿生车道（默认） | 工程车道（高精度） |
| --- | --- | --- |
| 注入内容 | 视图层 + 全部 `verbatimLocked` 原文 | 语义层全部 active 原文，逐字 |
| 字符预算 | 默认 2000，可按 kind 配额、超长跳过 | 默认 8000；锁条目**不受预算裁剪** |
| 排序 | relevance + importance + 使用 + 时效 | 同上，但锁条目恒在预算外置前 |
| 合成 | 允许 `aggregate`（多条合成一段） | 禁止合成，逐字 |
| 遗忘调度 | 按 7 / 14 / 30 天阶梯 | **暂停**（本会话相关条目不生成 coarsen/merge 提案） |
| 召回 | 冻结复用；动态召回可开 | 每轮强制动态召回，`dynamicRecallTopK` 上浮（默认 6→12） |
| 工具面 | `save_memory` + 只读检索 | 另加 `memory_expand` / `memory_lineage` / `memory_forget`（写需审批） |
| 提示词 | 常规 + 来源标记 | 另加「记忆是假设：路径 / 版本号 / 配置先用工具核实再改」 |

### 3.3 切档规则

1. **显式档**：会话级开关，默认继承助手预设；切换写会话记录，可复现。
2. **自动建议**：仅用确定性信号——本会话出现过写文件 / bash / 沙箱 / 子代理工具调用即建议切工程档，**不静默切换**，不打断流式。
3. **单轮展开**：模型或用户对单条记忆调 `memory_expand`，把证据层原文拉进当轮，不改档位。
4. **缓存一致性**：`precisionMode` 进 `recall-cache` 的 key；工程车道仍然冻结（换内容不换稳定性），切档不使旧缓存失效，只另开一份。

### 3.4 记忆层与知识层的边界

- 记忆层（本文）：短条目、高频写、带 `status` / 锁 / 谱系 / 宽限期 → 留在 `rikka_hub.db` 的记忆表。
- 知识层（既有 `RAG on docker`、PageIndex、NAS）：只读文档语料（课本、资料、检索库）→ 继续走 MCP 检索，**不作为记忆写入后端**。
- 唯一允许的交叉：工程车道里模型可以主动检索知识层；知识层不回写记忆，除非经 pending 队列。

---

## 4. 数据模型增量

| 字段 / 结构 | 类型 | 语义 | 引入故事 |
| --- | --- | --- | --- |
| `verbatim_locked` | INTEGER 0/1 | 逐字锁；人工或规则（数字 / 路径 / 命令 / 否定句 / 用户原话）自动上锁 | S3 |
| `importance` | INTEGER 1–5 | 默认 2；只作加分项 | S2 |
| `use_count` / `last_used_at` | INTEGER / TEXT | 注入命中计数与最近命中时间（批量落盘） | S2 |
| `verified_at` | TEXT NULL | 高精度语义的「上次核实」时间；注入时展示陈旧度 | S5 |
| `is_latest` | INTEGER 0/1 | `updates` 链当前真相；旧事实保留但默认不注入 | S4 |
| `derived_from` | INTEGER NULL | 派生行的直接源；与 `derives` 边一一对应 | S4 |
| `pc_memory_edge.kind` | 扩展枚举 | 新增 `updates` / `extends` / `derives`，保留 `merged_into` / `related` | S4 |
| `precision_mode` | 会话字段 `bionic\|engineering` | 默认 `bionic`；进召回缓存 key | S8 |
| `scope=workspace` | 第三命名空间 | 以 rdp 工作区 id 为键，不引入 git 推导 | S9 |
| `pending.origin` | 扩展枚举 | 新增 `turn`（回合信号采集），保留 `manual/tool/compaction` | S6 |
| 回合游标 | 表字段 | 仅在该回合成功入库后推进 | S6 |

不变式（进测试）：`content` 一经写入只能由用户编辑改变；派生行删除不影响源行；`is_latest=0` 的条目只在「历史提问」模式下可见；`tombstone` 任何模式不可见（沿用现有）。

---

## 5. 注入面算法（S1 / S2 / S8 的合流）

```
score = relevance × 12
      + importance × 0.6
      + min(useCount, 10) × 0.2
      + max(0, 3 - ageDays / 10)
      + verbatimLocked ? 1000 : 0        // 锁条目恒前，但仍受「锁条目不裁剪」保护
```

1. 先按 `precision_mode` 选池：仿生=视图层 + 锁原文；工程=语义层 active。
2. 逐条渲染单行（带 `id`、`kind`、`status`、`verifiedAt` 陈旧标记），单行超 400 字截断（锁条目除外）。
3. 按 kind 配额与总预算装袋；**超预算的行 `continue` 跳过**，不掐断后续短行。
4. 仿生车道可选 `aggregate`：对得分相近的多条做一次合成调用（记忆场景模型），合成结果同样受净缩小护栏约束。
5. 结果按会话冻结；动态召回追加时按 seen-hash 去重。

---

## 6. 硬保证与只能降险（对外承诺口径）

**硬保证（代码可断言，逐条进测试）**

- 源条目 `content` 不被任何自动流程改写；折叠 / 粗化 / 合并只产生派生行。
- `verbatimLocked` 不进折叠计划、不被预算截断、不被遗忘；三处独立拒绝。
- 任何摘要 / 合成 / 粗化产物必须满足净缩小（>1.05× 源字数即拒收），否则保留源、记录拒绝原因。
- 模型调用失败、超时、空回复、被截断：**绝不**标记为已处理，绝不推进游标。
- 总开关关闭时与现状逐字节一致；`dryRun` 下不改任何数据（沿用现有纪律并扩展到新字段）。
- 注入预算在任何车道都生效；工程车道的提高有上限，锁条目例外是唯一出口。
- 所有采集源只进 pending，直写路径只有用户确认与现有手动/工具路径。

**只能降险（不得对外承诺）**

- 抽取召回率、`kind` 分类正确率、否定句在摘要中的存活率。
- 工程会话自动识别（写工具信号会漏判纯问答式的架构讨论）。
- 折叠视图的语义漂移、`aggregate` 合成的事实保真。
- 画像层的抽象失真（默认深度停在场景层，画像需显式开启——与 memnexus 的克制一致）。

---

## 7. 非目标

- 不接入任何云端记忆服务，不引入 Supermemory 自托管二进制，不新增向量数据库进程。
- 不把记忆写进 Qdrant / knowledge-mcp / PageIndex；不改动这些知识层服务。
- 不改 `save_memory` 的既有写入策略五档语义、不改待确认队列上限与批量操作契约。
- 不向安卓导出新增字段的语义（沿用现有剥离规则；新字段默认剥离）。
- 不新增自动审批、不引入「记忆模型自评即通过」的判定。
- 不在本期做画像层的默认开启、不做跨助手记忆自动合并。

---

## 8. 分期与验收（S1–S10）

每期独立可验收、可单独回滚；除标注外默认关。验收统一命令见 §10。

- **S1 注入预算与长度钳制**：预算 + kind 配额 + 单行截断 + 超长跳过 + 写入长度钳制 + 存量瘦身（保留 `rawChars`）+ 来源标记与「以当前请求为准」。验收：构造 200 条混合长度记忆，注入字符数 ≤ 预算且短条目未被长条目挤出。
- **S2 记忆打分元数据**：`importance` / `useCount` / `lastUsedAt` 落库与批量落盘，打分公式接入 S1，检索侧加查询重写开关。验收：同 relevance 下高 importance 靠前；锁条目不参与比较。
- **S3 逐字锁与折叠护栏**：`verbatim_locked`、自动上锁规则、三处拒绝、净缩小判定函数、失败≠空 + 二分批重试 + 退避。验收：锁条目在整理 / 维护 / 注入三条路径上均不可被改写或裁剪；模型超时后条目仍未处理。
- **S4 折叠改派生 + 关系语义**：派生行 + `derives` 边、`updates / extends` 边、`is_latest`、`applyConsolidation` 不再删源（保留旧行为开关用于迁移）。验收：执行一次 theme_merge 后源条目仍在且可检索，派生行可回指；旧 `merged_into` 审计可回放。
- **S5 证据工具面与探针**：`memory_search` / `memory_lineage` / `memory_expand` 只读免审批（写需审批）、`verified_at`、设置卡「试一次」活体探针（401/403 大声报错）。验收：模型能在不解除冻结的情况下取回任意一条的证据原文。
- **S6 采集单入口扩展**：`origin=turn`、信号词闸门 + 窗口 + 100 字下限、成功后推游标、样板过滤（含锚定规则）、助手级 `distillRules`、子代理默认排除。验收：连续 5 回合只产生 1 条 pending；写入失败重试不丢回合；样板句不入库。
- **S7 检索增强抽取**：复用 dedup 候选池 + 当前画像作为抽取上下文，产出「更新版」而非新增，同 id 判更新。验收：对同一事实两次表述，第二次生成 updates 边而非新条目；无相似候选时行为与现状一致。
- **S8 精度档**：`precision_mode` 入缓存 key、双预算表、工程车道暂停遗忘、动态召回强制 + 上浮、seen-hash 去重、`aggregate` 开关、自动建议不静默。验收：切档后注入面按表变化且前缀缓存各自稳定；工程车道中维护计划对相关条目零提案。
- **S9 工作区命名空间**：`scope=workspace` 第三层、注入/去重/整理同 scope 隔离、助手默认绑定工作区。验收：跨工作区不串味；同工作区多会话共享。
- **S10 质量基准**：以 `supermemoryai/memorybench` 口径建 provider（先核 license 与接口），本地题库 ≥40 题，指标=命中率、被动注入召回率、注入占输入比、**锁条目逐字保真率（必须 100%）**、指针可回指率（必须 100%）。验收：CI 可跑；两个车道各出一组分数；后两项失败即红。

依赖：S2←S1；S4←S3；S5←S4；S7←S6；S8←S1,S3,S4,S5；S9←S4；S10 的题库骨架可与 S1 并行，断言随各期接入。

---

## 9. 基准与门槛

- 复用外部口径而非自造：`memorybench`（可插拔 provider × benchmark）+ 同生态 `DSH-MemBench` 的四项指标命名，便于横向比较；云端 Supermemory 的分数只作参考，不作为目标（自托管版功能不全且 Windows 落后一版）。
- 门槛建议：锁条目逐字保真率 =100%、指针可回指率 =100%（硬指标）；工程车道命中率 ≥ 仿生车道 + 10 个百分点；仿生车道注入占输入比 ≤ 现状全量注入的 40%；两项软指标未达标只报警不阻断发布。
- 数据集必须包含：版本号 / 路径 / 禁令 / 否定句 / 过期事实 / 跨会话同名实体六类陷阱，各占不少于 5 题。

---

## 10. 验收命令与 flake 注记

- 单域回归：`cd pc-server && bun test memory`；全量基线：`bun test`（Windows 下恒定 2–3 败为既知 flake：`C:\WINDOWS\Temp` EPERM 需管理员、e2e EBUSY；smoke EBUSY 同为 flake，清锁走 `/api/app/shutdown`）。**不要把 flake 当回归做 bisect**；「单跑绿、合跑红」另有一类真 bug 是跨文件 `globalThis` 桩泄漏。
- 演示与手感：改动后重启 17455 demo（`demo-server.sh` 收口）；`shot-host` 事后退出码 1 属常态。
- 每次改动记忆写入路径都必须验证：关闭总开关后与基线输出逐字节一致（沿用现有实验纪律）。
- 记忆场景模型可能计费：基准与批量验收默认走本地 mock（参考 `127.0.0.2:18124` 的 compaction mock 形态），真实模型验收先报价再跑。

---

## 11. 待定决策（默认采用前置决策，可推翻）

1. 精度档的**默认值**：目前默认仿生车道。是否让「工作区会话」默认工程车道？（建议：不默认，仍由助手预设 + 自动建议。）
2. `aggregate` 合成是否允许消耗记忆场景模型额度：默认关，仅在仿生车道且条数 > 配额时触发；需确认成本口径。
3. S9 工作区层是否进入首批：S1–S8 已能独立成立，S9 可后置；若近期要多工作区并行，提前到 S5 之后。
4. `memory_forget` 是否进模型工具面：写操作需审批是底线，是否允许模型发起语义遗忘提案（只提案不执行）待定。

---

## 附录 A：可执行故事（JSON）

```json
{
  "feature": "仿生记忆整合：双车道记忆架构",
  "source": "docs/plan-bionic-memory.md",
  "codebase": "D:/Users Data/Desktop/rikkahub/rikkahub-desktop-plus",
  "stories": [
    {
      "id": "S1",
      "title": "注入预算、配额与长度钳制",
      "covers": [1, 2],
      "tasks": [
        "buildMemoryPrompt 增加预算与按 kind 配额装袋，超长行 continue 跳过，单行 400 字截断",
        "写入路径增加单条长度钳制（默认 1200，可配 200-6000）与 rawChars 记录",
        "提供一次性存量瘦身命令（只读预览 + --apply + 复验）",
        "注入块加来源标记与『与当前请求冲突时以当前请求为准』",
        "新增测试：200 条混合长度记忆下注入不超预算且短条目不被挤出"
      ],
      "executionFit": "fits-one-run",
      "demoBoundary": "向量关闭时注入字符数稳定受控，长条目不再吃满整段提示词",
      "scopeNotes": "只动注入面与写入钳制，不改记忆语义",
      "blockedBy": [],
      "techGuidance": "改 memory/index.ts:1066-1090；保留 recallApplied 分支与冻结复用"
    },
    {
      "id": "S2",
      "title": "importance / 使用计数 / 时效打分",
      "covers": [2],
      "tasks": [
        "pc_memory 增 importance/use_count/last_used_at 并做宽容规范化",
        "实现打分公式并接入 S1 装袋排序",
        "命中计数批量落盘（沿用 touch 语义，标注丢窗风险）",
        "检索侧加查询重写开关（默认关）",
        "设置卡内折叠区暴露 importance 编辑"
      ],
      "executionFit": "fits-one-run",
      "demoBoundary": "同相关性下高重要度靠前，使用频次影响可见但不垄断排序",
      "scopeNotes": "排序信号 only，不引入遗忘",
      "blockedBy": ["S1"],
      "techGuidance": "公式见 §5；importance 只作加分项"
    },
    {
      "id": "S3",
      "title": "逐字锁与折叠护栏",
      "covers": [3, 4],
      "tasks": [
        "新增 verbatim_locked 与自动上锁规则（数字/路径/命令/否定句/用户原话，规则加锚）",
        "merge-plan / maintenance / 注入面三处独立拒绝锁条目",
        "实现净缩小判定函数并在整理、维护、压缩摘要三处复用",
        "实现失败≠空：截断二分批（≤3 层）、空回复分级重试（总预算 4）、失败退避 10 分钟",
        "新增测试：锁条目三路径不可改写不可裁剪；超时后仍未处理"
      ],
      "executionFit": "fits-one-run",
      "demoBoundary": "含版本号与禁令的记忆在任何自动流程后仍逐字存在",
      "scopeNotes": "精度承诺的分界线，必须先于派生化",
      "blockedBy": [],
      "techGuidance": "NET_SHRINK_TOLERANCE=1.05、MIN_SCENE_CHARS=8、EXTRACT_MAX_TOKENS=3200 可照搬"
    },
    {
      "id": "S4",
      "title": "折叠改派生与关系语义",
      "covers": [3, 5],
      "tasks": [
        "新增 derived_from 与 derives 边，折叠/粗化改为新增派生行",
        "pc_memory_edge 增 updates/extends，新增 is_latest 与当前真相指针",
        "applyConsolidation 不再移除源条目，保留迁移开关",
        "历史提问模式可见 is_latest=0，普通召回不可见",
        "新增测试：theme_merge 后源仍可检索且派生可回指，旧审计可回放"
      ],
      "executionFit": "fits-one-run",
      "demoBoundary": "瘦身不再以丢失原文为代价，任何摘要都能走回源句",
      "scopeNotes": "单向派生的落地",
      "blockedBy": ["S3"],
      "techGuidance": "现状删源在 memory/index.ts:621-666；墓碑/宽限期语义不变"
    },
    {
      "id": "S5",
      "title": "证据工具面与配置探针",
      "covers": [5, 6],
      "tasks": [
        "新增 memory_search / memory_lineage / memory_expand 三个只读工具并免审批",
        "memory_forget 仅以提案形式暴露（写需审批）",
        "新增 verified_at 与注入陈旧度标记",
        "设置卡『试一次』活体探针：嵌入/重排/记忆模型，401/403 大声解释",
        "新增测试：冻结会话中模型仍可取回任意条目证据原文"
      ],
      "executionFit": "fits-one-run",
      "demoBoundary": "模型不用解冻注入面也能自查记忆与出处",
      "scopeNotes": "补足冻结优化带来的能力缺口",
      "blockedBy": ["S4"],
      "techGuidance": "探针语义参照 supermemory /v4/profile 的 8 秒超时与撤销解释"
    },
    {
      "id": "S6",
      "title": "采集单入口扩展（回合信号）",
      "covers": [1, 7],
      "tasks": [
        "pending.origin 增 turn，新增回合游标且成功后才推进",
        "信号词闸门 + turnsBefore 窗口 + 100 字下限 + 长度上限",
        "样板过滤（BOILERPLATE 规则加锚）与 save_memory 描述补禁样板",
        "助手级 distillRules（≤20 条×200 字，压过默认规则）",
        "子代理会话默认不采集不召回（可开关）",
        "新增测试：5 回合仅 1 条 pending；写失败重试不丢回合"
      ],
      "executionFit": "fits-one-run",
      "demoBoundary": "自动沉淀有成本闸门且绝不绕过待确认队列",
      "scopeNotes": "所有源仍汇进 pending，不新增直写",
      "blockedBy": [],
      "techGuidance": "游标推进顺序抄 supermemory（成功后 setLastCapturedSeq），不抄 memnexus"
    },
    {
      "id": "S7",
      "title": "检索增强抽取",
      "covers": [7],
      "tasks": [
        "把 dedup 候选池与当前画像拼装为抽取上下文",
        "抽取提示词要求产出更新版并给出目标 id，同 id 判更新",
        "写入时生成 updates 边并移动 is_latest",
        "无候选时退化为现有 Smart Add 行为",
        "新增测试：同一事实两次表述只产生一条当前真相"
      ],
      "executionFit": "fits-one-run",
      "demoBoundary": "重复与自相矛盾的记忆显著减少，且旧事实可追溯",
      "scopeNotes": "supermemory 唯一明显领先 rdp 的机制",
      "blockedBy": ["S6"],
      "techGuidance": "复用 memory/dedup.ts:117-186 的候选检索，不新增检索通道"
    },
    {
      "id": "S8",
      "title": "精度档与双车道注入",
      "covers": [2, 3, 8],
      "tasks": [
        "会话增 precision_mode 并加入 recall-cache key",
        "实现双预算表与工程车道锁条目预算外置前",
        "工程车道暂停相关条目的遗忘提案，动态召回强制并上浮 topK",
        "动态召回 seen-hash 去重；aggregate 合成开关（默认关，受净缩小约束）",
        "自动建议切档（写工具信号）但不静默切换",
        "新增测试：切档后两缓存各自稳定，工程车道对相关条目零维护提案"
      ],
      "executionFit": "fits-one-run",
      "demoBoundary": "同一份记忆库同时给出瘦身与高精度两种注入，且可复现",
      "scopeNotes": "双车道的总装",
      "blockedBy": ["S1", "S3", "S4", "S5"],
      "techGuidance": "工程车道仍冻结；前缀缓存不被切档打空"
    },
    {
      "id": "S9",
      "title": "工作区命名空间",
      "covers": [8],
      "tasks": [
        "新增 scope=workspace 与助手-工作区默认绑定",
        "注入、去重、整理全部按 scope 隔离",
        "备份/导出与安卓剥离规则同步",
        "新增测试：跨工作区不串味，同工作区跨会话共享"
      ],
      "executionFit": "fits-one-run",
      "demoBoundary": "『这条只在这个项目成立』成为一等语义",
      "scopeNotes": "可后置，不阻塞 S1-S8",
      "blockedBy": ["S4"],
      "techGuidance": "使用 rdp 自己的工作区 id，不引入 git remote 推导"
    },
    {
      "id": "S10",
      "title": "记忆质量基准",
      "covers": [9],
      "tasks": [
        "核 memorybench 的 license 与 provider 接口并写适配层",
        "建本地题库 ≥40 题，含六类陷阱各 ≥5 题",
        "实现四项指标采集（命中率/被动注入召回率/注入占比/token 节省）",
        "把锁条目逐字保真率与指针可回指率做成硬断言",
        "接 CI，默认走本地 mock，真实模型跑分先报价"
      ],
      "executionFit": "fits-one-run",
      "demoBoundary": "两条车道各有一组可复现分数，硬指标失败即红",
      "scopeNotes": "先解决『证明不崩』与『证明记得准』的鸿沟",
      "blockedBy": ["S3", "S4"],
      "techGuidance": "指标命名与 DSH-MemBench 对齐，云端 Supermemory 分数仅作参考"
    }
  ]
}
```

## 附录 B：参考来源

- `dsh-memnexus@0.0.5`（MIT）：分层蒸馏、`rank.js` 混合打分与缓存、`store.js` 预算与配额、`distill.js` 护栏与谱系、`docs/综合评估报告.md`（含其自述缺口与 DSH-MemBench 数据）。
- `dsh-supermemory@0.1.2`（MIT）：增量游标、信号闸门、seen-hash、容器 tag、活体探针、来源标记；官方文档 `concepts/how-it-works`、`concepts/graph-memory`、`concepts/super-rag`、`ingestion/add-memories`、`self-hosting/*`。
- `supermemory@5.1.2` SDK（Apache-2.0）：v5 API 语义（namespace、dreaming、searchMode、rerank、forgetMatching、group）。
- `supermemoryai/memorybench`：基准口径来源（接入前先核 license 与 provider 接口）。
- 本地参照：`docs/plan-context-compaction.md`（非破坏式切点与不变量写法）、`docs/plan-autonomous-loop.md`（红线、采纳/拒绝表、S 期验收格式）。
