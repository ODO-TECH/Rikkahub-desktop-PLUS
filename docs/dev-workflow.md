# 开发流程规范

适用于 rdp（RikkaHub Desktop PLUS）仓内的功能开发，工具面治理与后续特性通用。
本文件只约定流程与边界，不含实现方案；具体方案见 `docs/plan-*.md`。

**定位（agent lite）**：RDP 是在 PC 上接替安卓版 RikkaHub 的轻量客户端——会话/助手/供应商/记忆/MCP/技能/备份语义与安卓版对齐，PC 侧增强工作区、沙盒、桌面壳、IM 与媒体。agent 能力由内置轻量内核 `agent-kernel/src`（零第三方运行时依赖）在主进程内提供，**不引入外部 agent 运行时，不做 pi 的前端或宿主**。当前主线计划见 [plan-agent-lite.md](plan-agent-lite.md)。

## 1. 动手之前

- 先给结论与方案，得到明确批准再改代码。「先看看 / 只看不改」一律按只读处理，并在回复里说明未动文件。
- 改动前完整读一遍要改的文件，不凭搜索片段做宽幅修改。
- 开工前确认本次范围，不夹带无关重构、格式化或顺手优化。
- 每个故事必须有可演示边界和回归清单，做完才允许进入下一个。
- 开工前做源码快照（见 §12），快照落 `backups/<用途-日期>/`，manifest 记 sha256。

## 2. 目录与归属边界

- pi 已于 2026-11-22 退役：`pc-server/pi-engine/` 为空目录，原实现归档在 `backups/alpha-retired-pi-20261122.zip`（清单见 `retired-pi-manifest.json`）。不再新增 pi 相关代码；`vendor/pi-auth/` 只作为 OAuth 快照保留。
- `pc-server/workspace/tools/` 下的工具内核源自上游 pi（逐字移植），pi 退役后内核保留，默认不改。新契约放装饰层与新模块（如 `pc-server/workspace/ops/`），通过 `runtime.ts` 单点挂载；确需改内核时单独说明理由并记录上游同步成本。
- `Operations` 注入只负责 I/O，不用来改输出文本或 schema。
- `pc-data/` 是运行数据，不当源码改；测试产生的工作区、演示数据、备份目录，清理前先列出清单并征得同意。

## 3. 双通路：聊天与 agent

- 聊天走 `pc-server/inference-engine/`，agent 走 `pc-server/kernel-engine/` → `agent-kernel/src`。任何工具行为、schema、输出文本的变更都要同时评估两条通路。
- 通用工具声明集中在 `pc-server/tools/definitions.ts`，不要在某一条通路里单独复制一份。
- 会话级长期状态按 conversation 持久化，不挂在单次生成对象上（内核 run 每轮新建）。
- **应用记录是唯一权威**：内核每轮从应用取历史（`runtime.create({history})`）；内核自己的 store 只在与应用记录一致时复用，编辑、分支、删除后不得拿旧 native 历史续跑。

## 4. 前端与输出兼容

- 前端改动需要重新 build web-ui 后才会在 17455 端口生效。
- `edit` 的 `details.diff / patch` 是前端渲染依据；`write` 的成功文本被字节徽标正则依赖，不要改。
- `details` 字段只增不改不删；新增模型可见信息优先追加文本，不破坏既有结构。
- 转换、摘要、去重类成果在时间线就地展示，原文默认折叠，不做只藏弹窗的实现。

## 5. 设置、数据与导出

- 新能力默认关，用灰度开关控制；关闭时行为必须与改动前一致。
- settings 仍是 JSON，记忆与待确认数据在 SQL，不要把两者混写。
- 新增 PC 专属设置字段必须登记安卓导出剥离清单，与 stdio MCP、长文本粘贴等既有规则保持一致。
- 不删除功能、数据或历史记录；确需删除先问。

## 6. 测试与验证

- 在 `pc-server` 下用 `bun test <具体文件>` 跑目标测试，不盲目全量。
- 工具输出或契约变更至少跑：`workspace/tools/tools.test.ts`、`workspace/tools/fallback-tools.test.ts`、`workspace/runtime.test.ts`，涉及 etag 时加 `workspace/files.test.ts`；内核侧加 `kernel-engine/provider.test.ts`、`kernel-engine/limits.test.ts` 与 `agent-kernel/test/` 下对应用例。
- 已知 Windows flake：`C:\WINDOWS\Temp` EPERM（需管理员）与 e2e EBUSY，全量基线里恒定 2–3 项失败不视为回归，不要为此 bisect。smoke 的 EBUSY 同属 flake，清 lock 用 `/api/app/shutdown`。
- 「单跑绿、合跑红」多为跨文件 `globalThis` 桩泄漏，先查桩清理，不要改业务语义迁就测试。
- 验证只用本地 mock（`127.0.0.2:18124`，状态端点 `/__state`），不打计费 API。确需调用计费接口时先报价再动手。
- 新增或修改的测试必须实际跑过并迭代到通过。
- **性能改动用计数守卫，不用墙钟**：断言写入行数 / 传输字节 / spawn 次数不随会话长度或轮数增长（参照上游 `persist-reconcile`、`rpc-bytes-guard` 的做法）。墙钟数字只作参考，不作为验收依据。

## 7. 沙盒与权限

- 受限沙盒（Windows 低完整性）下，写权限与边界判定口径要与既有实现保持一致；不为了让测试通过而放宽边界检查。
- 工作区读取三档全宽、写编严界的语义不得被新工具绕过；批量读、分页续读、结果落盘都要走同一边界断言。
- 权限模式收窄时，与其相关的缓存、激活集、引用必须失效。
- **第三方工具（MCP 及将来扩展）的审批提案**：工作区会话里只看档位（`confirm_each` 逐个问，`balanced` / `full_access` 不问）；逐工具「需要用户审核」只在对话模式生效；会话级「总是允许」按 `<来源>:<工具名>` 统一命名。**此段是目标提案，不代表现有实现**。2026-11-28 核实 MCP 已通过 `hostCapabilities(true)` 在 Agent/工作区暴露，现有审批入口 `tools/approval.ts` 仍按全局/助手逐工具 `needsApproval` 判断；S6“尚未开放”的旧前提错误。本轮仅记录差异，未改变审批行为，后续变更需单独明确范围。

## 8. 演示服务与进程

- 每次改动后重启 17455 demo，统一走 `demo-server.sh` 收口；不要直接另起后端进程。
- 不用脚本直起 `server.ts` 留下孤儿进程；确实起过的进程，清理前先报清单。
- shot-host 事后退出码 1 属常态，不作为失败依据。
- **子进程纪律**：新增 `Bun.spawn` 必须登记（pid、用途、启动时间），退出即注销；父进程退出时子进程随之退出；启动时扫描上次残留**只报清单、不自动杀**。不为引擎另起常驻宿主进程，不引入 JSON-RPC 引擎通道（agent lite 定位，见 §11）。

## 9. Git 纪律

- 只有用户明确要求时才提交；提交只包含本次自己改的文件，逐路径 `git add`，先 `git status` 核对。
- 禁止 `git add -A` / `git add .` / `git reset --hard` / `git checkout .` / `git clean -fd` / `git stash` / `git commit --no-verify`。
- 本仓常有并行编辑会话：不暂存、不还原、不删除不属于自己的改动；rebase 冲突只解决自己改过的文件，其余中止并报告。
- 提交信息说明为什么改，不只罗列改了什么。

## 10. 文档与发布

- 计划文档放 `docs/plan-<主题>.md`，与既有计划命名一致。
- 发布说明只写变更条目，先给短版，不堆升级指引与构建清单。
- 不擅自新增 README 或重复文档；已有文档能更新就不新建。
- **发版前跑升级冒烟**：`cd pc-server && bun run smoke:upgrade`——上一发布版（0.2.1）的样本 → 新版打开并续聊一轮（本地 mock）→ 断言历史不变 → 再用上一版打开新版写过的数据 → 断言可读。样本在 `pc-server/scripts/upgrade-sample/0.2.1/`，基线 exe 可用 `RIKKAHUB_UPGRADE_BASELINE_EXE` 指定，找不到时自动跳过回读。

## 11. 明确不做的事项（agent lite 定位）

- 不复活 pi，不做 pi 的前端或宿主；不做插件市场、插件安装器、第三方插件裁决层。
- 不做引擎宿主子进程与跨进程增量 RPC（那是为外部 agent 运行时服务的，我们 in-process 无此开销）。
- 不做提示缓存预热（长审批期间重发请求续命，花 token）；不翻转 Claude 提示缓存的端点默认值（属计费行为变更）。
- 不引入 LayerFS、Docker、WSL、CAS 文件系统依赖。
- PTC（代码即工具调用）已落地：`run_code` 走 `inference-engine/quickjs-sandbox.ts` 硬沙箱，默认开。**新增代码执行面必须走同一沙箱与同一熔断口径**，不另开裸执行通道；TS SDK 生成仍不做。
- 不依赖供应商的 `deferLoading` / `tool-addition` 增量工具下发。
- 不为省 token 牺牲正确性：证据不足时一律返回完整内容。

## 12. 备份与快照

- 工具：工作区根 `tools/backup-source.py`。用法 `python tools/backup-source.py --out backups/<用途-日期> --purpose "<说明>"`，默认打 alpha / sekibanki / reimu 三棵树的源码。
- 排除依赖、构建产物（含 `web-ui/src-tauri/binaries` 的 sidecar exe）、运行数据（`pc-data` 等）、解包出来的内置 Bash；保留源码、字体与 `bash-bundle.tar.gz`。
- 产出 `<tree>-source.zip` + `manifest.json`（文件数、字节数、sha256、排除清单、上游基线 HEAD/tag）。打完做完整性校验。
- 时机：每个故事开工前、合入参照副本前、发版前。回滚 = 解包对应 zip 覆盖源码，**不动 `pc-data`**。
- 参照副本（cirno / sekibanki / reimu）同步前各自再快照；内核字节一致原则不变。

## 13. 上游对照与移植

- 上游参照克隆在 `reference/rikkahub-desktop-upstream`（只读快进，不在其上开发）。对照前先 `git fetch` 并记录 HEAD 与 tag。
- 流程：先审计（落工作区 `docs/audit-upstream-*.md`，逐项给文件级证据）→ 再按定位取舍 → 只定向移植不依赖 pi 的项，**不做主干合并**（两边同名文件内容已全面分叉）。
- 移植时连测试一起搬，尤其是计数守卫类测试；上游提交信息里的墙钟数字只作参考，验收用我们自己量的数。
- 上游 README / 发布说明的措辞不等于实现：以代码与测试为准（例：v6 宣称的"前端性能优化"实际全在后端）。
