# Flash 预设本地化：PTC 工具面、输出裁剪与循环/审计耦合

- 参照：`../reference/dsh-flash-presets`（GitHub `LarryE135/dsh-flash-presets`，MIT，v0.3.2）
- 日期：2026-11-20
- 状态：**方案待拍板**（只有决策 §7-1 需要单独确认；其余按「批准后连可选故事一起放行」执行）
- 前置：上下文压缩 v2 S1–S7（`docs/plan-context-compression-v2.md`）已落地；本文是它的**工具面续作**

---

## 0. 结论先行

参照项目省的是三类钱，rdp 缺的不是同一类：

1. **工具 schema 固定开销** —— 参照用"关插件 + PTC 单一工具面"。rdp 的 S10 工具发现已经动态做到了"schema 不进请求"，不需要再抄。
2. **工具结果进上下文的体积** —— 参照在**进上下文的时刻**无条件裁头尾（8 KB 阈值 / 头 4096 / 尾 1024 字符）。rdp 今天只有 95% 窗口的应急截断（逐 part、≥1000 token、最近 3 条豁免）和默认关的老化，**没有无条件裁剪**。这是最大且最安全的缺口。
3. **模型步数** —— 参照用 `run_code` 把一轮内多次调用折叠进一个程序（每个 program 一次模型步），并把 PTC 运行时改为会话内常驻（每 program 冷启 108 ms → ≈0，嵌套调用 44 → 15 ms）。rdp 的模型本来就能在一轮里发多个工具调用，缺的是**程序化编排**：在代码里分支/循环/过滤，只有结果进上下文。

**采纳**：无条件结果裁剪（双引擎）、`run_code` 程序化工具面（PTC，默认开、可关）、审计轮级汇总、自主循环消费轮级预算。
**拒绝**：0.25 压缩阈值（参照自己承认 109 次运行 0 次触发，是"备而不用"；rdp 的自动压缩线是窗口−预留，另有 S5–S7 的模型驱动压缩，不重复动刀）、关插件（S10 已覆盖）。

**一句话判断**：rdp 的省钱空间不在"再关几个工具"，而在**每条工具结果进上下文前的体积**和**每轮工具调用的步数**。

---

## 1. 参照项目证据（逐条可核）

| 结论 | 出处 |
| --- | --- |
| 四机制：轮次压缩 / 工具输出裁剪 / 关插件 / 行为纪律 | `docs/技术文档-省token四机制.md` 总览表 |
| 裁剪配置：`thresholdChars 8192 / headChars 4096 / tailChars 1024`，`head + 标记 + tail ≤ threshold` 否则抛错 | 同上「机制 2」 |
| 裁剪是**结果进上下文时逐条**生效，与轮次压缩（存量超阈值才触发）正交 | 同上「机制 2 vs 机制 1」对比表 |
| PTC：`tool-presentation: ptc`，`run_code` 是该面**唯一**暴露的工具 | `README.md:49-51`、`presets/flash-lean-ptc-v3.patch.yml:40` |
| PTC 运行时两档：`per-call`（默认）/ `persistent-in-memory`；每 program 冷启 108 ms，常驻后 ≈0；重名变量报错是常驻的已知代价 | `docs/架构改进-工具调用开销.md` §1、§3.5 |
| run_code 内部的 Promise.all **不并行**（PTC 自己的 JSON 通道不查并发标记） | 同上 §3.5 |
| 模型一步发多个**原生** tool call 时，只读并发标记有效且是 2.4× | 同上 §3.6 |
| 实测：标准 84.1% / 128.63M token；原生 PTC 85.0% / 98.0M（−23.8%）；lean-v3 Windows 84.1% / 83.77M（−34.9%，相对 PTC 再 −14.5%） | `README.md` 基准表 |
| 0.25 压缩阈值"备而不用"：109 次运行 0 次触发 | `docs/技术文档-省token四机制.md`「机制 1」 |

---

## 2. rdp 现状与差距（已核，带位置）

| 项 | 现状 | 差距 |
| --- | --- | --- |
| 工具 schema | S10 发现行：全集注册、默认只激活核心 + `search_tools`（`pi-engine/tool-discovery.ts`） | 已覆盖参照的"关插件"收益，不动 |
| 工具结果体积 | bash 尾 2000 行/50 KB、read 头 2000 行/50 KB、grep 100 命中/50 KB（`workspace/tools/*`）；应急截断 95% 窗口、头尾各 2000 字符、单 part ≥1000 token（`inference-engine/emergency-truncate.ts:31-41`）；老化默认关（`context-budget-config.ts:23-30`） | **没有"每结果无条件裁头尾"**；老化的 `toolAging` 只接在聊天通路（`conversation-encoding.ts:222-224`），**pi 通路没接**（`orchestrator.ts:1075-1081`） |
| 多调用 | 聊天：一轮 N 个调用**顺序**执行，无单批上限，`MAX_TOOL_STEPS = 256`（`tool-loop.ts:479-514`、`:67`）；pi：全部 customTools 标 `executionMode:"sequential"` → 整批顺序（`workspace-tools.ts:120`、pi `agent-loop.ts:409-424`） | 无程序化编排；只读工具也没有并行 |
| 自主循环 | 确定性判定表（`agent-loop/controller.ts`），轮边界计数（`tool-loop.ts:266`、`runner.ts:233-236`），无"轮级体积"输入 | 判定只看同参/同错签名，**看不到"这一轮工具输出有多大"** |
| 运行审计 | `pc_generation_run` + `pc_generation_run_event`；per-call 记录，无轮级汇总（`run-tracker.ts:288-357`、`run-store.ts:306` 摘要 ≤240 字符） | 没有"本轮 N 次调用 / 原始 X KB / 裁剪后 Y KB / 省 Z token" |
| per-tool token 账 | 只有请求级估算 + 工具声明总量（`token-calibration.ts:215`、`conversation-encoding.ts:54-62`） | 无 per-call 记账（本文不改这条，避免与计费口径纠缠） |

---

## 3. 设计

### 3.1 机制 A：工具结果常开裁剪（S-F1）

纯函数 `clipToolResultText(text, cfg)`：

- 阈值内原样返回（**逐字节不变**，保证前缀缓存稳定）。
- 超阈值 → `头 headChars + \n[... middle clipped: N chars — original stays in the timeline; use read_original / read with offset to recover ...]\n + 尾 tailChars`。
- 硬约束 `headChars + markerLen + tailChars ≤ thresholdChars`，不满足直接抛配置错误（照抄参照的校验，防"裁完反而更长"）。
- 默认 `threshold 8192 / head 4096 / tail 1024`。

落点：**富化层**（`inference-engine/message-enrichment.ts`），位置在结构窗口之后、老化之前（新增 1.2 步，老化顺延）。理由：富化层是"发送面"的唯一入口，DB/时间线/导出逐字不动——与老化、应急截断同一条纪律。

同时补齐 **pi 通路的老化缺口**：`orchestrator.ts` 的 `enrichMessages` 调用补 `toolAging`（与聊天通路同一份配置）。

- 配置：`contextBudget.resultClip = { enabled: true, thresholdChars, headChars, tailChars }`（默认开）。
- 裁剪标记带恢复指引；若 `contextTools` 开启，指引指向 `read_original`，否则指向 `read ... offset`。
- 边界：只裁 `type === "tool"` 的文本条目；error 条目、pending 条目、图片原样（与老化同口径）。

### 3.2 机制 B：PTC 程序化工具面（S-F2，仅工作区，默认开）

**模型看到什么**：注册面仍是全集（执行器需要），但激活面只留 `run_code` + 不可包装的工具（`ask_user`、`update_plan`、子智能体、MCP、上下文工具）。复用 S10 的 `initialActiveNames` / `setActiveToolsByName` 原生机制，不新造开关。

**`run_code({ code, timeoutMs? })`**：

- `code` 是一段 JavaScript（ES2022）；运行时注入唯一的 `tools` 对象与 `console`。
- `tools.*` = 当前激活集里**可包装**的 8 个工作区工具 + 上下文工具（`context_status` / `compress` / `search_context` / `read_original` / `decompress`）。签名与 JSON Schema 完全同源——程序里的调用**就是** `ToolDefinition.execute`，不重写第二套内核。
- **调用形态是同步的**（asyncify：宿主 await 对 VM 透明），所以 `const r = tools.bash({...})` 直接拿到结果；写 `await` 也不报错（await 非 Promise 值原样返回）。
- 返回：`{ ok, result, logs: [...], calls: [{ name, ok, ms, bytes }] }`，整体再过机制 A 的裁剪。
- 运行时：**每次调用新建一个 QuickJS 模块 + context**（实测 5–7 ms），超时/崩溃互不影响；不做跨调用常驻——参照的 REPL 语义正是它自己记录的重名变量坑。
- 超时：默认 60 s，`timeoutMs` 上限 600 s。**deadline 必须在 eval 前算好**并喂给 `setInterruptHandler`（CPU 死循环会阻塞事件循环，定时器方案无效，已实测）。
- 失败兜底：连续 2 个程序因语法/运行错误失败 → 本会话剩余生成**自动回退直连工具面**（并告知模型），不把用户卡死在坏模式里。

**审批（这是唯一需要拍板的地方，见 §7-1）**：
- 采用**与 bash 同级**的保证：`run_code` 整体按当前权限档位走一次审批（`confirm_each` 每个程序一张卡；`balanced` 按现有矩阵）。用户看到的是程序全文，等价于看到一条 bash 命令。
- 程序内部**不再逐次弹卡**：这是 PTC 的定义（一次审批一个 program）。
- 需要逐次审批的工具（如子智能体、MCP 写操作）**不进包装面**，程序调用它们会被拒绝并给出"请直接调用"的可操作错误。
- 明确不承诺：**不是沙箱**。程序在 worker 里有 Bun 的宿主权限（与 bash 同级，不高于）。若要硬沙箱，得引 QuickJS/WASM 内核并重做异步桥——按 §7-1 的裁决执行。

**系统提示**：新增常量段 `<tool_programming>`（同 `contextToolsSystemPrompt` 的冻结纪律），说明：一次程序尽量多调用、只把需要的字段 `console.log` 出来、重名变量陷阱、单调用也要走一行程序（参照规则 7 的实测结论：折叠在 ≥2 次调用时才有收益，但维持单一工具面更稳定）。

### 3.3 机制 C：只读工具并发（S-F3，小改动）

pi 的并行调度是"批内任一 `sequential` → 整批顺序"（pi `agent-loop.ts:417-423`）。把 `read` / `read_files` / `grep` / `find` / `ls` 的 `executionMode` 改为 `"parallel"`（默认值），写类工具保持 `sequential`。

- 收益：模型一步发多个只读调用时真实并行（参照实测 2.4× 墙钟）。不省 token，省时间。
- 风险：审批卡"一次一张"的节奏只对写类成立——只读工具审批恒 auto，不受影响。
- 开关：并入 PTC 同一个 `ptc.enabled`？不。单独 `workspaceTools.readParallel`（默认开），可关。

### 3.4 机制 D：审计轮级汇总（S-F4）

在 `run-tracker.ts` 现有 per-call 事件之外，新增一条 `round_summary` 事件（同表，`kind = "round_summary"`）：

```
{ round, calls, okCalls, resultBytesRaw, resultBytesClipped, savedTokensEst, programCalls? }
```

- `resultBytesRaw/Clipped` 由富化层与 `run_code` 的 `calls[]` 共同上报；聊天通路没有 PTC，`programCalls = 0`。
- 不存工具输出正文（沿用现有纪律）；摘要 ≤240 字符不变。
- API：现有 `.../agent-runs/events` 自动带出；前端审计页新增一列"本轮体积"，不新开页面。
- 只登记 `agentLoop.enabled` 时（与现有 run 记录同门控），关闭时零写入。

与自主循环的耦合：`controller.evaluateToolRound` 的输入增加 `roundSummary`：
- **预算刹车**（新设置 `roundBudgetTokens`，默认 0 = 关）：单轮 `savedTokensEst` / 原始体积超阈值时注入一次"收口"提示（`inject`），重复超限 → `halt awaiting_user`。这是参照 v4b"回合刹车"的等价物，但用的是真实体积而不是轮数。
- **停滞判定不变**：同参同输出仍是主判据；PTC 的嵌套调用把签名按 `run_code:子工具名+参数` 折叠后再比对，避免"外层程序同参但内部换了命令"被误判为停滞。

### 3.5 机制 E：与上下文压缩的耦合（S-F5）

1. **裁剪标记 ↔ `read_original`**：裁剪是视图层的，原文在 DB；`read_original` 本来就是无损召回的入口，标记文本直接指过去。这是一条真实的升级：今天应急截断的中段对模型不可恢复。
2. **PTC 程序里直接调用 `search_context` / `read_original`**：模型可以"搜到 → 在代码里过滤 → 只打印需要的一行"，整段搜索结果**从不进上下文**。这是 S7 与 PTC 组合后最大的单点收益。
3. **nudge 与审计共用一份体积口径**：`contextNudgeBlock` 的增量统计与 `round_summary.savedTokensEst` 用同一个纯函数（`conversationTokens`），避免两套数字打架。

---

## 4. 硬保证 vs 只能降险

**能保证（有测试钉）**

- 原文只增不删：裁剪只发生在富化层；DB、时间线、搜索索引、导出、备份看到的仍是全量原文（与老化/应急截断同一纪律）。
- 关闭开关 → 工具面与出站请求**逐字节**回到引入前：PTC 关闭时注册面不变、不注入系统段、不写审计。
- 审批不降级：不可包装的工具（需要逐次审批的）不会出现在程序 API 里；程序尝试调用 → 拒绝并给出直连指引。
- 程序崩溃/超时/死循环 → worker 被杀、会话其余工具不受影响，连续两次失败自动回退直连。
- 审计与循环关闭时零写入、零行为变化。

**只能降险（必须如实说明）**

- **沙箱是"VM 内无宿主 API"，不是"工具调用不越权"**：程序只能用注入的 `tools`，而 `tools` 仍走普通 `ToolDefinition.execute`——审批逐次弹卡（嵌套卡有自己的 toolCallId，与直连完全同一条状态机）、工作区边界与审计一条不少。
- **提示注入面**：可以被 bash 读到的不可信内容诱导写程序；但程序在 VM 内跑、调用同样受审批/边界的工具，不比 bash 更差。
- **模型能力依赖**：参照的数据来自 DeepSeek V4.1 Flash；rdp 的模型谱系更杂。默认开 + 两次失败自动回退是缓解，不改"弱模型可能不如直连"的事实。
- **0.25 压缩阈值不抄**：抄了只会让摘要费用提前发生，参照自己的数据也说它没触发过。
- **QuickJS 生态的固有边界**：asyncify 下嵌套的 asyncified 调用不能重新进 VM（我们的桥只有一个函数，满足）；VM 内没有 `setTimeout`/`fetch`，程序里不要用。

---

## 5. 分期与验收

### S-F1 结果裁剪常开 + pi 老化补齐（无新工具面，先落地）

- 新增 `inference-engine/result-clip.ts`（纯函数 + 配置校验），富化层接入；`orchestrator.ts` 的 pi 通路补 `toolAging`。
- 设置：`contextBudget.resultClip { enabled, thresholdChars, headChars, tailChars }`，默认 `true/8192/4096/1024`；安卓导出剥离；加载侧归一化；UI 在「上下文压缩」卡内加一组折叠项。
- 验收：`bun test inference-engine/result-clip.test.ts inference-engine/message-enrichment.test.ts`；断言：阈值内逐字节不变、超阈值头尾保留且中段标记、`head+marker+tail ≤ threshold` 校验、error/pending/图片不裁、DB parts 不动、pi 通路老化生效。

### S-F2 PTC 工具面（核心）——已落地（实现与原计划的差异见 §9）

- 新增 `pi-engine/quickjs-sandbox.ts`（硬沙箱执行体）、`pi-engine/ptc-surface.ts`（工具面/激活名收束/熔断）、`pi-engine/context-tool-names.ts`（叶子模块，打断循环依赖）；`orchestrator.ts` 把 PTC 面套在 `assemblePiToolDiscovery` 之前，两套激活名经 `restrictActiveNames` 合并成一份。
- 设置：`ptc { enabled: true, timeoutMs: 60000 }`（无 runtime 档位，固定 per-call）；PC-only，导出剥离。
- 验收：`bun test pi-engine/quickjs-sandbox.test.ts pi-engine/ptc-surface.test.ts` + `conversations/pi-route.test.ts` 的 PTC 全链路用例；断言：VM 内宿主 API 全 undefined、工具桥同步返回/异常可 catch、maxCalls/输出上限、死循环 deadline 打断、超时兜底、关闭 → 零改动、嵌套调用产生真实卡片且审批可点、熔断一次回退。

### S-F3 只读并发——未做（砍掉的理由见 §6）

### S-F4 审计轮级汇总——已落地

- `run-tracker` 新事件 `round_summary`（同表，无迁移）；体积口径与富化裁剪共用 `clipToolResultText` + `estimateTokens`；嵌套调用单计。
- 验收：`bun test agent-loop/run-tracker.test.ts`；断言：每轮恰好一条 `round_summary`、非终局帧不计账、失败结果不进 okCalls、摘要 ≤240 字符、终局前无条件结算最后一轮。

### S-F5 循环耦合——已落地（停滞折叠按"不需要"处理，见 §9）

- `AgentLoopSettings.roundBudgetTokens`（默认 0 = 关）；`evaluateToolRound(observations, roundSummary)` 消费轮级体积。
- 验收：`bun test agent-loop/controller.test.ts`；断言：0 = 关不干预、超预算先注入一次收口、连续两轮 → `awaiting_user`（kind=budget）、回落到预算内清零、硬停滞优先于预算提示。

### S-F6 设置面收口——已落地

- `extensions` 新增二级「工作区工具」页(`extensions/workspace.tsx`)：PTC 总开关 + 单程序超时(秒) + 六个 `workspaceTools` 契约开关(此前只有 API 面)。
- S-F1 的裁剪开关按原计划进「上下文压缩」卡(总开关 + 折叠区三数值)，`models/scenes` 搜索索引同步。
- `AgentBot` 页的自主循环折叠区新增「单轮体积预算」(0 = 关)。
- locale 两份(zh-CN/en-US，含 `nav_search.keywords`)、搜索索引新页与全部新行、`round_summary` 的审计图标与本地化文案。
- 验收：`bun test`(web-ui 586 全绿，含搜索索引全覆盖锁) + `tsc --noEmit` + demo 17455 实机结构核对(新页渲染、开关默认 on、折叠摘要正确、控制台无 React/i18n 报错)。

---

## 6. 设置与默认值汇总

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `resultClip.enabled` | `true` | 工具结果进上下文前裁头尾（**独立 slice**，不在 `contextBudget` 下——S-F1 落地时定为顶层，避免与老化开关互相门控） |
| `resultClip.thresholdChars` | `8192` | 低于此长度逐字节不动 |
| `resultClip.headChars` | `4096` | |
| `resultClip.tailChars` | `1024` | 头 + 标记上界 + 尾 ≤ 阈值（写入侧校验） |
| `ptc.enabled` | `true` | PTC 工具面，仅工作区会话；关闭 = 工具面/激活名/系统段与引入前逐字一致 |
| `ptc.timeoutMs` | `60000` | 单个程序墙钟上限，写入侧夹到 [5s, 600s] |
| `agentLoop.roundBudgetTokens` | `0` | 0 = 关；>0 时单轮体积刹车（超限先提示，连续两轮 → awaiting_user） |

`ptc.runtime` 没有落地：实测每次新建 VM 只要 5–7 ms（参照的 Node 冷启 108 ms 才是常驻的动机），常驻带来的跨调用状态与并发约束不值得——S-F2 固定 per-call。
`workspaceTools.readParallel`（原 S-F3）**未做**：它省的是墙钟不省 token，且会打乱审批卡的先后语义；本轮的目标函数是 token 与模型步数，砍掉。

全部 PC-only，导出安卓时剥离（沿用现有 PC-only 列表；`resultClip` 与 `ptc` 已加入 stripPcOnly / PC_ONLY 保留表）。

---

## 7. 决策记录

### 待拍板（已拍板，2026-11-20）

1. **PTC 的安全档位 = B 硬沙箱（QuickJS/WASM）**。用户选定：程序只能通过注入的 `tools` 触碰工作区，没有宿主任意访问。
   - 探针已跑通并留档（`tools/spike-quickjs/`）：
     - `require / process / Bun / fetch / setTimeout` 在 VM 内全部 `undefined`（真隔离）；
     - asyncified 工具桥：宿主 `async` → QuickJS 内同步调用（`tools.bash({...})` 直接返回结果）；
     - 死循环用**预先算好的 deadline** 打断（`setInterruptHandler` 在 eval 前设置，实测 151 ms 生效；依赖事件循环的定时器方案无效，因为 CPU 循环会阻塞事件循环）；
     - 每次调用新建 module+context 实测 **5–7 ms**（对比参照的 Node 冷启 108 ms），所以**不做常驻**：每次 `run_code` 一个全新 VM，跨调用/跨会话零状态泄漏；
     - `bun build --compile` 打包：用 `import wasmPath from ".../wasm" with { type: "file" }` + `readFileSync(wasmPath)` 把 `emscripten-module.wasm` 嵌入 exe，编译产物实测可跑（否则报 `B:\~BUN\root\emscripten-module.wasm` ENOENT）。
   - 代价：新增运行时依赖 `quickjs-emscripten@0.32.0`（异步变体，wasm 约 1 MB）。
   - 与参照的差异：**不模仿 REPL 语义**（变量跨 program 保留）——参照自己记录它是重名变量报错的坑；rdp 每次一个干净 VM，程序要多次调用就在同一段代码里写。

### 已定（按参照数据与 rdp 纪律，不再问）

2. **不抄 0.25 压缩阈值**：参照自己承认 109 次运行 0 次触发；rdp 的自动压缩线是窗口−预留，S5–S7 已提供模型驱动压缩。
3. **不抄"关插件"**：S10 发现行已用动态子集达到同样目的。
4. **裁剪发生在富化层，不在工具内核**：工具内核的 2000 行/50 KB 不动；富化层的裁剪才是"进上下文前的最后一道"，且可无损召回。
5. **PTC 默认开**（用户明确要求），但保留：总开关、连续两次失败自动回退直连、`per-call` 运行时保守档。
6. **不做 per-tool-call token 账本**：会把计费口径和工具审计搅在一起，收益（一个展示数字）不值。

---

## 8. 已知限制（写进文档给用户看）

- PTC 程序**每次都是干净 VM**：变量不跨调用保留。要复用中间结果就在同一段程序里写；参照的"REPL 残留"坑我们不复制。
- **程序必须是同步的：没有 `await` / Promise / `Promise.all`**。实测 asyncified 桥在微任务里续跑会破坏 quickjs-emscripten 的宿主引用表（`QuickJSHostRefInvalid`），而 `evalCodeAsync` 也不结算 async IIFE 的 promise（`resolvePromise` 等不到 job）。工具调用本身在 VM 眼里就是同步的，同步程序已覆盖全部折叠收益；写 `await` 时错误信息直接给出修正提示。
- 弱模型写程序可能不如直连：连续两次程序错误即回退，但回退前的失败已经花掉两个模型步。
- VM 内没有 `setTimeout` / `fetch` / `require` / `process` / `Bun`；`console.log` 是唯一输出通道（连同最后一条表达式的值一起返回）。

---

## 9. 落地记录（2026-11-20）

S-F1 / S-F2 / S-F4 / S-F5 已实现并接入编排器；S-F3 砍掉；S-F6 设置页随后落地（`extensions` → 「工作区工具」）。

实现与原计划的差异，逐条给原因：

1. **程序同步化（no await）**：asyncify 的桥在微任务里续跑会坏宿主引用表，`resolvePromise` 也等不到 job（探针 v5–v7 留档）。同步程序仍覆盖全部折叠收益（VM 眼里工具调用本来就是同步的）；程序写 `await` 时沙箱在错误信息里直接教它删掉。
2. **不常驻、不 REPL**：每次 5–7 ms 新建 VM，常驻只省这点时间却要背状态泄漏与并发约束。
3. **嵌套调用发真实卡片**：审批卡靠 toolCallId 绑定在 part 上，没有卡用户点不到 = 死锁。所以桥在调用前后发 `tool_call_created` / `tool_result`（与 pi 事件桥同形），id 约定 `${父调用}:n${序号}`；卡片输出只存 240 字符预览（全文已交给程序），历史体积不因嵌套膨胀。
4. **熔断做成一次性回退**：连续 2 个程序错误 → 下一回合装配直连面一次（并清零），再下一回合重新尝试 PTC。不永久关：一次语法错误不该让折叠永久失效；也不每轮回退：不会写的模型不该每轮撞墙。
5. **不做停滞签名折叠**：停顿判定本来就要求"同参**且**同输出"。嵌套参数变了，`run_code` 的程序文本与结果都会变，不会误判；真出现"程序文本相同、结果也相同"的重复，那就是模型在重复同一件事，该停。
6. **`round_summary` 在 tracker 内计算**：事件先于 turn_end 到达，判定表读 `runTracker.roundSummary()` 即可，不需要引擎侧再传一份数字；裁剪体积用与富化层同一个 `clipToolResultText`，token 用同一个 `estimateTokens`——两处数字同源。
7. **bash 纪律进 `stableGuidanceLines`**：一次请求几行的常量，换掉 `cat/head/tail` 这种"用 shell 当文件浏览器"的习惯；`run_code` 的可用性写在条件句里（`when run_code is available`），PTC 关闭时不撒谎。
8. **循环依赖的代价**：`ptc-surface` 需要上下文工具名，`context-tools` 又经 `conversations/index` 间接回到 orchestrator——名字抽到叶子模块 `context-tool-names.ts`，`context-tools` 重新导出，消费方零改动。
