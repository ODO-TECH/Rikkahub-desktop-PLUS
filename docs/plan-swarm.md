# RDP 群蜂（Swarm）实施方案

> 状态：草案，待用户拍板（见 §8）。批准后按 §5 的 M1 开工。
> 目标仓库：`rikkahub-alpha`（RDP 主线）。`rikkahub-cirno` / `rikkahub-reimu` 的 `agent-kernel/src` 与 `pc-server/kernel-engine` 与 alpha 字节一致，改动后续同步即可。
> 姊妹文档：[plan-orchestrator.md](plan-orchestrator.md)（双模型规划/执行）。**顺序：先做 Orchestrator O1，再做本文 M1**，两者都要改 `driver.ts`，避免并行冲突。
> 本文只描述方案，未改动任何代码。

## 0. 给 codex 的 TL;DR

在 agent-kernel 里新增「共享留言板（board）」能力，让现有 `Superagent` 从"一次性 DAG 工具"升级为"带黑板的多 worker 协作"：worker 各自独立上下文，只通过 board 交换信息；宿主新增 `swarm` 工具（主 agent 专属）。M1 不改 UI、不做后台常驻、不做 worktree 隔离。M1 完成后停下来报告，等用户验收再进 M2。

---

## 1. 外部参照：Antigravity `/swarm` 做了什么（事实）

来源：`https://antigravity.google/docs/swarm/`、`https://antigravity.google/docs/changelog/`（CLI 1.5.5–1.5.16）。以下只列与实现有关的机制，不搬产品包装。

1. **发起即接管**：`/swarm <task>` 把当前会话变成 coordinator。coordinator 命名蜂群、把任务切成互不冲突的块（按文件/包/调查线），为每块加一个有名字的 worker（`@parser`、`@api-tests`、`@fix-1`…）。
2. **公开简报**：每个 worker 从干净上下文启动，它的 brief（负责什么、不许碰什么、怎样算完成）贴在 board 上，全员可见。
3. **验证者**：每 2–4 个 worker 配一个 `@verifier`，读 diff、跑测试，把问题回报给写代码的那个 worker，后者修。
4. **黑板是唯一通道**：assignments、提问、diff 摘要、测试结果都发到 board，用 `@name` / `@group` / `@all`；worker 之间不私聊，团队对话保持一条有序记录。
5. **空闲不烧 token**：没活干的 worker 在 board 上睡眠，被 mention 唤醒才继续。
6. **monitor**：coordinator 另加一个 `@monitor`，平时睡，只在全员静默且未完成时发帖催进度。
7. **coordinator 不干技术活**：只分发、判断、向人汇报。
8. **模型**：worker 默认用会话模型；可以对单个或全体指定别的模型；等待中的 worker 可以换模型并保留对话。
9. **工作区**：默认共享工作区；并行编辑/构建重叠时，coordinator 可给每人一份仓库副本（移除 worker 会删副本，所以要先落地改动）。
10. **成员状态**：`Active`（跑）/ `Waiting`（睡，零 token）/ `Killed`（永久移除，不能复活，只能新加）。配额耗尽时成员**暂停而非重试**，不自动恢复。
11. **观察与干预**：App 的 Swarm 面板有 Board / Members / Graph（带回放）；CLI 有状态行 + `Alt+S` 全屏 board（Roster / Posts / Message），`Alt+J` 跳到下一个待审批 worker，`Ctrl+K` 就地批准。
12. **定位**：官方对比表把 `/swarm` 放在"广而可切分、分钟到小时、所有套餐"；`/teamwork` 才是"小时到天、付费、专属项目目录、里程碑闸门"；`/boost` 是"难而窄"；subagent 是"单个后台小任务"。

**对我们最关键的三个结论**

- 共享的从来不是 message，是 **board**；每个 worker 的上下文是私有的。
- 唤醒是 **mention 驱动**，不是轮询。
- 并行写同一仓库需要 **每 worker 一份工作副本**；没有它，swarm 只能做只读调查或严格按文件切分。

---

## 2. 功能目标（本文档的执行口径）

### 2.1 要做

在 RDP 内提供与 `/swarm` 同构的能力（M1 范围）：

- 主 agent 通过一个工具发起"群蜂"：给定总目标 + 1–4 个具名任务 + 可选 verifier（M1 不配置每个 worker 的模型）。
- 每个任务在**独立 Run（独立 messages）**里执行；默认并发 2（受后台模型槽限制），可配置但不改变默认。
- 任务之间只通过**持久化 board** 交换信息；board 有 `@` 路由、未读游标、每步增量注入。
- verifier 读各任务产出（结果文本 + 证据）并把问题 `@` 回具体任务；被点名的任务获得一次"修复轮"，verifier 最多复核一次。
- 全程共享根预算，并加**每 worker token 上限**，防止单个 worker 吃穿全队。
- 失败/取消语义与现有工具一致：主流程中断则整蜂取消；进程重启不承诺续跑（沿用现状，见 §4.5）。

### 2.2 明确不做（M1）

- 不做后台常驻/边跑边聊（`swarm` 工具同步阻塞到结束，和今天的 `superagent` 一样）。
- 不做动态增删成员（plan 在发起时定型；失败后由主 agent 再发一次或 `replan`）。
- 不做 UI 面板（board 先在工具输出与「运行详情 → 子任务」里可见）。
- 不做 worktree/工作副本隔离（并行写靠"按文件切分"的自律 + 现有写锁）。
- 不做跨进程恢复、不做定时/IM 触发的蜂群。
- 不改 `superagent` 工具的默认行为与计数口径。

### 2.3 验收口径（人可判断）

1. 一个 3 任务蜂群在演示模式下跑完，工具输出里有 `board` 帖子列表、每个任务的轮次/结果、verifier 结论。
2. verifier 点名 `@task-a` 后，task-a 确实新开一轮并看到那条帖子；修复轮数不超过 1。
3. 任意 worker 的 token 超过上限时，该 worker 以 `limited` 结束，其余 worker 和主流程不受影响。
4. 现有的 `superagent` / `subagent` 行为、测试全部不变。
5. `agent-kernel` 单测全绿；`pc-server` typecheck 通过、测试与基线一致（见 §6.2）。

---

## 3. 现有底座（已核对，直接引用）

| 事实 | 位置 |
| --- | --- |
| Run = 独立 messages/tools/limits/status/pendingTools/inbox；JSON 存 SQLite `runs` | `agent-kernel/src/types.ts:94`、`store.ts:14` |
| 模型槽 3、**后台槽 2**、工具槽 2；写互斥、读并行 | `pc-server/kernel-engine/driver.ts:30-33`、`agent-kernel/src/concurrency.ts` |
| 子任务深度 1；`createWork()` 可跳过 depth、挂同一预算 | `agent-kernel/src/runtime.ts:106`、`types.ts:151` |
| `Ticket` / `Task` 持久化，含 status / runId / result / evidence / replans | `agent-kernel/src/types.ts:126-148`、`superagent.ts` |
| 固化 plan、wave 并发、`maxWorkers`、`replans`、outbox 回执 | `superagent.ts:26-214` |
| worker 只拿到 `Overall task + Assignment + 依赖结果.slice(0,8000)` | `superagent.ts:117-125` |
| `verify` 回调已存在但宿主没传（未接线） | `superagent.ts:22-23`、`driver.ts:117` |
| `superagent` 工具：主 agent 专属、最多 6 任务、2 worker、2 replan | `driver.ts:110-131` |
| 工具卡与子任务 UI 已有；`kernel-runs` 端点按 rootId 返回全部 run（含 worker messages） | `driver.ts:215-229`、`api/handlers/conversations.ts:414`、`web-ui/app/components/workbench/agent-activity-panel.tsx` |
| 预算：`reserve` 只认 rootId；`maxTokens = contextTokens × maxRequests`（宿主 96 请求 / 48 步） | `store.ts:53`、`kernel-engine/limits.ts` |
| 每一步的注入点：`drive()` 里 `drain()` 之后、`prepareContext()` 之前 | `runtime.ts:221-226` |
| 耐久 tick（15s，先落库再投递）已有，可复用于 M2 唤醒 | `pc-server/agent-loop/scheduler.ts` |
| 无 worktree / 无 board / 无动态成员 / 无 mention 唤醒 | 全仓 grep 确认 |
| Store 对版本做**精确等于 1** 的检查；新增表可用 `CREATE TABLE IF NOT EXISTS`，不要擅自 bump | `store.ts:12-13` |

---

## 4. 设计

### 4.1 数据模型（增量、可回滚）

只加两张表，不改既有表结构；`Ticket` / `Task` 只加可选字段（JSON blob 天然兼容旧数据）。

```sql
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT, -- 全局单调序号，兼作游标
  ticket_id  TEXT NOT NULL,
  author     TEXT NOT NULL,                     -- 'coordinator' | task id | 'system'
  recipients TEXT NOT NULL,                     -- JSON: ["task-a"] 或 "@all"
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_ticket ON posts(ticket_id, id);

CREATE TABLE IF NOT EXISTS post_cursors (
  run_id    TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  last_id   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, ticket_id)
);
```

`Ticket` 新增可选：`board?: boolean`、`verifierId?: string`、`maxFixRounds?: number`。
`Task` 新增可选：`round?: number`（`TaskSpec` 已有 `tools`，沿用）。

Store 新方法（签名固定，便于测试）：

```ts
post(ticketId: string, author: string, recipients: string[] | "@all", body: string): number
posts(ticketId: string, afterId: number, limit?: number): Post[]
unreadCount(ticketId: string, runId: string): number
markRead(ticketId: string, runId: string, lastId: number): void
```

约束：`body` 截断到 4 000 字符；`posts()` 默认最多 50 条；不提供删除（M1 不做回收）。

### 4.2 上下文共用协议（本方案的核心）

共享层次固定为四层，任何一层都不允许"全量复制别人的 messages"：

| 层 | 内容 | 上限 |
| --- | --- | --- |
| 共享系统提示 | 发起时会话的 system 消息拼接（沿用 `driver.ts:121`） | 原样 |
| 启动简报 | `Overall task + 你的 Assignment + 依赖结果切片` | 8 000 字符/条（沿用） |
| board 增量 | 只看 **未读 + 点名到你或 @all** 的帖子 | **1 200 字符/步** |
| 预算 | 根预算共享 + 每 worker 令牌上限 | 见 §4.4 |

注入实现：

1. `AgentRuntime` 新增 `setContextHook(runId, fn: (run) => string | undefined): () => void`，内部 `Map<runId, fn>`。
2. `drive()` 在 `drain()` 之后、`beforeStep`/`prepareContext` 之前调用该 hook；返回非空则 push 一条
   `{role:"user", content:"[swarm board]\n..."}` 并 `save`。
3. `Superagent` 在创建每个 worker run 后注册 hook；run 结束时注销。hook 内容：

```ts
function digest(ticketId, runId, taskId, maxChars = 1200): string | undefined {
  const last = cursor(runId);                 // post_cursors.last_id
  const unread = store.posts(ticketId, last).filter(p =>
    p.recipients === "@all" || p.recipients.includes(taskId));
  if (!unread.length) return undefined;
  // 从最新往回装，装不下就停；游标记到"最后一条被装进去的"
  // 头部：`你是 @<taskId>（第 N 轮）。以下是你未读的 board 帖子：`
  // 尾部：`如需回复，用 swarm_post；不要复述整块 board。`
}
```

4. 截断策略：优先保留**最新的**未读；被跳过的旧帖记一行 `（更早 N 条未读已省略）`，游标照样推进——宁可丢旧帖，不可让上下文失控。
5. 注入只发生在步边界；不得打破 tool-call 配对（`validateHistory` 会拒绝）。
6. 非 swarm run 不注册 hook → 零行为变化。

### 4.3 成员状态机与"唤醒"

M1 不做真实睡眠（没有后台调度），用**确定性轮次**表达等价语义：

```
状态：pending → running → (completed | failed | limited)
      completed 的任务若有未读点名且 round < maxFixRounds → 允许新开一轮（reopen）
```

`advance()` 改为：

```
while (true):
  candidates = tasks where
      (no runId AND deps completed)                       // 首次
   OR (runId && lastRun terminal AND unreadCount>0 AND round<maxFixRounds)  // 唤醒
  if candidates empty: break
  wave = candidates.slice(0, maxWorkers)
  await Promise.all(wave): 创建/复用 run → resume
  // 每轮结束把 task.result 截 8000 存回 ticket（沿用）
```

- `Killed`：M1 不暴露 kill（成员固定）；`replan` 时旧 run 全部 cancel，等价于整队替换。
- verifier：作为普通任务，`dependsOn` 默认所有 worker。它完成后：
  - 若其帖子点名了 worker → 进入修复轮；
  - 修复轮全部结束后，**verifier 再跑一次**（`verifyRounds = 1`），仍失败则整体 `failed`，不再循环。
- monitor：M1 不做（没有后台等待，监视无意义）。

**board 写入口**：每个 worker 的工具列表里追加一个 `swarm_post`：

```json
{ "text": "string(1..4000)", "to": ["task-a"] | [] }   // 省略 to = @all
```

实现方式：宿主注册一个全局 `swarm_post` 工具（不在主 agent 的声明里，只出现在 swarm worker 的 `run.tools`），execute 用 `context.runId` 在宿主 `SwarmHub` 里反查 `{ticketId, taskId}`。`Superagent` 通过新选项 `onRun?: (runId, info:{ticketId,taskId}) => void` 通知宿主登记。

### 4.4 预算与并发

- 根预算仍由 `store.reserve(rootId)` 硬控（行为不变）。
- 每 worker 上限：`Limits` 加可选 `perRunTokens?: number`；`request()` 在 reserve 成功后追加检查：

```ts
if (run.id !== run.rootId && run.limits.perRunTokens) {
  const used = run.usage.inputTokens + run.usage.outputTokens;
  if (used + reserved > run.limits.perRunTokens)
    throw new LimitError(`Worker token cap reached (${used}/${...})`);
}
```

- `Superagent` 计算：`perRunTokens = floor(剩余预算 / (worker 数 + 1))`，下限 `maxOutputTokens × 4`（保证至少能跑起来）；读 `store.budget(rootId)`。
- 并发保持 `maxWorkers ≤ 2`（M1 硬编码，参数可传但 clamp 到 2）；原因是 `backgroundModelSlots(2)` 与 `toolScheduler(2)`。提高到 4 属于 M3，需要同时评估供应商 429 与桌面卡顿。
- 返回给主 agent 的 JSON：每个任务 `result` 截 4 000 字符，`board` 只回最近 20 条、每条截 500 字符。**根上下文也要省**。
- **worker 模型（M1 固定跟随会话）**：`request.model` 虽然会透传，但 `DesktopProvider` 的鉴权、端点、能力判定都取自 `ctx.model`（见 `plan-orchestrator.md` §3）。只改 model id 会错配；per-worker 模型要复用 Orchestrator 的 `ModelTarget`，列入 M3。

### 4.5 失败与恢复（照实说清）

- 任一 worker `failed/limited`：不重试（除 provider 可重试错误，现有 `maxRetries` 已覆盖）；ticket 整体 `failed`，其余 wave 结果保留。
- 主流程 abort：`tool` 的 `context.signal` 已接到 `supervisor.cancel()`（`driver.ts:123`），整蜂取消。
- 进程重启：沿用 `runtime.recover()` 语义——running → interrupted，不自动续跑；ticket 停在 `running`，M1 不提供恢复入口，只在文档和 UI 文案里说明。
- 审批：worker 的宿主工具审批走现有 `gateToolApproval`，卡片出现在同一会话；审批未决时整个 `swarm` 工具调用挂起（与今天 `subagent` 相同）。M2 再解决"多个 worker 同时待批"的跳转。

---

## 5. 实施切片

### M1（本次交付）：kernel + 宿主工具

**代码清单**

1. `agent-kernel/src/types.ts`
   - `Post`、`Task.round?`、`Ticket.board?/verifierId?/maxFixRounds?`、`Limits.perRunTokens?`。
2. `agent-kernel/src/store.ts`
   - 两张新表（`IF NOT EXISTS`）+ §4.1 四个方法；`Post` 类型从 types 导入。**不要改 `kernel_meta.version`。**
3. `agent-kernel/src/runtime.ts`
   - `setContextHook()`；`drive()` 注入；`request()` 的 `perRunTokens` 检查；`createWork` 支持 `TaskSpec.model` 透传（调用方传 `model` 即可，无需改签名）。
4. `agent-kernel/src/superagent.ts`
   - `SuperagentOptions` 增加 `board?: boolean`、`verifierId?`、`maxFixRounds?`、`verifyRounds?`、`onRun?`、`onPost?`。
   - `accept()` 支持 `verifier` 与 `board`。
   - `advance()` 改为 §4.3 的轮次循环；`board` 打开时：创建 run 后注册 digest hook、登记 `onRun`、把任务产出作为自动帖子（author=taskId, to=@all, body=result 前 2 000 字）。
   - 公开 `post(ticketId, author, to, body)` 供宿主工具调用；`inspect()` 返回不变（可选带 `posts` 由宿主另取）。
   - 保持 `board` 默认 `false` → 现有测试与行为不变。
5. `pc-server/kernel-engine/driver.ts`
   - 新增 `SwarmHub`（模块内单例）：`Map<runId,{ticketId,taskId}>`、`post()` 转调 `Superagent`。
   - runtime `tools` 数组加 `swarm_post`（`orchestrator:true`，禁止主 agent 使用：execute 里 `if (!hub.has(context.runId)) return isError`）。
   - 新增 `swarm` 工具：参数 `{prompt, tasks[1..4], verifier?}`，`maxItems:4`；构造 `new Superagent({runtime, maxWorkers:2, board:true, maxFixRounds:1, verifyRounds:1, onRun:hub.register})`；`accept` → `advance` → `complete`；返回 §4.4 形状。仅主 agent（`context.runId !== rootId` 拒绝）。
   - `superagent` 工具保持原样（不传 board），避免回归。
6. `agent-kernel/test/swarm.test.ts`（新增）
   - 用例：board 路由与未读游标；digest 1 200 字符截断且保留最新；verifier 点名后 worker 新轮；修复轮上限 1；verifier 复核轮；`perRunTokens` 命中后该 worker `limited` 而其他继续；`board:false` 时零注入（回归）。
7. `agent-kernel/README.md` / `ALPHA.md` 各加一小段（可选，不阻塞）。

**M1 完成门槛**

- `cd agent-kernel && bun test && bun run typecheck` 全绿（新增测试全过，旧测试零改动）。
- `cd pc-server && bun run typecheck` 通过。
- 演示模式手工跑一次 3 任务蜂群，贴出工具输出与子任务面板截图（或文本记录）。

### M2（验收 M1 后再启）：后台与可观察

- 常驻 `SwarmHub` 按 `conversationId + ticketId` 持有 supervisor；工具立即返回 `swarmId`。
- 新增工具：`swarm_status` / `swarm_post`（主 agent 也能发帖）/ `swarm_member_add` / `swarm_member_kill`。
- 唤醒用 in-process notify（有帖子就唤醒对应 run），**不要**用 15s tick 轮询跑模型；`agent-loop/scheduler.ts` 只用于定时发起。
- UI：`agent-activity-panel` 增加「蜂群」标签页（Board / Members），数据走现有 `kernel-runs` + 新增 `swarm-posts` 端点（只读）。
- 审批跳转：状态行显示待批数量，`Ctrl+K` 批准当前、`Alt+J` 跳下一个（对齐 Antigravity 的交互，但按 RDP 现有快捷键体系落地）。

### M3（暂不做，只记录）

- per-worker 工作副本（没有 git worktree 的 RDP 需要先决定用目录复制还是引入 git）。
- 重启续跑（ticket 级恢复，需要先在 store 里把"已领取的 launch"落库）。
- 定时/IM 触发的常驻蜂群（对接 agent-loop / AgentBot）。

---

## 6. 回归与验收

### 6.1 命令（Windows，Git Bash）

```bash
cd agent-kernel && bun install --ignore-scripts && bun test && bun run typecheck
cd ../pc-server && bun run typecheck
cd ../web-ui && bun run typecheck && bun test
```

### 6.2 已知基线

- `pc-server bun test` 在 Windows 上恒定有 2–3 个非回归失败（`C:\WINDOWS\Temp` EPERM、e2e EBUSY）。**不要为此 bisect**，只要失败集合与改动前一致即可。
- 前端基线 591 项单元测试全过（0.2.1 记录）。
- 演示模式与真实模式数据目录分离（`demo-data/` vs `alpha-data/`）；调试端口见 ALPHA.md，不要写死。

### 6.3 不许出现的回归

- `superagent` 工具的任务数、并发、预算计数、返回 JSON 形状不变。
- `subagent` 深度与工具可见性不变。
- 非 swarm run 的 messages 里不出现 `[swarm board]`。
- `kernel_meta.version` 不变；旧数据库能直接打开。

---

## 7. 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 并行写同一仓库无隔离 | 两个 worker 互相读到中间态，结果不可信 | M1 只承诺"按文件切分"；文档明说；M3 worktree |
| board 注入撑爆上下文 | worker 提前撞 `contextTokens`，压缩更频繁 | 1 200 字符/步硬上限 + 只留最新 + 游标前推 |
| 后台槽只有 2 | "蜂群"实际是 2 路并行，慢任务会排队 | M1 clamp 到 2；M3 前不改 |
| worker 模型错配 | 单独指定模型时鉴权/端点仍按会话模型 | M1 禁止 per-task model；见 plan-orchestrator.md §3 |
| 每步输入重复计费 | 3 worker × 8 轮就能吃掉大半预算 | 每 worker 令牌上限 + 返回裁剪 |
| 同步阻塞工具调用 | 蜂群跑 5 分钟，主会话被占 | M2 改后台；M1 在工具描述里写明"较慢" |
| 审批拥堵 | 多个 worker 同时待批，卡片互相挤 | M2 做跳转；M1 限制 2 worker |
| `refreshTools` 只能用于非活跃 run | 工具加晚了会抛错 | 只在 `createWork` 之后、`resume` 之前登记 |
| 旧库无 `posts` 表 | 打开即用，表按需创建 | `IF NOT EXISTS` + 不改版本号 |

---

## 8. 待用户拍板（默认值已写进方案）

1. **入口**：新增 `swarm` 工具（默认），还是改造现有 `superagent` 加 `mode` 参数？
2. **M1 是否必须"边跑边聊"**：默认否（同步阻塞），后台放到 M2。
3. **并行度**：默认 2。若坚持 3–4，需要同时调 `backgroundModelSlots` 并接受更慢的排队/更高的 429 概率。
4. **是否本轮就动 UI**：默认不动；board 先在工具输出里看。
5. **落地树**：默认 `rikkahub-alpha`；`cirno` / `reimu` 在 M1 验收后同步（内核文件一致，同步成本低）。
6. **worker 模型**：是否接受 M1 里所有 worker 固定跟随会话模型（per-worker 模型推迟到 M3）？默认接受。

---

## 9. Codex 执行守则

- 先读：`ALPHA.md`、`agent-kernel/README.md`、`agent-kernel/src/{types,store,runtime,superagent}.ts`、`pc-server/kernel-engine/driver.ts`。
- 只在 §5 M1 清单内改动；任何需要动 `web-ui` 的改动都属 M2，先停下问。
- 不新增第三方依赖；内核只用 Bun 内置（SQLite、fetch、stream）。
- 所有新行为必须默认关闭（`board:false`），用新测试锁住；旧测试不改断言。
- 提交粒度：store → runtime → superagent → driver → tests，每步可独立 typecheck。
- 完成后输出：改了哪些文件、测试结果、演示记录、以及 §8 里仍未定的项。
- 遇到 §8 未决问题影响实现时，**停下来在对话里问**，不要自己扩展范围。

---

## 附录 A：Antigravity 原文关键句（便于对照）

- "Each worker gets a public brief… starts with a clean context in its own conversation."
- "A verifier checks the work… reads the diffs, runs the tests, and reports problems to the worker that wrote the code."
- "Workers don't message each other privately, so the whole team conversation stays in one place, in order."
- "A worker that has nothing to do… goes to sleep on the board without using tokens. It wakes automatically when another member mentions it."
- "Workers share your workspace by default… the coordinator can give each one its own working copy."
- "Killed: a killed worker can't be revived; the coordinator adds a new worker instead."
- 定位表：`/swarm` = "Broad tasks that split cleanly across independent files, packages, or investigation tracks"，分钟到小时，所有套餐。

## 附录 B：代码位置索引

- 内核：`agent-kernel/src/{types,store,runtime,superagent,concurrency,context}.ts`
- 宿主接线：`pc-server/kernel-engine/driver.ts`（工具注册 L107-131、runtime L135、事件 L168、run 视图 L215）
- 预算：`pc-server/kernel-engine/limits.ts`
- 运行视图端点：`pc-server/api/handlers/conversations.ts:414`（`kernel-runs`）
- 前端：`web-ui/app/components/workbench/agent-activity-panel.tsx`（运行详情/子任务）
- 调度器（M2 用）：`pc-server/agent-loop/scheduler.ts`
- 既有测试风格：`agent-kernel/test/superagent.test.ts`
