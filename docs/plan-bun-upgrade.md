# Bun 1.4.2 → 1.4.5 升级计划

> 2026-11-28 执行状态：已按用户要求在 S3/S5/S6 之后执行，精确升级目标为 1.4.5。通过国内镜像取得并核验隔离运行时，已更新主线 CI/Docker/类型锁与代理处理；Windows、Debian 测试、Windows 便携/Linux 压缩包与 Docker amd64 构建实跑均通过。全局 Bun 仍为 1.4.2。完整结果与限制见工作区 `docs/audit-bun-1.4.5-2026-11-28.md`；完整 UI 冷启动与远端 CI 尚未实测，未发版、未覆盖 0.2.1 发布包，未独立确认 npm latest。
> 目标仓库：`rikkahub-alpha`（主线），基于 0.2.1。其他预览树本次未同步。
> 参照：上游 `rikkahub-desktop` 提交 `a606017`（chore(runtime): Bun 1.4.2 → 1.4.5，2026-11-26），它已在 v2.0.0-preview-v6 全量验证过。
> 开工前快照：`backups/agent-lite-plan-20261127/`（三棵树源码 zip；本故事开工前再拍一次）。
> 下文保留原方案和原始验收目标，执行结果以上方审计记录为准；其中上游数据未经本轮独立复核。

## 0. 给执行者的 TL;DR

把运行时、CI、Docker builder、`@types/bun`、锁文件与脚本校验从 1.4.2 统一升到 **1.4.5**（本次精确目标版本；不把原报告的 npm latest 判断作为验收事实）。**不改其他依赖、不动 `--splitting`、不清理 `spawn-warm` 垫刀**。本次同时验证运行时兼容性和分叉代码，重点覆盖三块：**代理 env 语义**、**油库里 koffi 原生件**、**Windows 冷启动/首次 spawn 行为**——这三块按 §4 的 B3/B4 单独验收。

## 1. 为什么升

- 1.4.3 起 `fetch` 代理语义修复：不带 `proxy` 选项时按**当前**环境变量选代理，运行时删除即时生效；新增 `ALL_PROXY` 兜底。我们 `net.ts` 的拦截器设计正是围绕 1.4.2 的"启动快照锁"做的补偿，继续钉 1.4.2 等于长期维护一段为旧 bug 写的注释与断言。
- 1.4.5 与上游同版本，后续从上游定向移植补丁（S1 会话对账等）时少一层版本差异。
- 上游实测（其仓库与 CI，非我们的结论）：两端 typecheck 0 错、pc-server 1888 过 / web-ui 534 过、七个冒烟全绿、Linux 容器全量 1865 过、Windows exe 118.2→147.5 MB（运行时本身 86.1→115.4 MB）。**这些数字只作参考，验收用我们自己的基线。**

## 2. 升级前状态与落点清单（执行结果见审计）

| # | 文件 | 现状 | 改为 |
| --- | --- | --- | --- |
| 1 | `.github/workflows/ci.yml:19,63` | `bun-version: '1.4.2'`（两个 job） | `'1.4.5'` |
| 2 | `.github/workflows/build-linux.yml:29` | `'1.4.2'` | `'1.4.5'` |
| 3 | `Dockerfile:6` | `FROM … oven/bun:1.4.2 AS builder` | `oven/bun:1.4.5` |
| 4 | `pc-server/package.json:22` | `"@types/bun": "^1.4.2"` | `"^1.4.5"`（dev 依赖，`bun install` 后锁文件随之更新） |
| 5 | `agent-kernel/package.json:8,9` | `"@types/bun": "1.4.2"`、`engines.bun: ">=1.4.2"` | `"1.4.5"`、`">=1.4.5"` |
| 6 | `agent-kernel/README.md:11` | "需要 Bun 1.4.2 或更新" | 1.4.5 |
| 7 | `scripts/build-linux.sh:10` | 硬校验 `!= 1.4.2` 即退出 | 见 §7.2（默认精确 `1.4.5`） |
| 8 | `README.md:14,185` | badge `Bun 1.4.2`、前置要求 1.4.2 | 1.4.5 |
| 9 | `docs/BUILD.md:14,127` | 版本表与 Linux 构建说明钉 1.4.2 | 1.4.5 |
| 10 | `ALPHA.md:55` | "Windows 推荐 Bun 1.4.2" | 1.4.5 |

需要**重新实测后改写**、不能只换版本号的注释（B3/B4 产出）：

- `docs/BUILD.md:185`（"Bun 1.4.2 / Windows：进程内第一次 `Bun.spawn` 同步阻塞"）与 `pc-server/foundation/spawn-warm.ts:3` 的同款注释。
- `pc-server/foundation/net.ts:346-353`（"fetch 在进程首次网络请求时快照 `*_PROXY` 并永久锁定（实测 1.3.13；1.4.0 复核）"）与 `pc-server/bootstrap.ts:50-51`（"必须在首次出站 fetch 之前安装，否则触发 env 快照锁定"）。
- `pc-server/scripts/prepare-linux-build.ts:4`（"Bun 1.4.2 on Linux cannot load ssh2 N-API accelerators"）。
- 多处测试注释引用的"bun 1.4.2 的 `mock.module` 是进程级注册表"（`files/extraction-ocr-escalation.test.ts`、`media/asr-deepseek.test.ts`、`media/ocr.test.ts`、`search/deepseek.test.ts` 等）——4.5 上重跑后按事实保留或改写。
- `docs/plan-*.md` 里 1.4.2 的"技术栈"字样属历史记录，不改。

锁文件：两端 `bun.lock` 在 1.4.5 下跑 `bun install --frozen-lockfile`；预期变化仅 `@types/bun` / `bun-types` 的版本行（上游同款），若出现其他条目变化单独报告。

## 3. 语义变化与我们的受影响面

### 3.1 fetch 代理（本计划的核心风险）

1.4.3+ 的事实：不带 `proxy` 选项的 fetch 按**当前** env 决策，运行时写/删即时生效；`ALL_PROXY` 成为兜底。

我们的现状（`net.ts` + `bootstrap.ts`）：启动时清空 `HTTPS_PROXY/HTTP_PROXY/NO_PROXY`（大小写两组），替换 `globalThis.fetch`，非 env 模式按请求显式传 `proxy`；**`direct` 模式不传 `proxy`，靠"env 已被清空"保证直连**。在 1.4.5 下这条会被 `ALL_PROXY` 击穿——用户带着 `ALL_PROXY=socks5://…` 启动时，"强制直连"会被送进代理。

必须一起做的三件事：

- 启动清理补 `ALL_PROXY` / `all_proxy`（拦截器与壳的注入环境都查一遍）。
- `net.ts` 注释按新事实改写：不再是"快照锁"，而是"我们主动清 env + per-request 显式 proxy 是唯一决策源"；`bootstrap.ts` 的"必须在首次 fetch 前"理由同步改写（安装时机仍需早，但理由变了）。
- `scripts/proxy-behavior-smoke.ts` 的 §A 断言改写：旧断言锁的是 1.4.2 行为（"快照仍在"），1.4.5 下必然红；新断言按上游 §A 的口径——装壳删继承变量、删掉的不再起作用、运行时写/删即时生效、`ALL_PROXY` 兜底被清。**在 1.4.2 上跑新 §A 应当红，这正好是升版的对照信号。**

### 3.2 `@types/bun` 类型变化

1.4.5 的 `Subprocess.signalCode` 可为数字（无名字的信号），上游把宿主退出信息转成字符串。我们没有引擎宿主，但 `tools/platform.ts`、`mcp-stdio.ts`、`backup/zip.ts` 等有 spawn，`bun run typecheck` 会暴露。

### 3.3 首次 spawn 的同步阻塞（冷启动）

`spawn-warm.ts` 的垫刀基于 1.4.2 实测（进程内第一次子进程调用同步阻塞约 3.3s，Bun/Windows 层面）。1.4.5 必须重新计时：**先保留垫刀**，量完冷启动再决定是否简化；本计划不以"删除 workaround"为目标，避免混入不相关变更。

### 3.4 Linux ssh2 可选 N-API 加速器

`prepare-linux-build.ts` 因 1.4.2 无法加载这些可选加速器而排除它们。1.4.5 下重验：仍失败就保留现状；可加载也不急着放开（不属于本次目标）。

### 3.5 油库里 koffi（我们独有，上游无覆盖）

便携包按 `target/koffi/build/win32_x64/koffi.node` 布局注入原生件（`deploy-portable.ts:168-175`，`media/yukkuri/native-shim.ts`）。升级后必须在**真实便携包**里跑一次 TTS：列出音色、合成一小段 AQTK 语音，确认 koffi 在 1.4.5 的内嵌运行时下可加载。失败则本计划挂起上报，不带病发版。

### 3.6 `--compile` 体积

上游 exe +29 MB（zip 也会涨）。我们当前便携 zip 约 89.8 MB，阈值见 §7.3；若超阈值，与工作区 `docs/plan-portable-size.md` 合并讨论，不在本计划里临时改编译策略。

### 3.7 其他运行时行为

- `fetch-idle-timeout-smoke.ts`（拦截器注入 `timeout: 0` 关 Bun 300s 空闲定时器）必须重跑——思考型模型长静默依赖它。
- `bun:sqlite`（FTS5 trigram、备份、记忆）与 Worker（`spawn-warm`、代理探测）在 1.4.5 下跑全量测试确认。
- Tauri 壳的 Job 对象/子进程管理与 Bun 版本无关，但便携包冒烟一并覆盖。

## 4. 步骤

**B1 版本落点（半天）**：按 §2 改表内 10 处 + `bun install` 更新两端锁文件；本机用 1.4.5 跑通 `bun run typecheck`。产出：版本变更文件清单 + 锁文件 diff。
**B2 基线对照（半天）**：先在 1.4.2 上记录：pc-server 全量测试通过/跳过/失败数、web-ui 单测数、核心冒烟结果、Windows 编译 exe 字节数、便携冷启动秒数（三次取中）。再在 1.4.5 上重跑同一套，产出对照表。已知 Windows flake（Temp EPERM、e2e EBUSY）按 dev-workflow §6 口径剔除。
**B3 代理语义对齐（1 天）**：§3.1 的三件事；`proxy-behavior-smoke` 新旧断言对照（1.4.2 红、1.4.5 绿）；`request-chain` 与真实 mock 供应商链路复跑。
**B4 打包与实机验收（1 天）**：Windows `bun run compile` → `deploy:portable` → 便携包冒烟（见 §5）；Linux 在 Debian 副本用 1.4.5 跑 `build-linux.sh` → tar.gz 实跑；Docker 用 `oven/bun:1.4.5` 重建镜像 → 容器内健康检查；CI 两个 workflow 跑绿。
**B5 文档与发布（半天）**：§2 表内文档 + §3 注释改写；发布说明一行（"运行时 Bun 升级到 1.4.5；代理环境变量处理对齐新版语义"）；同步 sekibanki / reimu（先各自快照）。

## 5. 验收矩阵

| 项 | 方法 | 通过标准 |
| --- | --- | --- |
| 类型 | `pc-server: bun run typecheck`；`web-ui: bun run typecheck` | 0 错误 |
| 后端测试 | `pc-server: bun test` | 以 B2 的 1.4.2 基线为准：不允许新增失败（已知 flake 除外） |
| 前端测试 | `web-ui: bun run test:unit` | 全绿 |
| 代理 | `smoke:proxy-behavior`（新 §A）+ `smoke:request-chain` | 新版断言在 1.4.5 全绿；同一脚本在 1.4.2 上 §A 红（对照证据） |
| 其余冒烟 | `smoke:backup-roundtrip`、`smoke:embedded-bash`、`smoke:task-lifecycle`、`smoke:upgrade`、`fetch-idle-timeout-smoke`、`kelivo-sync-smoke`、`memory-sql-migration-smoke` | 全绿 |
| Windows 便携 | `compile` + `deploy:portable`；`/api/health`、MCP stdio 起子进程、备份导出/导入往返、油库里 TTS 合成、冷启动三次取中 | 全部可用；冷启动不劣化超过 §7.3 阈值 |
| Linux | Debian 副本 `build-linux.sh`；tar.gz 解压实跑 `/api/health` | 通过 |
| Docker | `oven/bun:1.4.5` 构建；容器带密码启动、健康检查 | 通过 |
| CI | ci.yml 两个 job + build-linux.yml | 绿 |
| 体积 | exe 字节数、便携 zip、Docker 镜像层大小 | 记录并与阈值比对（§7.3） |

## 6. 回滚

- 代码面：版本字符串与注释改写，按 B1 清单反向还原即可；无数据迁移、无 schema 变化。
- 运行时面：本机与 CI 重装 1.4.2（`npm i -g bun@1.4.2` 或官方安装脚本指定版本）；Docker 镜像 tag 回 `oven/bun:1.4.2`。
- 发版面：B4 未过不进入 B5，不产生发布物。

## 7. 待拍板（括号内为默认值）

1. 目标版本：**1.4.5**（本次精确目标；未独立确认 latest；canary 不用）。
2. `scripts/build-linux.sh` 校验口径：**精确 1.4.5**（与 CI/Docker 一致）；备选 `>=1.4.5 <1.5`。
3. 体积与冷启动阈值：便携 zip **≤ 120 MB**、冷启动劣化 **≤ 20%**（基线 1.9s）；超阈值停车上报，不擅自改编译策略。
4. 随哪个版本发：**随下一版（0.2.2 或下一发布）**，不单独发运行时升级版。
5. Docker 基础镜像：**`oven/bun:1.4.5`**（与上游一致）。
6. 与 S1–S5 的关系：本次按用户指示在 S3/S5/S6 后执行 Bun；原“并行”安排不适用。发版前仍需完成正式验收。

## 8. 明确不做

- 不升 canary / beta；不顺手升级其他依赖。
- 不动 `--splitting`（在 plan-agent-lite §4 S8 单独评估）。
- 不以删除 `spawn-warm` 垫刀为目标；实测后另案决定。
- 不为适配 1.4.5 改写业务语义；代理语义对齐只改 env 清理、注释与冒烟断言。
