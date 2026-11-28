# RDP agent-lite 开发计划（上游 v6 取舍 + 收尾工程）

> 2026-11-28 执行修正：按用户指令在 0.2.1 主线开发，Bun 更新最后处理。S3 的异步进程/工作区 Bash 登记与关停、S5 五项回归已落地；同步 spawnSync 尚未纳入 PID 登记。S6 核实发现 MCP 已在工作区暴露，旧前提有误，保留现有审批行为。详见工作区 `docs/audit-codex-s3-s5-s6-2026-11-28.md`；下文旧进度、数字和“并行/待批准”均为原计划历史。
> 进度（2026-11-27）：**S0、S1、S2、S4 已完成**；S3、S5 待批准；S6 条件触发；S8 可选。
> 完成记录：S1 会话收尾对账 + FTS 行号目录（含计数守卫测试）；S2 代理探测守卫（R1-7 已有缓存，本次只补测试与诊断）；S4 升级冒烟脚本与 0.2.1 样本（Windows/WSL 实测通过）。
> 目标仓库：`rikkahub-alpha`（0.2.1 主线）。`rikkahub-sekibanki`（Orchestrator O1）与 `rikkahub-reimu`（跨平台沙盒）是参照预览副本，alpha 验收后再同步。
> 姊妹文档：[dev-workflow.md](dev-workflow.md)（流程规范，本批同改）、[plan-orchestrator.md](plan-orchestrator.md)、[plan-swarm.md](plan-swarm.md)；工作区 `docs/audit-upstream-fixes-2026-11-24.md`（v5 对照，已完成）。
> 开工前快照：工作区 `backups/agent-lite-plan-20261127/`（三棵树源码 zip + manifest.json，sha256 已记）。
> 本文只描述方案，未改动任何代码。

## 0. 给执行者的 TL;DR

RDP 的定位是**在 PC 上接替安卓版 RikkaHub 的轻量客户端（agent lite）**，不是给 pi agent 做前端。上游 v2.0.0-preview-v6 把整套架构押在 pi + 插件生态上，方向相反，**整条不跟**；只移植它的"收尾工程"：会话落库对账 + FTS 行号目录、代理探测缓存、子进程纪律、升级冒烟、内核历史一致性回归。共 6 个故事 + 2 个可选 spike，全部不依赖 pi，全部落 alpha。每个故事做完停下来报告，验收后再进下一个。

---

## 1. 定位与边界

### 1.1 是什么

- **安卓版的 PC 接替者**：会话、助手、供应商、记忆、MCP、技能、世界书、备份的语义与安卓版对齐（双向互导已有），PC 侧做增强：工作区、受限沙盒、桌面壳、IM 接入、媒体生成。
- **agent lite**：内置轻量内核 `agent-kernel/src`（1,265 行、9 文件、零第三方运行时依赖），在主进程内运行；不引入外部 agent 运行时，不为引擎另起常驻进程。
- 体量纪律：内核保持小，能力放宿主（provider / 工具 / 上下文 / 审批）。上游"胶水 + pi 核心"约 12.8 万行，我们后端 9.1 万行且含记忆/IM/搜索/SSH/备份/媒体，这个比例是定位的一部分，不是偶然。

### 1.2 明确不做（本轮及可见未来）

- 不复活 pi，不做 pi 的前端或宿主（pi 已于 2026-11-22 退役，41 个文件归档在 `backups/alpha-retired-pi-20261122.zip`）。
- 不做插件市场、插件安装器、第三方插件裁决层（上游 P7 整条）。将来若给 agent-kernel 开放第三方工具，只借鉴其**治理清单**（见 §4 S6），不搬代码。
- 不做引擎宿主子进程 + JSON-RPC 增量传输：那是为跨进程 pi 服务的，我们 in-process 没有这份开销。
- 不做提示缓存预热：长审批期间靠重发请求给 Anthropic 缓存续命，花 token；我们主力供应商不是 Anthropic。
- 不翻转 Claude 提示缓存默认值（上游把官方端点改成默认开，属计费行为变更）；我们已有 `cache_control`（含 1h TTL）。
- swarm 常驻后台 / worktree 隔离另案（plan-swarm.md），不在本计划内。

---

## 2. 上游 v6 对照（事实，已核实）

基线：`reference/rikkahub-desktop-upstream` @ `3db9b17` = tag `v2.0.0-preview-v6`（2026-11-26）；上次对照 `8b9e226`（v5，2026-10-06）。区间 146 提交 / 478 文件 / +39,986 −9,806 行。主体是 11-10 切出的 `exp/engine-platform` 分支在 11-26 合入 main。

| 项 | 核实结论 |
| --- | --- |
| 官方发布说明 | 只有三条：支持 Pi 插件生态、Bun 1.4.5、重写 README |
| "前端性能优化" | **不成立**。`web-ui/vite.config.ts`、`react-router.config.ts` 与 v5 逐字节一致，无新增分包 / lazy；10 个 `perf()` 提交全在 `pc-server`。唯一界面性能改动是日志页列表不带正文（上游 300 轮留存可达约 96M 字符；我们是 100 条环形日志，问题不成立） |
| 长会话治理（PF） | `conversations/fts.ts` 新增 `pc_message_fts_dir` 行号目录（node_id 有索引 + 级联）；`conversations/index.ts` 的 `persistConversationInto` 只对账有变化的行；`assistants` 模板上下文按请求构建一次 |
| 代理探测（PF2.1） | `foundation/system-proxy-probe.ts` 后台 Worker 探测并推送，请求路径不再 spawn；提交信息记发上游中位 48→20ms |
| 进程角色 + `--splitting` | `foundation/process-roles.ts`（server / extract-worker / engine-host）+ 懒加载分派；主进程就绪 335→256ms、RSS 118→104MB |
| 跨进程增量（P7.2.4/7.2.8） | 请求正文与输出只传新增，字节守卫测试；**仅引擎宿主路径受益**，与我们无关 |
| 提示缓存预热（PW） | 重做版；官方 Anthropic 端点默认开 + 一次性迁移标记；长审批期间重发请求，不计入统计 |
| 证据强度 | 所有墙钟数字只写在提交信息里，仓库内无 benchmark、无计时断言；可复现的是"写入行数 / 字节数"守卫测试 |
| 合并面 | 上游改的 478 个文件里 196 个在 alpha 同名存在，**无一内容一致**，累计差异约 2.8 万行；热点 `routes/conversations.tsx`(2029)、`orchestrator.ts`(1265)、`backup/import.ts`(1264) → **不做主干合并，只按故事定向移植** |

v5 的 9 项数据安全 / 协议兼容修复已在 2026-11-24 审计中确认 alpha 全部有等价实现，本轮不重复核对。

---

## 3. 我们已经有的（不重复学）

流式脏节点增量写（200ms 合批、流式期间跳过 FTS 重分词）、Claude `cache_control`（含 1h TTL）、DeepSeek 搜索、斜杠命令菜单、工作区三档审批（`confirm_each` / `balanced` / `full_access`）、MCP 三传输（stdio / Streamable HTTP / builtin）、受限沙盒、日志页单条详情。

---

## 4. 故事清单

### S0 流程规范去 pi 化（先做，半天内）

`docs/dev-workflow.md` 仍写着 pi 双引擎通路、`pi/` 目录纪律、`pi-engine/workspace-tools.test.ts` 测试清单，以及"不做 PTC"——pi 已退役、Flash PTC 已落地，规范与现状脱节。

- 改：§2 目录归属（pi 相关条目改为"已退役，归档位置"）、§3 双通路改为 `inference-engine`（聊天）+ `kernel-engine`/`agent-kernel`（agent）、§6 测试清单换成现存文件、§11 去掉"不做 PTC"改为"PTC 已落地，新增代码执行面必须走同一硬沙箱"。
- 增：agent-lite 边界（§1.2 摘录）、备份纪律、上游对照流程、性能守卫测试口径、升级冒烟、子进程纪律。
- 验收：文档内不再出现指向已删除文件/目录的指令；新增规则与本文 §4 各故事一致。

### S1 会话收尾对账 + FTS 行号目录（核心，1–2 天）

**现状**：流式热路径已是增量（`upsertMessageNode` + `syncFts=false`）；但流结束、编辑、改名、分叉、导入都走 `persistConversation`——事务内 `DELETE` 该会话全部节点 + `deleteConversationFts` + 逐节点重插 + `replaceNodeFts`。FTS 的 `node_id` 是 UNINDEXED 列，按它删要扫全表。长会话每次收尾都全量重写。

**落点与契约**：

- `pc-server/conversations/fts.ts`：新增 `pc_message_fts_dir(rowid, node_id, conversation_id)` + `idx(node_id)` + 级联到 `pc_message_node`；FTS 行与目录行 rowid 对齐，删除走目录索引。`replaceNodeFts` / `deleteConversationFts` 签名不变。
- `pc-server/conversations/index.ts`：新增 `persistConversationInto(db, conv)`——读库内现有节点行，只对变化的行 upsert、对消失的行 delete，FTS 只重建变化节点；`persistConversation(conv)` 保留为包装，现有 64 个调用点不动。
- 自愈：`openConversationsDb` 时若目录缺失或行数与 FTS 不一致 → 走现有全量重建路径。

**测试**：① 等价性——随机 400 步编辑/分支/删除/重排，新写法与旧写法终态逐行一致；② 写入行数守卫——会话长度 ×10，收尾写入行数不随之线性增长（数学行数，不测墙钟）；③ 目录级联与自愈；④ 搜索语义不变（trigram、1–2 字走 LIKE）。

**验收**：300 轮会话样本下，流结束/编辑/改名的写入行数与耗时明显下降；搜索命中与旧版一致；备份往返不变。

**风险**：旧库首次迁移要重建目录；rowid 对齐错会删错行 → 等价性测试必须覆盖删除与重排。目录是派生数据，默认不进备份（§7.1）。

### S2 代理探测缓存（已完成——R1-7 已有缓存，本次落为守卫）

**核实**：`foundation/net.ts` 在 R1-7 已实现 2s TTL 缓存 + 陈值即用 + 后台单飞刷新（`readSystemProxy` 同步只读缓存，`primeSystemProxyCache` 启动预热）。请求路径没有 spawn；初稿"每请求两次 spawn"的假设不成立。

**本次落地**：只加守卫与诊断——`detectSystemProxy` 探测计数 + `systemProxyDiagnostics()`（只给次数与缓存年龄，不含代理地址）；新增 `foundation/system-proxy-cache.test.ts`：预热后 100 次读零探测；TTL 过期并发读只触发一次后台刷新。

**决定**：TTL 维持 2s（系统代理变化能在一个刷新周期内生效；改 30s 反而迟钝，§7.2 作废）；不引入 Worker（上游为跨进程推送，我们 in-process 不需要）；`applyEffectiveProxy` 行为不变。

### S3 子进程纪律：登记 + 父死清扫 + 启动清扫报清单（1 天）

**现状**：`Bun.spawn` 分散在 `tools/platform.ts`(10)、`tools/mcp-stdio.ts`(3)、`server.ts`(3)、`backup/zip.ts`(2)、`api/handlers/update.ts`(2)、`api/handlers/system.ts`(2)、`foundation/net.ts`(3)、`foundation/spawn-warm.ts`(2) 等处。壳的 Job 管得住后端，管不住脚本直起的进程与 helper 子进程（历史清出 88 个孤儿 / 6.2 GB）。

**改法**：新增 `foundation/child-registry.ts` 统一登记（pid、用途、启动时间）；退出即注销；父进程退出时子进程随之退出（按现有壳机制选最小方案，不新造监管器）；启动时扫描上次残留 → **只报清单，不自动杀**（遵守"清理先问"）。

**不做**：引擎宿主、JSON-RPC 通道、增量传输、2 秒 ping 监管器——我们没有常驻引擎进程。

**测试**：模拟父退出后子进程退出；登记表不泄漏；启动清扫只列自己登记过的 pid。
**验收**：跑一轮 demo + smoke 后无新增孤儿进程，清单可复现。

### S4 升级冒烟（已完成）

学上游 `24b74ec`，已落地 `pc-server/scripts/upgrade-smoke.ts`（`bun run smoke:upgrade`）：

- 样本：`scripts/upgrade-sample/0.2.1/`，用 0.2.1 的 exe 配本文件的假供应商生成（`--generate`），`expected.json` 记录每个会话的节点数、各节点选中的分支与消息 id、以及续聊时发给模型的历史；不含真实密钥。
- 基线 exe：默认 `../release-0.2.1/RikkaHub-0.2.1-windows-x64/rikkahub-pc.exe`，可用 `RIKKAHUB_UPGRADE_BASELINE_EXE` 覆盖；找不到时最后一步"旧版回读"跳过并说明。
- 默认跑法三步：新版打开样本断言历史 → 续聊一轮断言发给模型的历史一致、多出问答 → 0.2.1 打开新版写过的数据，断言新增一轮可见、旧节点不丢。
- 实测：Windows 与 WSL Debian 均 PASS（WSL 无 Windows exe，自动跳过回读）。纳入发版前清单。

### S5 内核历史一致性回归（半天，先测试后改）

**现状（已核实，修正原假设）**：`driver.ts` 每轮 `runtime.create({history})` 用应用历史，本轮只 `resume(刚创建的 rootId)`；`runtime.recover()` **不会续跑任何 run**，只把 `status==="running"` 置 `interrupted`、`running` 工具置 `uncertain`；`resolveInterrupted()` 在生产代码里没有调用点。因此"编辑历史后被旧 native 历史带偏"目前没有路径。

**改法（验证型）**：先补回归测试锁住现状（连续两轮用应用历史、编辑后新轮不带旧消息、分支切换按新分支、残留 running 被收敛为 interrupted 且下一轮新建 run、删除会话后 `kernelRunViews` 不带出）。只有测试发现真实复用路径才加最小校验。**不动 O1（Orchestrator）相关代码**；`resolveInterrupted` 保留并补注释。

**测试**：上述五条；正常续跑与中断语义不变。

### S6 第三方工具审批语义（条件触发，本轮只落规则）

规则：第三方工具（MCP 及将来扩展）在工作区会话**只看档位**；逐工具"需要用户审核"只在对话模式生效；会话级"总是允许"键统一命名。本轮写进 `dev-workflow.md` 与 `tools/permission` 注释，**不改行为**——等 MCP 工具真正放进工作区会话那天再动，避免无场景改动。

将来若开放第三方工具，上游治理清单可当验收标准：保留事件/保留指令剥离、危险注册（供应商/模型/MCP 声明）拦截、安装缓存不进备份、逐工具开关、按会话允许、桌面专属操作不做成通用 API、导出安卓时剥离 PC 专属设置。

### S8 可选 spike（Bun 升级已另立计划）

- **Bun 1.4.2 → 1.4.5**：已拆成独立计划 [plan-bun-upgrade.md](plan-bun-upgrade.md)，与 S1–S5 并行推进；发版前须完成其 B4 打包验收。
- **`--splitting`**：alpha 冷启动已压到 1.9s，预期收益只有几十毫秒；等 S3 把进程角色理清后再试才有意义。

---

## 5. 顺序与同步

```
S0 ✅ → S1 ✅ → S2 ✅ → S3 → **S4 ✅（已提前完成）** → S5 →（S6 条件触发）→（S8 可选，单独拍板）；Bun 升级见 plan-bun-upgrade.md，并行推进
```

- S5 改 `driver.ts`，与 plan-orchestrator O1（sekibanki 已实现、待合入 alpha）有重叠：**先 O1 合入再做 S5 的改动部分**，或 S5 本轮只加测试。
- 每个故事做完停下来报告 + 等验收，再进下一个（dev-workflow §1）。
- alpha 验收后同步 sekibanki / reimu（内核字节一致原则）；同步前各自再快照一次。
- 与 plan-swarm 的关系：swarm M1 也改 `driver.ts`，排在 S5 之后，避免三方并行冲突。

## 6. 验证口径

- 只用本地 mock（`127.0.0.2:18124`，状态端点 `/__state`），不打计费 API；确需计费接口先报价。
- 目标测试 `bun test <具体文件>`，不盲目全量。已知 Windows flake（`C:\WINDOWS\Temp` EPERM、e2e EBUSY）不视为回归，不为此 bisect。
- **性能类故事必须给可复现计数**（写入行数 / 传输字节 / spawn 次数），不只给墙钟数字；守卫测试断言"开销不随会话长度增长"。
- 前端改动需 `web-ui` build 后才在 17455 生效；每次改动后重启 demo，统一走 `demo-server.sh`。
- 新增或修改的测试必须实际跑过并迭代到通过。

**验证记录（2026-11-27，S1/S2/S4）**：
- Windows：`bun run typecheck` 0 错；`bun test` 2810 过 / 9 跳 / 0 败；`smoke:upgrade` PASS（含 0.2.1 回读）；`bun run compile` 产出 `dist/rikkahub-pc.exe`（107,381,248 B），以 0.2.1 样本启动健康、目录重建 6 行。
- WSL Debian（Bun 1.4.2，按 CI 先跑 `prepare-linux-build.ts`）：typecheck 0 错；`bun test` 2767 过 / 52 跳 / 0 败；`smoke:upgrade` PASS（旧版回读跳过——无 Windows exe）。
- Docker：`docker build` 成功；容器以 0.2.1 样本启动，`/api/health` ready，日志「全文索引行号目录重建完成：6 行」；容器内库校验 fts 行 = 目录行 = 6、会话 2、节点 6。

## 7. 待拍板（括号内为默认值）

1. FTS 行号目录是否进备份（**不进**：派生数据，导入后重建）。
2. 代理缓存 TTL（**维持现状 2s**；R1-7 已实现，30s 提案作废）。
3. 启动清扫是否自动杀残留进程（**只报清单，不自动杀**）。
4. S5 是否改 `driver.ts`（**先只加测试**；发现真实复用路径才最小修复，不动 O1 代码）。
5. `--splitting` 是否试（**本轮不做**，S3 之后单独评估）；Bun 升级按独立计划推进（默认目标 1.4.5）。
6. 故事落点（**全部 alpha**，验收后同步 sekibanki / reimu）。

## 8. 备份与回滚

- 开工前快照已完成：`backups/agent-lite-plan-20261127/`
  - `rikkahub-alpha-source.zip`：1400 文件，34,202,222 B，sha256 `888b1a82…995f89`
  - `rikkahub-sekibanki-source.zip`：1414 文件，34,275,723 B，sha256 `0b2f3243…914201`
  - `rikkahub-reimu-source.zip`：1426 文件，34,248,412 B，sha256 `31477da2…8ed4cc`
  - `manifest.json` 记排除清单与上游基线（`3db9b17` / `v2.0.0-preview-v6`）；三个 zip 均通过完整性校验。
- 工具：`tools/backup-source.py`（工作区根）。排除依赖、构建产物（含 Tauri sidecar exe）、运行数据、解包出来的内置 Bash；保留源码、字体与 `bash-bundle.tar.gz`。
- 每个故事开工前再快照到 `backups/<故事-日期>/`；回滚 = 解包对应 zip 覆盖源码，**不动 `pc-data`**。
