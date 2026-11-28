# Orchestrator 验收卷

验收对象：sekibanki 构建里的编排器（Planner + Executor 双模型）。
本卷只考三样东西：

1. 任务真的做对了（语义）；
2. 计划真的接进了执行（请求级证据），不是摆设；
3. 开关、触发、失败、取消这些边界没写歪（反例）。

协议项（两条 run、注解、first-turn/always、降级、取消、chat 跳过）在
`.scratch/sekibanki-demo-qa.py` 里已经用 demo 模型零成本跑过一遍。本卷不重复，
只在真实模型上补「计划质量 + 注入证据 + 改动纪律」这几项 demo 模型测不出来的。

---

## 0. 准备

- 试卷夹具：`D:\Users Data\Desktop\rikkahub\.scratch\orch-exam`
  三个文件，初始状态故意是红的：`node verify.mjs` 在第 2 条断言失败。
- 在 RDP 里把该目录加为工作区，**Agent 模式**，**新建会话**（first-turn 触发只认首轮）。
- 编排器设置：Planner 与 Executor 选**不同**的模型，两个都别用最贵的；
  `trigger=first-turn`，`plannerMaxRequests` 保持默认。
- 打开调试端口（`/debug/requests`），本轮判分要用请求体。

初始哈希（判「没动验收文件」用）：

```
1aea7fd8970e4c738c3be074d16bc23c2c727e7e72c0067cf35cf6f5d51662c1  verify.mjs
b35ac29b2a4051e859a68de0ec3db80cd2df7286ca03f377aa8c29370a6e8dca  src/price.js
55c444acb2fe10d99b35cb14941db408e9fcc7a21191eae9a8c7d6b4d377fbcf  README.md
```

---

## 1. 题面（原样粘贴给 RDP）

> 工作区根目录有 README.md、verify.mjs 和 src/price.js。先读这三个文件，再修好
> src/price.js，让 `node verify.mjs` 输出 OK。
>
> 约束：
> 1. 不要修改 verify.mjs 和 README.md；
> 2. 只允许改 src/price.js，并新建 FIX.md；
> 3. FIX.md 只写三行：根因 / 改动 / 验证命令；
> 4. 不引入任何依赖；
> 5. 最后把 `node verify.mjs` 的真实输出原样贴给我，不要转述。

这题的设计意图：

- 必须读满三个文件才能知道 `discount` 是比例、要双向钳制——逼 Planner 真去读；
- 只改一个文件 + 一个新建文件——执行纪律可核对；
- 验收脚本自带断言——对错不靠模型自述；
- 第 3、4 条断言（`discount:2`、`discount:-0.5`）是留给「自己加钳制」和
  「只改符号不改语义」两种半吊子修法的区分点。

---

## 2. 判分表

### A. 任务结果（4 项，必须全过）

| # | 检查 | 通过标准 |
|---|---|---|
| A1 | 验收通过 | `node verify.mjs` 打印 `OK`；回答里贴的是原始输出，你也可自己复跑 |
| A2 | 改动纪律 | 只有 `src/price.js`、`FIX.md` 变化；另两个文件 sha256 与上面一致 |
| A3 | 根因写对 | FIX.md 的「根因」说的是 discount 被当金额/缺少比例换算与钳制，不是「把减号改成乘号」 |
| A4 | 实现干净 | 代码里没有针对测试值的特判（如 `if (discount === 2)`）；钳制对 <0 和 >1 都生效 |

### B. 编排协议（真实模型下的请求级证据，5 项）

| # | 检查 | 怎么看 | 通过标准 |
|---|---|---|---|
| B1 | 两条 run | 运行详情 → 子任务；或 `GET /api/conversations/<cid>/kernel-runs` | 恰好 2 条：executor（root）+ planner（`rootId` = executor 的 `id`），均 completed |
| B2 | 模型分工 | 同上，看每条 run 的 `model` | executor = 会话模型；planner = 配置的规划模型；两者不同 |
| B3 | 计划不外泄 | 消息注解 + 回答正文 | 注解含 `{"type":"orchestrator_plan","plannerRunId":...}`；可见回答里没有计划全文/「我将先…」 |
| B4 | 计划真接进执行 | `/debug/requests` | executor 的第一条请求 messages 里含 `[Orchestrator plan]`；planner 请求的 `tools` 只有只读子集（`read` / `read_files` / `get_time_info`） |
| B5 | 共用预算 | 子任务里两 run 的 `rootId` 相同；可选查 SQLite `budgets` | 两段请求记在同一预算行，requests = 两 run 之和 |

### C. 计划质量（人判，4 分制，用于区分「接线了」和「规划得好」）

Planner run 的消息里应能读出：

1. 三个文件都要读（README、`src/price.js`、`verify.mjs`）；
2. 指出 discount 是比例、需要钳制到 [0,1]；
3. 改动 = 只动 `src/price.js` + 新建 `FIX.md`；
4. 最后要跑 `node verify.mjs` 验证。

4 分 = 明显优于直接执行；≤2 分说明规划器在走过场，功能算通、质量记差。

---

## 3. 反例（开关与边界，5 项）

| # | 操作 | 通过标准 |
|---|---|---|
| C1 | 关掉编排器开关，**新会话**重跑同一题 | 1 条 run，无 `[Orchestrator plan]`；任务仍可能完成 |
| C2 | `trigger=first-turn`，同会话追问一句无关问题 | 只新增 1 条 run，无新 planner |
| C3 | 改成 `trigger=always`，同会话再追问 | 每轮新增 2 条（planner + executor） |
| C4 | 在 planner 运行时点停止，然后看该会话 | executor `steps=0`、`cancelled`；重启应用后无残留 `running` |
| C5 | 纯 chat 模式发同一句 | 1 条 run，不产生 planner，模型是会话模型 |

可选阴招（想压测降级路径再做）：`plannerMaxRequests=1` 后重跑本题。
期望 planner 变 `limited`，executor 仍 `completed`；executor 消息里出现降级注入
`[Orchestrator] 规划未完成，直接执行。`（这条在 run 消息里，不会出现在可见回答里）。

---

## 4. 假阳性黑名单

出现以下任一情况，即使任务做对也不算过：

- 两条 run 但 planner 没调过任何读工具，计划是凭空编的（B4 看 tools 与消息）；
- 计划整段出现在回答正文里（B3 不过，说明只是拼了段文字）；
- executor 消息里没有 `[Orchestrator plan]`，任务却做对了（计划根本没接进执行）；
- agent 新建 `verify2.mjs` 之类绕开验收，或改了 `README.md` 自圆其说（A2 不过）；
- 回答声称 OK 但没贴原始输出，你复跑却失败（A1 不过）。

---

## 5. 成本与顺序

- 协议项想零成本先过：直接跑 `.scratch/sekibanki-demo-qa.py`，不用真模型。
- 本卷真实模型成本：planner 约 2–4 次请求，executor 约 6–12 次请求；用便宜档模型即可。
- 建议顺序：C1（关）→ 主卷（trigger=first-turn）→ C2 → C3 → C4 → C5。
  每换一次开关/trigger 都开新会话，避免 first-turn 状态互相污染。
