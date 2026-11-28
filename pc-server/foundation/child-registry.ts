// 子进程登记：仅保存可执行文件名，不保存参数/env（可能包含密钥）。
// 磁盘登记在拿到数据目录锁后启用；硬杀后的旧记录只报告，绝不据此杀 PID。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { dataDir } from "./paths";

export interface TrackedChild {
  pid: number;
  purpose: string;
  command: string;
  startedAt: number;
  parentPid: number;
}

interface LiveChild {
  entry: TrackedChild;
  exited: Promise<unknown>;
  kill(signal: NodeJS.Signals): void;
  processGroup: boolean;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function validEntry(value: unknown): value is TrackedChild {
  if (!value || typeof value !== "object") return false;
  const v = value as TrackedChild;
  return Number.isSafeInteger(v.pid) && v.pid > 0 && Number.isSafeInteger(v.parentPid)
    && v.parentPid > 0 && typeof v.purpose === "string" && typeof v.command === "string"
    && Number.isFinite(v.startedAt) && v.startedAt > 0;
}

export function createChildRegistry(filePath: string) {
  const live = new Map<number, LiveChild>();
  let previous: TrackedChild[] = [];
  let initialized = false;
  let stopping = false;
  let shutdown: Promise<void> | undefined;

  function persist(): void {
    if (!initialized) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify([...previous, ...Array.from(live.values(), c => c.entry)]));
      renameSync(tmp, filePath);
    } catch (err) {
      console.warn("[children] 子进程登记写入失败", err);
    }
  }

  function track(child: Omit<LiveChild, "entry">, pid: number, command: string, purpose: string): void {
    const tracked: LiveChild = { ...child, entry: {
      pid, purpose, command: basename(command.replace(/\\/g, "/")), startedAt: Date.now(), parentPid: process.pid,
    } };
    live.set(pid, tracked);
    persist();
    const retire = () => {
      if (live.get(pid) === tracked) { live.delete(pid); persist(); }
    };
    void child.exited.then(retire, retire);
  }

  function assertOpen(): void {
    if (stopping) throw new Error("子进程登记已关闭，应用正在退出");
  }

  function spawnTracked<
    const In extends Bun.SpawnOptions.Writable = "ignore",
    const Out extends Bun.SpawnOptions.Readable = "pipe",
    const Err extends Bun.SpawnOptions.Readable = "inherit",
  >(command: string[], opts: Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { purpose: string }) {
    assertOpen();
    const { purpose, ...options } = opts;
    const child = Bun.spawn(command, options);
    track({ exited: child.exited, kill: signal => { child.kill(signal); }, processGroup: options.detached === true },
      child.pid, command[0]!, purpose);
    return child;
  }

  // Node 的工作区 bash 保持原有 spawn/stdio/进程组语义，仅补登记。
  function trackNodeChild(child: ChildProcess, command: string, purpose: string, processGroup = false): void {
    if (!child.pid) return; // ENOENT 由调用方处理，不登记无效 PID。
    const exited = new Promise<void>(resolve => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
      if (child.exitCode !== null || child.signalCode !== null) resolve();
    });
    track({ exited, kill: signal => { child.kill(signal); }, processGroup }, child.pid, command, purpose);
  }

  function sweepStaleOnStartup(): { stale: TrackedChild[] } {
    if (initialized) return { stale: [] };
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (!Array.isArray(parsed) || !parsed.every(validEntry)) throw new Error("invalid children registry");
      previous = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[children] 子进程登记损坏或不可读，按空处理", err);
    }
    const stale = previous.filter(c => !alive(c.pid) || !alive(c.parentPid));
    // 活着的旧记录跨启动保留，直到它自己退出；不能用它们参与本次关停。
    previous = previous.filter(c => alive(c.pid));
    initialized = true;
    persist();
    return { stale };
  }

  async function signalChild(child: LiveChild, force: boolean): Promise<void> {
    try {
      if (process.platform === "win32") {
        // 先整树终止，再 /F 强杀；不能先 kill 根 PID，否则 taskkill 找不到其后代。
        // 清理器不登记，避免递归登记/关停期间自锁。
        const killer = Bun.spawn(["taskkill", "/PID", String(child.entry.pid), "/T", ...(force ? ["/F"] : [])],
          { stdout: "ignore", stderr: "ignore", windowsHide: true, timeout: 2000 });
        const code = await killer.exited;
        if (code !== 0 && force) child.kill("SIGKILL");
      } else if (child.processGroup) {
        process.kill(-child.entry.pid, force ? "SIGKILL" : "SIGTERM");
      } else {
        child.kill(force ? "SIGKILL" : "SIGTERM");
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") console.warn("[children] 终止子进程失败", child.entry.pid, err);
    }
  }

  function killTrackedOnShutdown(timeoutMs = 5000): Promise<void> {
    if (shutdown) return shutdown;
    stopping = true;
    shutdown = (async () => {
      const children = [...live.values()];
      await Promise.all(children.map(c => signalChild(c, false)));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(children.map(c => c.exited.catch(() => undefined))),
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
      clearTimeout(timer);
      // 组长先退出时后代仍可能忽略 TERM；独立进程组也必须进入最终强杀阶段。
      await Promise.all(children.filter(c => c.processGroup || live.get(c.entry.pid) === c).map(c => signalChild(c, true)));
      await Promise.race([
        Promise.all(children.map(c => c.exited.catch(() => undefined))),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }),
      ]);
      clearTimeout(timer);
      // 不等一个无法终止的进程无限久；保留未退出记录，供下次启动诊断。
      persist();
    })();
    return shutdown;
  }

  return { spawnTracked, trackNodeChild, assertOpen, sweepStaleOnStartup, killTrackedOnShutdown,
    listTracked: (): TrackedChild[] => Array.from(live.values(), c => ({ ...c.entry })) };
}

const registry = createChildRegistry(join(dataDir, "runtime", "children.json"));
export const { spawnTracked, trackNodeChild, sweepStaleOnStartup, killTrackedOnShutdown, listTracked,
  assertOpen: assertChildSpawningAllowed } = registry;
