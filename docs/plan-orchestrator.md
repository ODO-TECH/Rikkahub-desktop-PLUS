# RDP Orchestrator（规划/执行双模型）实施方案

> 状态：草案，待用户拍板（§8）。未改代码。
> 姊妹文档：[plan-swarm.md](plan-swarm.md)（群蜂）。**建议顺序：本文 O1 → 群蜂 M1 → 群蜂 M2 → 本文 O2**，理由见 §5.4。
> 目标仓库：`rikkahub-alpha`（RDP 主线）。

## 0. 给 codex 的 TL;DR

Orchestrator = **一个回合里用两个模型**：规划阶段用 planner，执行阶段用 executor。RDP 不做内核级重写：宿主为两个 `ModelTarget` 各建一个 `AgentRuntime`（共享同一 KernelStore、同一预算、同一并发槽），先跑 planner（只读工具），把计划文本注入 executor 的根 Run，再跑 executor。设置里新增 `orchestrator` 配置块，默认关闭；关闭时行为与现在逐字节一致。

---

## 1. Antigravity 的 Orchestrator 是什么（事实）

来源：Antigravity changelog（2.30–2.35、CLI 1.5.10–1.5.16）与 Gemini 4 Hydrogen / Neon 发布文。

- 它是**模型选择器里的一个复合档位**，不是一个独立工具，也不是新协议。
- 由两个角色组成：`Planner` 与 `Executor`，各自可选模型、各自可选思考档（Low/Medium/High/XHigh）。
- 官方组合示例：Neon 规划 + Hydrogen 执行；Carbon 规划 + Hydrogen 执行；CLI 里叫 `Orchestrator (Carbon)` / `Orchestrator (Argon)`，后来合并成一行 `Orchestrator`，用左右键切 Planner。
- 配置存在 `settings.json` 的 `"orchestrator"` 键下；状态行显示当前 Planner；默认思考档是 `high`（2.35.0 / CLI 1.5.15 调整）。
- 行为描述只有一句关键话：**"planning with X and implementing with Y"**。没有更细的逐步路由规则对外公开。

**推论（对我们有用）**：它是一个"按阶段换模型"的策略，而不是"每一步动态挑模型"。因此 RDP 不需要在内核里做智能路由，只需要一个确定的阶段边界。

---

## 2. 映射到 RDP 的三种形态

| 形态 | 做法 | 成本 | 风险 |
| --- | --- | --- | --- |
| A. 两个 Run（推荐，O1） | planner Run 产出计划文本 → 注入 executor 根 Run → 执行 | 宿主层，不动 provider 内部 | 双倍输入 token；多一次延迟 |
| B. 单 Run 内切模型（O2） | `runtime.setModel(runId, ...)` 在步边界切换 | 要改内核 + provider 解析 | 能力/鉴权按 ctx 判定，切模型易错配 |
| C. 场景档复用（不做） | 把 `fastModelId`/`memoryModelId` 当 Orchestrator | 零成本 | 语义不同：那两个是标题/记忆等后台任务，不是规划 |

选 A。C 只作为"配置形态的参照"（RDP 已有按场景选模型的先例），不作为实现。

---

## 3. 关键约束（必须先知道，否则会写出错配的请求）

1. **`DesktopProvider` 的鉴权、端点、能力判定全部取自 `ctx`，不是 `request.model`**
   `pc-server/kernel-engine/provider.ts`：`provider/auth/model` 来自 `this.ctx`；`request.model` 只用于 URL 路径和 body 的 `model` 字段。
   后果：一个 runtime 只能服务一个 provider。跨 provider 的 planner/executor 必须**各自建 provider + runtime**，不能只改 `run.model`。
2. **同 provider 换模型也要换能力判定**
   `isModelAllowTemperature`、`supportsAbility`、`reasoningPayloadForProvider`、`requiredOutputCap` 都读 `ctx.model`；思考档读 `assistant.reasoningLevel`。
   所以 planner 目标必须是一个完整的 `{provider, model, assistant-override}`，不是单个 modelId 字符串。
3. **现有 Plan v3 明确写过"不引入第二个规划模型"**
   `docs/plan-planner-task-graph.md`（2026-11-02 已实施）的总约束里有这一条。本次是新增需求，**显式覆盖**该限制；但计划工具（`update_plan`）本身不改造，Orchestrator 的产物先以文本注入。
4. **内核 `Run.model` 在创建时固定**
   `createRun()` 写入一次；`request()` 只读。A 形态不需要改这一点（两个 Run 各用各的模型）。
5. **多 runtime 共享一个 Store 是安全的**
   同进程、单 SQLite（WAL）。但 `runtime.recover()` 只能调用一次（driver 已有 `recovered` 标志）；新建的 runtime **不要**再调 recover。
6. **模型解析入口已存在**
   `findModel(modelId)` / `findModelStrict(modelId)`（`pc-server/model-providers/index.ts:400`），返回 `{provider, model}`；助手思考档字段是 `assistant.reasoningLevel`；档位换算已有 `effortLowHighMaxFor` / `reasoningLevelNormalized`。

---

## 4. 设计（O1）

### 4.1 配置

`settings` 新增块（默认关闭；state-load 里补默认值，旧数据无感）：

```ts
orchestrator: {
  enabled: false,
  plannerModelId: "",        // 空 = 不启用（即使 enabled）
  plannerEffort: "high",     // 复用 reasoningLevel 取值：off/minimal/low/medium/high/xhigh/max/auto
  executorModelId: "",       // 空 = 跟随会话/助手模型
  executorEffort: "",        // 空 = 沿用 assistant.reasoningLevel
  plannerMaxRequests: 8,     // planner 的硬上限，防止规划烧穿预算
  trigger: "first-turn",     // "first-turn" | "always"（默认 first-turn，见 §8-1）
}
```

模型不存在 / 已禁用时：`findModelStrict` 返回 null → 记一条日志并按"关闭 Orchestrator"处理，**不要静默回落到 Auto**。

### 4.2 ModelTarget 解析器（新文件）

`pc-server/kernel-engine/model-target.ts`：

```ts
export interface ModelTarget {
  provider: Provider;
  model: Model;
  assistant: Assistant;   // 已应用 effort 覆盖的浅拷贝
}

export function resolveTarget(
  base: Assistant, modelId: string | undefined, effort: string | undefined,
): ModelTarget | null;

/** 共享 store / 槽位 / 工具调度器的第二个 runtime；不调用 recover。 */
export function runtimeFor(
  base: EngineRunContext, target: ModelTarget, deps: RuntimeDeps,
): AgentRuntime;
```

要点：

- `assistant` 覆盖只改 `reasoningLevel`（effort 非空时）与必要字段；其余沿用原助手。
- `runtimeFor` 复用 `driver.ts` 里的模块级 `kernelStore()`、`modelSlots`、`backgroundModelSlots`、`toolScheduler`、`liveRuns`，只是换 `provider` 与 `model`。
- 不复制 `runKernelGeneration` 的主流程，只把"建 runtime"抽成函数；工具闭包（`hostTool`）仍由同一份 `unique` 声明表生成。

### 4.3 一个回合内的两段执行

改 `runKernelGeneration`（`driver.ts`），只在 `agent === true && orchestrator.enabled` 时走新路径：

```
1. executorTarget = resolveTarget(assistant, execModelId || model.modelId, execEffort)
   plannerTarget  = resolveTarget(assistant, plannerModelId, plannerEffort)
2. executorRuntime 先 create() 出根 Run（queued，不 resume）
   → 得到 executorRootId，budget 已建
3. plannerRuntime.createWork({ 只读工具 + planner 系统提示, limits: { maxRequests: plannerMaxRequests, maxSteps: 8 } },
                             budgetId = executorRootId)
4. resume(plannerRunId, signal)；成功则取 answer 文本，截 12 000 字符
5. 把计划注入 executor 根 Run：
   { role: "user", content: "[Orchestrator plan]\n" + plan + "\n按此计划执行；不要复述计划。" }
6. resume(executorRootId, signal)；其余事件/注解逻辑不变
```

细节：

- **planner 工具白名单**：`["read", "read_files", "get_time_info"]`（与 driver 现有 `readOnly` 判定同一组名）。只读，不审批写操作。
- **planner 系统提示**：中文，要求"给出可执行步骤、涉及文件、验证方式；不要调用写工具；不要执行"。这是文本约定，不是新的工具。
- **不转发 planner 的流式输出**：`onEvent` 现有判断 `runId === rootId` 天然过滤（planner 的 rootId 是 executor 根 id，不等于自身 id）。如需 UI 提示，另发一次 `engine_status`。
- **注解**：只把 `executorRootId` 写进 `annotations`（planner 共享同一 rootId，`kernel-runs` 端点会一并返回，运行详情里能看到规划 Run）。
- **`trigger`**：`first-turn` = 会话内还没有成功的 Orchestrator 规划时执行两段；`always` = 每个用户回合都规划。判断依据记在会话层面的一个布尔/时间戳，存在 conversation 的标注里（不要新建表）。

### 4.4 预算、取消、降级

- 预算：planner 用 `createWork(budgetId=executorRootId)` 与 executor 共享根预算；`plannerMaxRequests` 是附加硬闸，命中即 `limited`。
- 取消：同一个 `signal` 传给两次 `resume`；planner 被取消 = 整个生成取消。
- 降级：planner `status !== "completed"`（失败/超限/中止）时：
  - 若是 `signal.aborted` → 直接抛 `AbortError`，不要继续；
  - 否则记日志 + 向 executor 注入一条 `[Orchestrator] 规划未完成，直接执行。`，继续单模型执行。
- 费用：两段都会把历史各发一遍，**输入 token 约为单模型的两倍**。这是产品代价，必须写进设置说明。

### 4.5 最小 UI（O1 不做正式界面）

- 设置：`Settings > 模型` 增加一块"Orchestrator"（开关、两个模型选择、两个思考档、planner 上限、触发方式）。模型选择复用现有 picker 组件。
- 会话：不新增面板；运行详情里会多一个 planner Run，够验收用。
- 正式模型选择器里的复合条目（像 Antigravity 那样）留到 O2。

---

## 5. 实施切片

### O1（本次交付）：双 Run 两段执行

**文件清单**

1. `pc-server/foundation/types/index.ts`
   - `Settings` 增加 `orchestrator` 字段（按现有可选字段风格）。
2. `pc-server/app-config/defaults.ts` + `pc-server/persistence/state-load.ts`
   - 默认值 + 归一化（未知 effort 归 `high`；模型 id 不校验存在性，运行时再判）。
3. `pc-server/kernel-engine/model-target.ts`（新）
   - §4.2 两个导出；`resolveTarget` 纯函数，便于单测。
4. `pc-server/kernel-engine/driver.ts`
   - 抽出 `makeRuntime(target, deps)`；`runKernelGeneration` 增加 §4.3 分支；其余路径不动。
   - `driver.ts` 已有模块级单例（store/slots/scheduler/liveRuns），复用，不新建全局。
5. `pc-server/api/handlers/settings.ts`
   - 读写 `orchestrator` 块（沿用现有 settings 保存模式）。
6. `web-ui` 设置页
   - `Settings > 模型` 加 Orchestrator 卡片（开关 + 两个模型选择 + 两个思考档 + planner 上限 + 触发方式），文案放在现有 locale 文件。
7. 测试
   - `pc-server/kernel-engine/model-target.test.ts`（新）：模型不存在返回 null；effort 覆盖只改 `reasoningLevel`；provider/model 来自 `findModelStrict`。
   - `pc-server/kernel-engine/orchestrator.test.ts`（新，mock provider）：两段都发请求、planner 只拿到白名单工具、计划被注入 executor、共享同一 budget、关闭时只有一次调用、planner 失败时降级且不中断。
   - 不调用真实计费供应商。

**O1 完成门槛**

- `cd pc-server && bun run typecheck && bun test --filter orchestrator` 通过（全量测试与基线一致，见 §6）。
- 手工：设置里配一个跨 provider 组合（如 DeepSeek 规划 + 本地/其他执行），跑一轮，能在 `运行详情` 看到两个 Run、`/debug/requests` 能看到两次不同的 model 字段。真实供应商调用前先征得用户同意。

### O2（暂缓）：单 Run 内切换

- 目标：一个 Run 内从 planner 切到 executor，少一半重复输入（利用 KV/前缀缓存）。
- 前提：把 provider 解析从 `ctx` 下沉到 `request.model`（`provider.ts` 里 provider/auth/capability 全部改为按目标解析）；内核加 `setModel(runId, model)`（只允许步边界）。
- 风险高：鉴权、端点、思考 payload、wire 注解都要重新对齐；不在本轮。

### O3（不做）：模型自动路由

按任务类型/长度动态挑模型。没有可验证的收益信号，先否决。

### 5.4 与群蜂的顺序

1. **O1 先做**：它建立 `ModelTarget` + "第二 runtime" 这条路径；群蜂以后要做 per-worker 模型时直接复用。
2. 群蜂 M1 不依赖 O1（worker 模型固定跟随会话），两者可并行；但同一周内做时先 O1，避免 driver 冲突。
3. 群蜂 M2（后台）与 O2 无依赖，谁先都行；不要同时改 `provider.ts`。

---

## 6. 回归与验收

```bash
cd pc-server && bun run typecheck
cd ../web-ui && bun run typecheck && bun test
cd ../agent-kernel && bun test && bun run typecheck
```

- 已知基线：`pc-server bun test` 在 Windows 恒有 2–3 个 EPERM/EBUSY 失败，与改动前一致即可，不要 bisect。
- 不许出现的回归：
  - `orchestrator.enabled === false` 时只有一次 `runtime.create` + 一次 `resume`，请求体与现在一致；
  - `annotations` 里仍然只有一个 `kernel_run` id（executor 根）；
  - 纯对话（`executionMode: "chat"`）永远不走 Orchestrator；
  - 预算计数：关闭时 `store.budget` 数值不变。

---

## 7. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 输入 token 翻倍 | 单回合成本 ~2× | 设置页明示；`trigger` 默认 `first-turn`；planner 上限 8 请求 |
| planner 延迟 | 首字变慢 | 规划期间显示"规划中"状态；O2 用缓存解决重复输入 |
| 跨 provider 错配 | 鉴权/端点错误 | 每个 Target 独立 provider + runtime；禁止只改 `run.model` |
| 双 runtime 的 recover 冲突 | 启动时误标 running | `runtimeFor` 不调 recover；recover 仍只在 driver 首次调用 |
| planner 输出过长 | 注入撑爆 executor 上下文 | 截 12 000 字符；超限记日志 |
| 计划与 Plan v3 面板不一致 | 用户看到两份计划 | O1 计划只作提示；面板仍由 `update_plan` 产生；文档说明 |
| 模型被删/禁用 | 请求 404 或回落 Auto | `findModelStrict` null → 视为关闭并提示 |

---

## 8. 待用户拍板

1. **触发频率**：默认每个会话首次生成规划一次（`first-turn`），还是每回合都规划（`always`）？后者贵一倍以上。
2. **planner 能力**：只给只读文件工具（推荐），还是允许它跑命令来调研（审批会更吵）？
3. **计划可见性**：O1 把计划只注入执行上下文（推荐，改动小），还是同时写进现有计划面板（需要伪造一次 `update_plan`，复杂度上升）？
4. **跨 provider 组合**：允许（技术上可行），还是限制在同一 provider 内（鉴权更稳）？
5. **默认值**：`plannerEffort` 默认 `high`（对齐 Antigravity），还是 `medium`（省额度）？

---

## 9. Codex 执行守则

- 先读：`pc-server/kernel-engine/{driver,provider,limits}.ts`、`pc-server/model-providers/index.ts:400`、`pc-server/foundation/types/index.ts`（`Assistant.reasoningLevel`）、`docs/plan-planner-task-graph.md`（了解既有计划机制，不要改它）。
- 只做 §5 O1；`provider.ts` 与 `agent-kernel` **本轮不改**。
- 新代码默认关闭；所有新分支都要有"关闭时零变化"的测试。
- 不新增依赖；不调用真实计费接口做测试。
- 完成后报告：改动文件、测试输出、演示记录、§8 未决项。

---

## 附录：代码位置

- 模型解析：`pc-server/model-providers/index.ts:400`（`findModel` / `findModelStrict`）
- 适配器（ctx 决定 provider/auth/能力）：`pc-server/kernel-engine/provider.ts:54-125`
- 生成入口与 runtime 装配：`pc-server/kernel-engine/driver.ts:51-212`
- 预算与并发：`pc-server/kernel-engine/limits.ts`、`driver.ts:30-33`
- 既有计划机制：`docs/plan-planner-task-graph.md`、`pc-server/tools/plan.ts`
- 思考档换算：`pc-server/model-providers/request-dialect.ts`（`effortLowHighMaxFor`）
