# Windows / Linux / Docker 沙盒方案评估

核对日期：2026-11-24。本文为方案研究，不代表已实施这些机制或已完成逃逸测试。Linux 语义优先按与当前开发环境对应的 Linux 6.18 文档核对，避免把最新开发版 Landlock 功能当成现有 ABI 7 已提供的功能。

## 结论

方案方向合理，但三个平台应分别报告文件访问限制、资源限制和网络策略。Windows 的低完整性标签、Linux 的 Landlock、Docker 的只读挂载并不提供相同的承诺；Job Object 与 cgroup 才负责进程树资源限额。

| 形态 | 文件与权限 | 进程树资源 | 首期建议 |
| --- | --- | --- | --- |
| Windows | 现有 Low Integrity / MIC | Job Object 的提交内存、活动进程数，可选 CPU 限额 | 在现有生命周期 Job 上增加可靠限额与错误处理，保留后端和子进程的限制 |
| Linux 原生 | 单线程启动器在 exec 前安装 Landlock、seccomp、no_new_privs；普通用户运行 | cgroup v2 的 memory.max、pids.max、cpu.max；需要可用的委派权限 | 先明确内容写入限制与严格只读两种承诺，再决定是否加入 mount/user namespace |
| Docker | 挂载命名空间 + 只读根 + 显式 rw/ro 数据卷 + 非 root + cap_drop + no-new-privileges | 容器 cgroup 的内存、任务数与 CPU 限额 | 保留默认 seccomp，补齐资源限制与运行态核对 |

## Windows：可增强现有机制，但 Job Object 不是文件或网络沙盒

- MIC 默认的对象标签策略为 `SYSTEM_MANDATORY_LABEL_NO_WRITE_UP`；降低完整性不等于禁止读取用户文件，也不自动禁止网络访问。应继续描述为限制向更高完整性对象写入，不能称为敏感文件保密隔离。[MIC 官方说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)
- `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` 统计同时活动的**进程**。`JOB_OBJECT_LIMIT_JOB_MEMORY` 限制全 Job 提交内存之和，`PROCESS_MEMORY` 限制单进程提交内存；它们不是“驻留内存 RSS”上限。Working Set 是另一类限额，不能混为同一个配置。[基本限额](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)、[扩展限额](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)
- `KILL_ON_JOB_CLOSE` 负责生命周期回收；内存、进程数和 CPU 限额需要另行配置。CPU hard cap 按调度周期限制 Job 内线程可消耗的 CPU 时间，并非终止超时任务。[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[CPU rate control](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information)
- 通常 CreateProcess 创建的后代会加入 Job，但 `BREAKAWAY_OK` / `SILENT_BREAKAWAY_OK` 会改变行为。也不应把 Job 当成可以阻止一切通过系统服务创建进程的强安全边界。Windows 8 起支持嵌套 Job，子 Job 的限额可更严、不能放宽上层有效限额。[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)
- 安全启动顺序应是创建挂起的目标进程、绑定 Job 并检查返回值、最后恢复主线程。若先启动再 Assign，会留出子进程先运行/派生的窗口。`CREATE_SUSPENDED` 保证主线程在 `ResumeThread` 前不执行。[Process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)

当前代码核对：Tauri 的 `bind_to_kill_on_close_job` 已设置 `KILL_ON_JOB_CLOSE`，目前没有 Job 内存/进程数限额；绑定发生在 sidecar 启动之后。低完整性重启路径也需要验证后代是否仍在正确 Job 内。应先建立“整个应用后端进程树的资源上限”，每项工具独立 Job 是后续可选增强，避免一次工具 OOM 直接拖垮所有对话而没有明确说明。

## Linux：Landlock + seccomp 适合小启动器，有几处不能省略

### ABI 与“区外只读”的准确含义

Landlock 从 Linux 5.13 引入，但需要内核编译、LSM 配置和启动时启用。应通过 `landlock_create_ruleset(..., LANDLOCK_CREATE_RULESET_VERSION)` 实测 ABI，不能只看 `uname`。至少 ABI 3 才能控制 `truncate/ftruncate/O_TRUNC`；ABI 1/2 的截断不能被 Landlock 拒绝。[Linux 6.18 Landlock：内核支持与历史限制](https://docs.kernel.org/6.18/userspace-api/landlock.html#kernel-support)

即使在 ABI 7，Landlock 仍不能限制全部 `chmod/chown/setxattr/utime/fcntl` 等文件元数据操作。因此“只允许在白名单目录修改文件内容、创建、删除、重命名与截断”可以作为经过验证的承诺，“白名单外所有文件操作均为完整只读”则超出了 Landlock 单独提供的保证。seccomp 无法解引用路径字符串，也不能按“路径是否在白名单内”选择性放行这些元数据系统调用。[Linux 6.18 Landlock：Filesystem flags 警告](https://docs.kernel.org/6.18/userspace-api/landlock.html#filesystem-flags)、[Seccomp BPF：What it isn't](https://docs.kernel.org/userspace-api/seccomp_filter.html#what-it-isn-t)

如果产品要求严格的区外只读挂载语义，建议在独立 user/mount namespace 内建立只读根或只读绑定，再将批准的目录重新绑定为可写；可复用 bubblewrap 的 `--ro-bind` / `--bind` 和 namespace 机制，避免自行维护整套挂载隔离实现。仍需核实系统是否允许非特权 user namespace，且显式处理可写子挂载和 `/proc`、设备、共享 socket。Landlock 可作为这层隔离之外的附加约束。[bubblewrap 官方手册源码](https://github.com/containers/bubblewrap/blob/main/bwrap.xml)

### 启动与动态工作区

- Landlock 规则会由未来线程/子进程继承，但 ABI 7 对一个已有线程安装规则不会自动约束同进程其他兄弟线程。因此小启动器应保持单线程，在 Bun 启动、创建线程与加载不可信代码之前完成强制，再 exec 目标。不要依赖当前内核不存在的更新 TSYNC 能力。[Linux 6.18 Landlock：Inheritance](https://docs.kernel.org/6.18/userspace-api/landlock.html#inheritance)
- 多层 ruleset 只会收紧，不能给已被限制的后端新增可写目录。第一期可保持与当前 Windows 相同的“数据目录 + 所有声明工作区 + 额外可写目录”集合，并要求扩权重启；要运行时加入新目录而不重启，需要由受信 supervisor 创建新的受限工作进程，不能声称在原 Landlock 域里放宽。[Landlock：Layers of file path access rights](https://docs.kernel.org/6.18/userspace-api/landlock.html#layers-of-file-path-access-rights)
- 文件权限主要在 open 时检查。沙盒前打开的文件描述符不会被事后规则撤销；通过 IPC 传递的 FD 可携带既有权限。应关闭无关继承 FD，慎重保留 stdio/PTY，且不能把一个可代写文件的开放 socket 服务当成无害输入。[landlock(7)：Filesystem actions / File descriptor access rights](https://man7.org/linux/man-pages/man7/landlock.7.html)
- 不能只包装 `bash`：当前内置 write/edit、文件导入与 stdio MCP 也会访问文件。如果要延续现有系统级写入限制，应让整个后端及其后代进入受限域；如改成仅限制工具进程，必须先把内置文件操作移入同一受限执行单元。
- 普通用户执行，设置 `PR_SET_NO_NEW_PRIVS` 并去除剩余 capability；单独 `no_new_privs` 不会把已经是 root 的进程降为普通用户。当前开发 Debian 的 root 身份不适合作为普通用户发行版隔离效果的验证替代。

### seccomp 与资源限额

seccomp 降低内核系统调用攻击面，不提供文件路径策略、内存配额或进程数配额。过滤器可由子进程继承，应在执行 Bun 前设置，并覆盖实际支持的调用架构。首期可从经过测试的禁止危险内核管理、跨进程操控等调用开始；具体列表需以 Bun、Node/Python、PTY、Git、npm、MCP 的实际需求验证。不要直接禁用 `clone/fork/exec`，也不要无条件禁用 `mmap/mprotect(PROT_EXEC)`：这些会影响并发、子进程、Bun/JIT。[Seccomp BPF](https://docs.kernel.org/userspace-api/seccomp_filter.html)、[seccomp(2)](https://man7.org/linux/man-pages/man2/seccomp.2.html)

对进程树资源限额应增加 cgroup v2：`memory.max`、`pids.max`、可选 `cpu.max` / `memory.swap.max`。`pids.max` 的 PIDs 实际计数是内核 TIDs，**包括线程**，与 Windows Job 的 ActiveProcessLimit 不等价。普通用户必须有委派的 cgroup 权限；`RLIMIT_NPROC` 是按真实 UID 等规则计数，不能当作可靠的每工作区进程树限制，`RLIMIT_AS` 也会与 JS 引擎较大的虚拟地址空间预留冲突。[cgroup v2：CPU / Memory / PID 控制器](https://docs.kernel.org/admin-guide/cgroup-v2.html)

### 网络策略不应与文件限制混淆

ABI 4 的 Landlock 网络规则仅按 TCP 本地/远端**端口**约束 bind/connect，不是域名/IP 白名单；在 ABI 7 上不能因此承诺 UDP/DNS 已被隔离。ABI 6 可增加抽象 UNIX socket 与信号作用域；路径 UNIX socket 在更晚 ABI 才出现专门规则，不能把开发版文档中的功能当作 ABI 7 能力。首期可明确保留模型 API、代理和 MCP 网络通信，同时说明本模式不防止读取后经网络外传。应单独确定网络需求。[Linux 6.18 Landlock：Network flags / IPC scoping](https://docs.kernel.org/6.18/userspace-api/landlock.html)

实机只读探测结果（本轮父代理执行）：WSL Debian 内核为 `6.18.40.1-microsoft-standard-WSL2` x86_64，系统调用报告 Landlock ABI 7；seccomp 可用，cgroup v2 提供 cpu/memory/pids 控制器。这仅确认接口存在，未安装规则、未验证 `/mnt/d` 的 DrvFS 与 Linux ext4 的逐项限制效果，也未验证普通用户 cgroup 委派。

显式选择受限模式而缺少所需 ABI/LSM/权限时，应拒绝作为受限模式启动，或清楚报告哪些维度未生效；不应静默降级后继续显示“沙盒已生效”。是否另行提供可主动选择的普通运行模式，是产品决策。

## Docker：现有方向正确，补齐资源和观测

- 执行限制来自 Docker/Linux 的 namespace、挂载权限、LSM/seccomp、capability 与 UID；读取 `/proc/self/mounts` 只是观测。只读根并不覆盖额外的 rw bind mount；每个挂载需逐项配置并核对，最好读取带 mount ID/root 信息的 `mountinfo` 进行诊断。[Docker：安全模型](https://docs.docker.com/engine/security/)、[Bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)
- 当前非 root、`read_only: true`、`cap_drop: ALL`、`no-new-privileges`、显式数据卷和临时目录可保留。继续使用 Docker 默认 seccomp，主机支持时保留 AppArmor/SELinux，不要为方便改成 `privileged`、`seccomp=unconfined` 或挂载宿主 Docker socket。控制 Docker daemon 本身可以获得广泛的宿主权限。[Docker：seccomp 默认策略](https://docs.docker.com/engine/security/seccomp/)、[Docker daemon attack surface](https://docs.docker.com/engine/security/#docker-daemon-attack-surface)
- 容器默认没有资源上限，应补 `mem_limit` / `memswap_limit`、`pids_limit`、`cpus`，并从运行态确认 cgroup 实际生效，而不只看 Compose 文件。文件与资源隔离不自动限制外网或容器内其他工作区访问。[Docker：Resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)、[Compose services](https://docs.docker.com/reference/compose-file/services/)

Docker 官方文档网页在本次网络中部分被重置；相关事实同时通过其官方 [docker/docs 仓库](https://github.com/docker/docs) 的对应源文件核对。

## 建议实施顺序

1. 固定首期承诺：全局后端进程树、声明目录可写、网络是否开放，以及 Linux 是否要求严格只读元数据语义。
2. Windows 强化 Job 配置与创建顺序；Docker 配置资源限额；分别实测进程派生、OOM 与关闭回收。
3. Linux 原型在 exec 前安装 Landlock/seccomp，先用普通用户和 ext4 验证创建、覆盖、截断、删除、重命名、符号链接、硬链接、元数据、继承 FD、后代进程，再单独测 WSL `/mnt/d`。
4. 如果要求严格只读，加入 mount/user namespace，或直接采用 bubblewrap；若再要求每个工作区只能访问自己，将工具执行拆成受限 worker 是后续架构阶段。
5. 汇报分维度状态及失败原因。接口存在、规则安装成功、行为探针成功和资源限制生效是不同证据，不能折叠成一个未经验证的布尔值。
