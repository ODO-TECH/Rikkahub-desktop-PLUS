# Tauri 统一桌面壳（Windows + Linux）

> 2026-11-23 修订，基线 `rikkahub-alpha/` @ 0.2.0（源码树无 git）。
> 2026-11-20 初版写在 `rikkahub-desktop-plus/`，该树已归档为备份；结论不变，实施细节
> 按 Alpha 重构后的内核、构建脚本与发布链路重写。范围仍为 Windows + Linux 桌面，
> 保留 React 前端与 Bun 后端，不涉及安卓与 macOS。

## 修订说明（相对 11-20 初版）

- Alpha 用 `agent-kernel/` 替代 pi、用 `pc-server/kernel-engine/` 做桌面适配，**不改变
  壳的职责边界**；Tauri 壳仍随版本维护在 `web-ui/src-tauri/`，版本已是 0.2.0。
- 新增 S0（把 Tauri 构建链在 Alpha 上先打通）与 S1b（便携配置兼容），因为 Alpha 的
  发布物靠 `shell.ini` 与 `demo-shell/` 驱动，Tauri 目前两者都不认识。
- S3 按 `scripts/build-alpha.ps1` + `scripts/package-alpha.py` 重写，不再描述手工拼装。
- S5 的删除清单加入 ALPHA.md、打包脚本、Demo 入口；回滚从"revert 提交"改为 zip 快照，
  因为 Alpha 树没有 git。

## 1. 结论

- **弃用的是 C# WebView2 壳（`desktop-shell/`），不是 React 前端。** Tauri 不是 UI 框架，
  界面仍是网页技术；"换 Tauri"的实际含义是把窗口层从 WinForms + WebView2 换成
  Tauri + Rust，React 界面和 Bun 后端原样复用。
- Tauri+Rust 壳**不是从零重启**：托盘、单实例、窗口记忆、Job Object、sidecar、splash、
  安装器数据目录 handoff、`launch_installer` 均已在 `web-ui/src-tauri` 实现，并有
  `rust-check.yml` 的 `cargo check` 门禁。本次是扶正为唯一桌面壳 + 补齐行为差 +
  接入 Alpha 的构建与打包链路。
- 目标形态：Windows 正式发布 NSIS 安装包（恢复应用内自动更新）+ 便携 zip；Alpha 测试包
  继续按现有 zip/7z + Demo.cmd 形态出；Linux 出 Tauri AppImage（实验性，保留 tar.gz）；
  前端删除 WebView2 双壳分支。
- Alpha 的用户验收面必须在 Tauri 壳下等价保留：双击 `RikkaHub.exe` 用 `alpha-data/`
  真实模式、双击 `Demo.cmd` 用 `demo-data/` 本地模拟模型、`Demo-browser.cmd` 浏览器兜底、
  演示调试端口 17556 与 CDP 17567 不变。

## 2. 非目标

- 不重写前端为 Rust 原生 UI（那需要 Dioxus/Slint 之类，等于整套界面重做，与 Tauri 无关）。
- 不把 pc-server / agent-kernel 重写为 Rust；不移植到安卓（Bun 无法在安卓运行）。
- 不做 macOS（无设备构建与签名）。
- 不移植 C# 壳的"附着到任意已运行后端"（单实例插件 + 数据目录锁已覆盖正常路径）。
- 不改演示内容、数据格式、更新通道与供应商协议；不新增产品功能。
- 不重写历史计划文档；`RDP升级.md` 不读不改。

## 3. 现状与差集（以 `rikkahub-alpha` 代码为准）

| 能力 | C# 壳（现 Alpha 发布物） | Tauri 壳（`web-ui/src-tauri`） | 本轮动作 |
|---|---|---|---|
| 拉起/优雅停后端、Job 防孤儿 | 有 | 有 | 不动 |
| 启动屏 / 托盘 / 单实例 / 窗口记忆 | 有 | 有（含 DPI 托盘图标、系统语言菜单） | 验证 |
| 自定义数据目录 / 安装器 handoff | `shell.ini` 的 `dataDir` | `user-config.json` + NSIS handoff + 便携默认 `pc-data` | S1b 兼容 |
| 便携配置（端口 / 托盘默认 / 后端路径） | `shell.ini`：`port`、`minimizeToTray=0`、`serverPath` | 不读 `shell.ini`；托盘默认开；端口自动分配 | S1b / S3 |
| 更新包下载后拉起安装器 | 无（便携版不走此路） | 有（`launch_installer`） | S3 打通资产 |
| **受限沙盒"准备进程提前退出"** | **有：退出后 30 秒轮询 `/api/health`** | **无：stdout 结束即判启动失败** | **S1 补齐（必做）** |
| `rikkahub://restart` / `__RIKKAHUB_SHELL__` | 有 | 无（前端已有 Tauri 分支） | S2 删旧分支 |
| 发布构建 | `build-alpha.ps1` 出 `dist/rikkahub-pc.exe` + `desktop-shell/dist/RikkaHub.exe`；`package-alpha.py` 拼 zip/7z | `binaries/` 为空，脚本不喂 sidecar，当前直接 `tauri build` 不可用 | S0 / S3 |
| sidecar 命名 | `rikkahub-pc.exe`（`deploy-portable.ts`、打包脚本、文档都用它） | `externalBin: binaries/rikkahub-server` | 统一为 `rikkahub-pc`（S1/S3） |
| Demo 模式 | `demo-shell/RikkaHub.exe` + 独立 `shell.ini` + 环境变量 | 无对应物 | S3 改为单 exe + 环境变量 |
| WebView2 用户数据目录/配额 | 程序目录 `webview2-data`、80 MB | 默认 `%LOCALAPPDATA%` | 低优先，见 S1 可选 |
| Linux 原生窗口 | 无（tar.gz 浏览器形态） | 有（WebKitGTK） | S4 出包 |

沙盒差集的根因不变：`pc-server/workspace/low-integrity.ts` 用 `CreateProcessAsUserW`
拉起低完整性后端时 `bInheritHandles=false`，端口标记不会回到壳的 stdout；C# 壳在
`desktop-shell/Program.cs` 的 Exited 分支里轮询 `ui-origin.json` 与候选端口，校验
`/api/health` 后 attach。Tauri 的 `wait_for_sidecar_startup` 目前把这种退出当失败。

构建链断点（S0 的由来）：`pc-server/package.json` 的 `compile` 会把 exe 复制成
`web-ui/src-tauri/binaries/rikkahub-server-x86_64-pc-windows-msvc.exe`，但 Alpha 的
`scripts/build-alpha.ps1` 绕过了 `compile` 自己拼命令，没做这一步，`binaries/` 为空；
同时 `externalBin` 名字与发布物 `rikkahub-pc.exe` 不一致，`tauri.conf.json` 也没有设置
RikkaHub.exe 的主程序名。

## 4. 实施

### S0 Tauri 构建链在 Alpha 上先打通（不改行为）

- 用现有 `bun run compile`（或给 `build-alpha.ps1` 补同样的 sidecar 复制）填
  `web-ui/src-tauri/binaries/`；先把 sidecar 名保持现状跑通一次 `cargo check` 与
  `tauri-msvc.cmd build --bundles nsis`，确认 Alpha 的 `server.ts`/`kernel-engine`
  能被壳拉起。
- 产物只做本地验证，不发布、不替换 C# 壳；记录冷启动与崩溃日志基线。
- 验收：NSIS 或 `tauri dev` 能打开 Alpha 界面，发一条 Mock 消息。

### S1 Tauri 壳行为对齐（Rust）

- 沙盒：`wait_for_sidecar_startup`（`web-ui/src-tauri/src/lib.rs`）在 stdout 结束、
  子进程已退出但从未收到 `RIKKAHUB_PORT:` 时，进入最多 30 秒等待：
  1. 读 `<dataDir>/ui-origin.json` 的 origin；
  2. 对记录端口 + 首选端口起的候选段做 connect 预算筛 + `/api/health` 校验；
  3. 命中即按启动成功导航；超时才报"后端进程提前退出（含受限沙盒自重启的 30 秒等待）"。
  `RIKKAHUB_FATAL:` 仍是最高优先级。
- sidecar 命名统一：`tauri.conf.json` 的 `externalBin` 改为 `binaries/rikkahub-pc`，
  `lib.rs` 的 `.sidecar("rikkahub-pc")` 同步；`compile` 的复制目标同步改名。保持发布物
  与 `deploy-portable.ts`、文档里的 `rikkahub-pc.exe` 不变。
- 主程序名：`mainBinaryName` 设为 `RikkaHub`（或以打包脚本重命名兜底），保证用户双击的
  仍是 `RikkaHub.exe`。
- 可选：确认 Tauri/WebView2 是否支持固定用户数据目录；支持则钉到
  `<便携根>/webview2-data`，不支持则接受默认并文档记录。

### S1b 便携配置兼容（`shell.ini`）

- Tauri 启动时若 exe 同级存在 `shell.ini`（便携/绿色模式），读取 `dataDir` 与
  `minimizeToTray`；`serverPath` 与 `port` 不支持（sidecar 名称固定、端口走自动分配），
  读取到不同值时写日志说明，不静默行为漂移。
- 优先级：`RIKKAHUB_PC_DATA_DIR` 环境变量（Demo/测试） > `shell.ini` > `user-config.json`
  > 默认 `pc-data`。便携模式下 `set_data_dir` / `set_minimize_to_tray` 写回 `shell.ini`，
  避免 AppData 的全局配置串到多份便携副本；安装版（无 `shell.ini`）仍写 user-config。
- 验收：`shell.ini` 指向 `alpha-data` 时双击 `RikkaHub.exe` 落在该目录；`minimizeToTray=0`
  时关窗直接退出；改设置后重启仍生效，且不污染另一份便携目录。

### S2 前端去双壳分支

- `web-ui/app/lib/system-info.ts`：删除 `__RIKKAHUB_SHELL__` 判断，`isDesktopShell()`
  只认 Tauri。
- `web-ui/app/components/settings/data/web-service.tsx`：删除 `rikkahub://restart` 分支，
  端口保存后统一 `process.relaunch()`。
- 其余 `isDesktopShell` 使用点（外链、文件导出、登录面板）收敛到 Tauri 路径；浏览器开发
  模式仍返回 false，行为不变。
- 验收：`bun run typecheck`、`bun test app`、`bun run build`；浏览器 17455/5173 冒烟；
  Tauri 窗口内改端口重启、外链、导出文件各走一遍。

### S3 Alpha 构建与打包切换

- `scripts/build-alpha.ps1`：改为调用 `bun run compile`（或补齐同样的 sidecar 复制），
  新增 `tauri build` 步骤/新脚本 `build-tauri.ps1`；一次产出 `dist/rikkahub-pc.exe`、
  `desktop-shell/dist/RikkaHub.exe`（过渡期）与 Tauri 壳。
- `scripts/package-alpha.py`：便携 stage 的壳换成 Tauri 产物，布局保持：
  `RikkaHub.exe` + `rikkahub-pc.exe` + `web-ui/` + `icons/` + `fonts/` + `koffi`（若存在）
  + `shell.ini` + 许可文件；资源清单必须与 `tauri.conf.json` 的 `resources` 一致，
  避免 NSIS 与便携包行为分叉。
- Demo：去掉 `demo-shell/` 子目录（S1b + Tauri 支持环境变量后），`Demo.cmd` 直接启动
  `RikkaHub.exe` 并设置 `RIKKAHUB_ALPHA_DEMO=1`、`RIKKAHUB_PC_DATA_DIR=%~dp0demo-data`、
  `PORT=17555`、`RIKKAHUB_ALPHA_DEBUG_PORT=17556`、`RIKKAHUB_ALPHA_CDP_PORT=17567`、
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`；`Demo-browser.cmd` 不变。
  验收：演示脚本 `scripts/alpha-smoke.py`、`scripts/alpha-ui-qa.py` 仍按 17555/17556 可用。
- 版本：`alpha-manifest.json` 纳入 `version:bump` 与 `check-version-sync.ts`，避免打包名
  与 `APP_VERSION` 漂移（当前两者都是 0.2.0，靠手改）。
- 正式发布再加 `*-setup.exe`（NSIS，WebView2 embedBootstrapper），验证下载 →
  `launch_installer` → 壳退出的假安装包链路；Alpha 测试包继续只看 zip/7z。
- 安装器数据目录 handoff 实测一次；冷启动用 CDP 或壳日志测，目标不劣于现状（约 1.9 s，
  以 Alpha 实测为准），劣化先给耗时分解，不带病发版。

### S4 Linux Tauri 包

- CI 新增 Linux Tauri 构建（AppImage，必要时加 deb）：WebKitGTK 4.1 与
  ayatana-appindicator 构建依赖，`bun run build`、`bun run compile:linux`、
  `tauri build --bundles appimage`。Alpha 已移除 pi 克隆步骤，沿用 `build-linux.yml`
  现在的 vendor 方式即可。
- 产物附加到 Release，命名独立，**不进自动更新**；现有 tar.gz 保留作为浏览器/自托管回退。
- 无 Linux 实机：只承诺 CI 构建通过 + 下载可运行性待社区验证，不声称"已验证"。

### S5 退役 C# 壳

- 顺序：S0–S3 完成、Tauri 便携包按 Alpha 验收面（真实/演示/浏览器）跑通后，再删除。
- 删除清单：`desktop-shell/`（源码与 `sdk/`、`dist/`）、`scripts/build-alpha.ps1` 中的
  C# 构建段、`scripts/package-alpha.py` 的 C# 复制与 `demo-shell` 段；`.gitignore` 条目。
- 文档：`docs/BUILD.md`（工具链、§3 sidecar 命名、§4 整节）、`README.md`（双壳段落、
  平台表、构建步骤）、`ALPHA.md`（WinForms 描述与构建说明）、`docs/PUBLISH.md`、
  `docs/DEBUG_REFERENCE.md`、生成的 `README.txt`。
- `deploy-portable.ts` 的 `RikkaHub.exe` / `rikkahub-pc.exe` 假设保持不变，S1 的命名统一
  已保证兼容；删除后跑一次部署冒烟。
- 删除前先列清单征得同意；`alpha-evidence/` 的历史报告不改写。

## 5. 风险与对策

- **`shell.ini` 优先级错乱**：多份便携副本共用 AppData 的 user-config 会串设置；
  S1b 的"便携写回 ini、安装版写 user-config"是硬约束，配单测与两份目录实测。
- **Demo 验收回归**：Demo.cmd 是 Alpha 的主入口；`PORT` 环境变量继承给 sidecar、
  `RIKKAHUB_ALPHA_DEMO` 传递、CDP 端口都要实机验证。演示环境不通过不算完成。
- **sidecar 命名漂移**：Tauri `externalBin`、`compile` 复制、`lib.rs`、打包脚本、部署脚本
  五处必须同名；用 `check-version-sync` 同级的一次性检查或打包失败兜底。
- **资源清单分叉**：NSIS 的 `resources` 与便携 stage 必须同源；漏 `web-ui` 会白屏、
  漏 `koffi` 会让油库里 TTS 静默失效。
- **WebView2 运行时缺失**：NSIS 已配 embedBootstrapper；便携版首次启动需可读提示。
- **更新通道**：旧便携版不会自动升级，Release 说明手动迁移；新 NSIS 用户从下一版起
  恢复应用内更新；`UPDATE_REPO` 不变。
- **无 git 回滚**：删除与脚本改动前先把 `rikkahub-alpha` 快照到
  `backups/tauri-unified-shell-<日期>.zip`；保留上一版 Alpha 发布包。
- **Linux 不可本机验证**：AppImage 依赖系统 WebKitGTK/托盘库，标记实验性，不阻塞主线。
- **冷启动回退**：Tauri 壳若显著慢于 C# 壳，先定位再取舍。

## 6. 验证清单

```powershell
cd agent-kernel; bun test; bun run typecheck
cd ../pc-server; bun run typecheck; bun test; bun run scripts/check-version-sync.ts
cd ../web-ui; bun run typecheck; bun test app; bun run build
cd src-tauri; cargo check --locked
cd ../..; powershell -ExecutionPolicy Bypass -File scripts/build-alpha.ps1
python scripts/package-alpha.py --stage-only
```

- 实机：`RikkaHub.exe` 真实模式落 `alpha-data`；`Demo.cmd` 落 `demo-data` 且无需密钥；
  `Demo-browser.cmd` 可用；`alpha-smoke.py` / `alpha-ui-qa.py` 通过。
- 壳行为：双实例聚焦、托盘最小化与直退、关闭无孤儿后端、`minimizeToTray=0` 生效、
  沙盒开/关冷启动、假安装包拉起、外链与导出。
- 发布物：便携 zip/7z stage 解压即用；NSIS 安装/卸载/数据目录 handoff；升级到
  `*-setup.exe` 的更新流程（假包）。
- Linux：CI 工作流绿 + 产物可下载（实机待验证）。

## 7. 工作量与顺序

S0 0.5 天 → S1 0.5–1 天 → S1b 0.5–1 天 → S2 0.5 天 → S3 1–1.5 天 → S4 1 天 →
S5 0.5 天，加 Windows 实机验收。合计约 4–5 个工作日。S1b 与 S3 可并行验证，S5 必须最后。

## 8. 回滚

- 改动前：`backups/tauri-unified-shell-<日期>.zip` 全量快照（Alpha 无 git）。
- 删除 C# 壳前：两套壳共存，打包脚本可切回 C# 产物。
- 删除后：上一版 Alpha 发布包（C# 壳）继续可下载；恢复删除文件从快照解压，
  S1–S4 均为增量，不影响后端与数据格式。
