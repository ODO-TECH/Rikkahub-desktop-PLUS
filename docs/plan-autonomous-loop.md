# 自主循环（goal → plan → act → observe → replan）方案与流程规范

> 状态：S1 已落地（run 状态机 / 运行记录 / engine_status 扩展 / 折叠面板 / 实验设置页），S2 已落地（计划 v2 / 目标三件套改写保护 / attempts / 未验证标识 / 权威快照），S3 已落地（确定性判定表 / replan 注入 / 完成校验 / stalled·awaiting_user·exhausted 终局 / 继续·改目标入口），S4 已落地（骨架层零输出窗口传输重试 / Retry-After / 状态条重试相位 / 独立开关），S5 已落地（真实控制器 + 真实骨架 + 脚本化 adapter 的 mock 验收、Windows 基线说明）。
> 进度：S1 ✅ · S2 ✅ · S3 ✅ · S4 ✅ · S5 ✅。
> 范围：只补「自主循环」这一项。任务生命周期（跨重启恢复、cron 调度）、审计、任务图 DAG 执行器均不在本文范围，但本文 S1 的运行记录是它们的地基。
> 关联：运行记录的只读观测层（历史 run、事件分页、计划证据、权限边界复盘、审批复盘）见 `docs/plan-agentbot-observability.md`，O1–O5 已完成；观测层只消费本文 S1–S5 的 run/plan 语义，不改变循环、审批与权限判定。
> 关联：任务生命周期（长跑 checkpoint、启动收敛、显式恢复、耐久调度、审计导出）见 `docs/plan-task-lifecycle.md`；该计划复用本文运行记录与计划边界，仍不引入自动审批或崩溃后自动续跑。
> 参照：`reference/_dl/ecc/skills/loop-design-check`（目标可判定 / plan-build-judge / 五类失败模式 / 防跑飞）、`continuous-agent-loop`（质量门与恢复控制）、`agentic-loop-upgrade`（可观测状态机、检查点、计划状态字段）。orchestrator-v4 仅参考其"自适应超时 / 用户随时打断"语义，不引入其派发模型。

## 0. 一句话结论

rdp 现在的循环是「模型自驱动的工具循环」：act → observe → 再采样这段已经全自动，但**目标没有机器可判定的形态、完成没有校验、失败没有分类、原地打转没有检测、耗尽没有终局语义**。本方案不新增一套执行器，而是在现有两套循环（聊天引擎 `tool-loop.ts`、pi 工作区引擎）的**轮边界**上加一层确定性的"观察 → 判定"控制器，并把判断权严格留在人手里。

三条不可让渡的红线（来自 loop-design-check，直接作为验收标准）：

1. **判断权归人**：目标、验收口径、权限档只能由用户消息改变；模型可以改步骤，不能改这三样。
2. **责任不转移**：审批绝不自动放行；不引入"超时自动批准""失败自动提权"这类机制。
3. **自我改写越多，事前人工门越硬**：replan 允许模型重写步骤，但 replan 次数、停滞升级、终局宣告都由代码层判定，不由模型自评。

## 1. 现状诊断（证据）

| 环节 | 现状 | 位置 |
| --- | --- | --- |
| act/observe 循环 | 已实现，256 轮预算，逐轮逐工具查 abort，steering 在轮边界注入 | `pc-server/inference-engine/tool-loop.ts:54,243,377-433`；`pi/packages/agent/src/agent-loop.ts:156-273` |
| 计划 | 平铺 checklist，`{content,status}` 四态，无目标、无验收、无边界、无计数，不落库 | `pc-server/tools/plan.ts:22-39,104-163` |
| 重规划 | 无代码层触发，全靠模型自行改写；全仓 `replan` 零命中 | — |
| 完成判定 | 模型一旦本轮不调用工具即视为答完，不校验计划是否了结、不校验是否达成目标 | `tool-loop.ts:334-345` |
| 耗尽终局 | 直接 throw 文案，无"目标未达成"状态、无进度保留语义 | `tool-loop.ts:435` |
| 传输重试 | 聊天引擎无（`!response.ok` 直接 throw，429/5xx 原样抛）；pi 侧有完整分类重试 2s/4s/8s×3 | `tool-loop.ts:268-278`；`pi/packages/ai/src/utils/retry.ts:163-213` |
| 工具失败 | 错误原文回灌模型，无计数、无签名归类 | `tool-loop.ts:406-410` |
| 子任务失败 | 标 `[FAILED]` 回灌父模型，无重派策略 | `pc-server/tools/subagent.ts:135-161` |
| 运行可观测 | 只有 `generating/compressing/awaitingApproval` 三张内存表 + 13 种 GenerationEvent；无 runId、无运行记录表 | `pc-server/conversations/generation-state.ts`；`inference-engine/events.ts:18-52` |
| 既有纪律 | `foundation/retry.ts` 明确"不擅自给 LLM 流式主链路加重试（那会破坏 streaming）" | `pc-server/foundation/retry.ts:6-8` |

## 2. 参照规范的采纳与拒绝

| 参照条目 | 处置 | 落到 rdp 的形式 |
| --- | --- | --- |
| 目标必须机器可判定 + 边界条件 + 失败兜底（五点目标框架） | 采纳 | 计划 schema v2 的 `goal / done_when / boundaries`；判定表第 1、2 条 |
| plan / build / judge 三角色，judge 独立且确定性，build 不得改验收条件 | 采纳其约束，不引入第二个模型 | 模型可改步骤不可改 `goal/done_when/boundaries`；完成宣告必须带工具证据；不新增"评审模型"调用（成本与自评风险） |
| 防跑飞：重试上限、硬停、停滞升级 | 采纳 | 判定表第 3、4、5、7 条；replan 上限与停滞计数由代码层维护 |
| 两级反馈：执行归机器、判断归人 | 采纳 | 状态机里 `awaiting_user` 是一等终局；用户改目标即重置计数 |
| 可观测状态机、检查点、计划状态字段 | 采纳 | S1 的 run 状态机与运行记录；检查点只保留"记录"，跨重启恢复不在本期 |
| 审批 15 秒无响应自动放行 | **拒绝** | 与现有"只升不降、危险命令需真人批准"冲突；审批挂起语义不变 |
| 失败自动加 sudo / 改命令提权重试 | **拒绝** | 违反"denied 不重试、区外写入需审批"；工具层不做改写参数式重试 |
| 工具失败自动诊断并重试（含写操作） | 部分拒绝 | 写操作一律不自动重放；只读幂等工具的网络类失败可选重试 1 次，默认关 |
| 自动检测计划步骤完成（由同一模型分析工具结果） | 拒绝自评 | 步骤完成仍以工具证据为准，模型标 completed 但无证据时面板标"未验证" |

## 3. 流程规范

### 3.1 两级反馈与角色边界

- **执行层（机器）**：受理目标 → 发布计划 → 执行轮 → 观察 → 判定 → 继续 / 重规划 / 请求人工 / 收尾。
- **判断层（人）**：设定与修改目标、验收口径、权限档；审批具体工具调用；在 `awaiting_user` 时决定改目标、缩范围还是终止；最终验收。

机器不得越权的三件事：改目标与验收口径、批准权限、宣布"目标已达成"而无证据。

### 3.2 运行状态机

一次 `generateAnswer` = 一个 run（`runId`）。状态与现有 `engine_status.phase` 对齐扩展：

```
planning → acting → observing → deciding
              ↑          │           │
              │          │           ├─→ replanning ─→ acting        （改写步骤，计数+1）
              │          │           ├─→ verifying  ─→ succeeded     （完成校验通过）
              │          │           ├─→ awaiting_approval ─→ acting （现有审批语义，不变）
              │          │           └─→ awaiting_user               （需人判断，见 3.3）
              └──────────┘
终局：succeeded / failed / exhausted / stalled / stopped(interrupted|replaced|deleted)
```

- `stopped` 沿用现有 `GenerationAbortReason` 三态，队列命运不变（interrupted 冻结、replaced 接棒、deleted 清除）。
- `exhausted`：轮次或重试预算耗尽，目标未达成。**不再只是抛一句文案**，要保留计划、进度与原因，并给"继续 / 改目标"入口。
- `stalled`：检测到原地打转。默认转 `awaiting_user` 而不是静默失败——原地打转是"目标或路径有问题"的信号，属于判断层。
- `awaiting_user`：暂停采样、保留全部上下文与计划，不自动恢复。恢复只能来自用户消息。

### 3.3 观察 → 判定表（控制器核心，全部确定性规则）

| # | 触发条件（观察点：轮边界） | 动作 | 上限与兜底 |
| --- | --- | --- | --- |
| 1 | 本轮无工具调用，计划全部 settled，且完成校验通过 | `verifying` → `succeeded` | — |
| 2 | 本轮无工具调用，但计划有未了结步骤或缺完成证据 | 注入"计划未了结/缺证据"提示，重采样一次 | 仍无进展 → `stalled` → `awaiting_user`。防止"说完了但没做完" |
| 3 | 同一 `(toolName, 规范化参数)` 连续重复且输出无新增信息 | 注入"换路径"提示 | 连续 3 次触发即 `stalled`。分页/翻页参数不同不计入 |
| 4 | 同一错误签名连续出现 | `replanning`：要求改写步骤或换方案，**禁止原样重试** | 连续 3 次同错才触发；replan 后签名清零 |
| 5 | 计划连续 replan 后 settled 数仍不增长 | `awaiting_user` | replan 上限默认 2 次 |
| 6 | 工具被用户 denied | 记录事件，禁止自动重试该调用，只允许换方案 | 现有 subagent 纪律推广到主循环 |
| 7 | 轮次达 256 | `exhausted` | 保留进度与计划，可继续 |
| 8 | 用户 stop | `stopped(interrupted)` | 现有语义不变，任何退避等待立即中止 |
| 9 | 用户补发 / 改目标 | 目标与验收口径重置，replan 与停滞计数清零 | 人改目标 = 高层反馈，优先级高于一切判定 |

### 3.4 重试矩阵（严格区分"传输重试"与"任务重试"）

| 层 | 允许重试的情形 | 策略 | 禁止情形 |
| --- | --- | --- | --- |
| LLM 传输 | 本轮**尚未产生任何可见输出**（无 text/reasoning/tool delta）且错误可重试：408 / 429 / 5xx / 网络瞬断 / 响应头超时 | 指数退避（基数 = `transportRetryDelaySeconds`，默认 1s→2s；合计最多 3 次尝试）；尊重 `Retry-After`（封顶 30s，超过 60s 直接失败；`Retry-After` 与退避基数取较长——服务端要求是下限，但它给得短不顶掉设置值）；不占 256 轮预算；状态条 `retrying` 显示第几次 | 已流出内容的轮次（保留现有 nonStreamFallback 行为）；已执行过副作用工具之后；AbortError；400/401/403；配额与计费类错误 |
| 工具 | 默认不自动重试。仅"只读幂等工具 + 网络类失败"可选重试 1 次 | 独立开关，默认关 | 一切写操作 / 有副作用工具；denied 的调用；参数改写式重试 |
| 子任务 | 默认保持 `[FAILED]` 回灌语义 | 可选"最多重派 1 次且必须更换 prompt 或模型"，默认关 | 原样重派；深度解锁 |

成本纪律：传输重试一轮最多多出 2 次计费请求，必须在状态条与运行记录里可见；所有测试用假 provider / 本地 mock，不打真实计费接口。

### 3.5 完成校验（防 Goodhart）

`succeeded` 必须同时满足：计划无未了结步骤；每个 `completed` 步骤带工具证据（产生该结果的 toolCallId）；`done_when` 中可机器核验的项已核验；`boundaries` 未被违反（区外写入、删测试、改验收口径等一经发现即 `failed` 并说明）。

模型把步骤标成 `completed` 但没有对应工具证据时，步骤在面板显示"未验证"，且不计入完成判定。这是"不许自己批自己作业"的落地形式，不引入第二个评审模型。

## 4. 数据与接口契约

### 4.1 计划 schema v2（向后兼容）

```jsonc
{
  "goal": "用户目标的原文，首次由模型复述，之后只能由用户消息改变",
  "done_when": ["机器可判定的完成条件"],
  "boundaries": ["禁止事项：不得删测试、不得越工作区、不得改验收口径"],
  "steps": [
    { "id": "s1", "content": "…", "status": "in_progress",
      "verify": "如何验证", "evidence": ["toolCallId"],
      "attempts": 0, "last_error": null }
  ]
}
```

- 旧输入（只有 `title/steps[{content,status}]`）照常归一化，新字段缺省为空，行为与现在逐字一致；`PLAN_MAX_STEPS=20`、单步 160 字符的钳制不变。
- `goal/done_when/boundaries` 首次设定后，模型再次提交不同值时保留旧值并在回执中警告（只有用户消息能改）。
- `attempts` 由代码层维护，模型提交的值不被采信（不能自己清零）。
- 计划仍以 tool part 形式留在消息流，面板"读本会话最后一条 update_plan"的重放机制不变。

### 4.2 运行记录（S1）

新增 `pc_generation_run`（runId、conversationId、nodeId、引擎、状态、相位、轮次、replan 计数、停滞原因、目标快照、起止时间、终局原因）与 `pc_generation_run_event`（runId、序号、类型、摘要、载荷）。保留最近 N 条 run，可清理；默认不记录敏感正文，只记摘要与计数。

`GenerationEvent` 增加可选 `runId`；`engine_status` 扩展相位与计数（`round / attempts / replanCount / stallReason`），旧前端忽略新字段不受影响。

前端在会话内提供"本次运行"折叠面板（默认折叠，就地展示），显示轮次、工具与审批流水、重试与 replan 次数、终局原因。不做独立任务中心页面。

### 4.3 设置（PC 专属，导出安卓剥离）

对外命名：设置 › 实验功能里这一页叫 **AgentBot**——它是较大的实验性能力，自主循环只是其中一小部分（已含运行记录、判定终局、传输重试；任务生命周期与调度不在本期）。存储键与接口沿用 `agentLoop` / `settings/agent-loop`，改名只动展示面，不做数据迁移。

`agentLoop.enabled` 默认 **false**——关闭时两条引擎通路与改动前逐字一致；`transportRetry` 默认 true（只作用于"零输出失败"窗口，属稳定性修复，可在关闭 `agentLoop` 时独立生效）；`transportRetryDelaySeconds=1`（退避基数，范围 1–30；服务端给了 `Retry-After` 时取两者中更长的，不会被它的小值顶掉）；`maxReplans=2`、`stallRepeatLimit=3`、`sameErrorLimit=3`、`requireVerifiedCompletion=true`（随 enabled 生效）；只读工具重试、子任务重派默认关。

## 5. 分阶段实施

| 阶段 | 内容 | 主要改动面 | 验收 |
| --- | --- | --- | --- |
| S1 运行底座 | runId、run 状态机、运行记录表、`engine_status` 扩展、折叠面板 | `conversations/generation-state.ts`、`inference-engine/events.ts`、`api/sse.ts`、`conversations/orchestrator.ts`、web-ui | 开关关闭时零行为差；开启后能看到一次生成的完整轮次/审批/终局流水 |
| S2 计划 v2 | schema 扩展、目标与验收口径的改写保护、attempts 计数、面板"未验证"标识 | `tools/plan.ts`、`tools/definitions.ts`、`pi-engine/general-tools.ts`、`web-ui/app/lib/plan-model.ts` | 旧计划输入输出逐字一致；模型篡改 goal/done_when 被拒绝并回执警告 |
| S3 判定表与终局 | 停滞/同错检测、replan 注入、完成校验、exhausted/stalled/awaiting_user 及"继续/改目标" | `inference-engine/tool-loop.ts` 轮边界、`pi-engine/runner.ts`（turn_end 边界）、`conversations/orchestrator.ts` | 见 §6 用例 3–7 |
| S4 传输重试 | 骨架层统一实现，三家 adapter 零差异改动；Retry-After；成本可见 | `inference-engine/tool-loop.ts`、`foundation/retry.ts`（复用原语，不改其纪律注释以外的语义） | 见 §6 用例 1–2、8 |
| S5 验收与文档 | 全套 mock e2e、Windows flake 基线说明、发布说明 | `pc-server/**` 测试、本文档状态更新 | 全绿；不计费 |

pi 目录是 vendor 上游：所有 pi 侧行为只在 `pc-server/pi-engine/*` 适配层实现，不改 `pi/packages` 源码。`rikka-code`（Rust）不在本期。

## 6. 验收用例（全部 mock，零计费）

1. 首轮 429（带 Retry-After: 1）→ 退避后成功，状态条显示重试第 2 次，轮次计数不增加。
2. 连续 429 超过上限 → `failed`，报错与现有一致的人话文案，不悬挂等待。
3. 流已输出若干 text delta 后中断 → 不触发传输重试，走现有降级路径。
4. 模型连续三次以相同参数调用同一工具且输出相同 → 第 3 次触发 `stalled`，转 `awaiting_user`。
5. 同一错误签名连续 3 次 → 触发一次 replan，运行记录里有 replan 事件；模型原样重试被判定表拦截。
6. 模型在不调用工具的情况下宣告完成，但计划有 pending 步骤 → 不结束，注入提示重采样；仍无进展则 `stalled`。
7. 步骤标 completed 但无工具证据 → 面板"未验证"，不计入完成判定；模型提交不同 goal → 保留旧 goal 并警告。
8. 重试退避等待中用户 stop → 立即 `stopped(interrupted)`，不再发起请求。
9. 用户 denied 某工具 → 该调用不再自动重试；模型换方案可继续。
10. 达到 256 轮 → `exhausted`，计划与进度保留，可"继续"。
11. `agentLoop.enabled=false` 时，以上全部路径与改动前逐字一致。

已知非回归项：pc-server 在 Windows 的 `bun test` 恒定 2–3 败（Temp EPERM / e2e EBUSY）是既有基线，验收时按基线比对，不做 bisect。另：本机未生成 `pc-server/assets/bash-bundle.tar.gz`（gitignored 构建产物）时，`workspace/tools/embedded-bash.test.ts` 会在加载期报缺模块，跑一次 `bun run build:bash-bundle` 即消除，与本方案无关。

## 7. 风险

- **成本漂移**：重试与 replan 都增加请求数。靠上限、状态条可见、默认保守控制；任何"再加一次自动评审模型"的提议默认拒绝。
- **主链路回归**：三家 provider 共用骨架，所有行为改动必须落在骨架层且默认关闭路径逐字一致。
- **误判停滞**：分页、轮询等合法重复靠"参数规范化 + 输出无新增信息"双重条件规避，并提供开关与计数展示，误伤时可关。
- **范围蔓延**：跨重启恢复、cron、DAG 依赖图、不可篡改审计都不在本期，避免把"自主循环"做成"任务平台"。
- **并行编辑**：工作区常有并行会话，改动只碰本文列出的文件；typecheck 在未触碰文件报错只报告，不顺手修改。
