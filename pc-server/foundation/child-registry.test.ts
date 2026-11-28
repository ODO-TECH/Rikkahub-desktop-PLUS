import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createChildRegistry, type TrackedChild } from "./child-registry";

function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), "rkh-children-")), "children.json");
  return { file, registry: createChildRegistry(file) };
}
const idle = [process.execPath, "-e", "setInterval(()=>{},1000)"];

describe("child registry", () => {
  test("registers before returning, redacts arguments/env, unregisters on exit", async () => {
    const { file, registry } = fixture();
    registry.sweepStaleOnStartup();
    const child = registry.spawnTracked([process.execPath, "-e", "console.log('private-token')"], {
      purpose: "test", stdout: "pipe", stderr: "ignore", env: { ...process.env, SECRET: "private-env" },
    });
    expect(registry.listTracked().map(c => c.pid)).toEqual([child.pid]);
    expect(readFileSync(file, "utf8")).not.toContain("private-token");
    expect(readFileSync(file, "utf8")).not.toContain("private-env");
    expect(await new Response(child.stdout).text()).toContain("private-token");
    await child.exited;
    await Promise.resolve();
    expect(registry.listTracked()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });

  test("shutdown kills actual children, awaits exit, is idempotent and blocks new spawns", async () => {
    const { registry } = fixture();
    registry.sweepStaleOnStartup();
    const child = registry.spawnTracked(idle, { purpose: "test-idle", stdout: "ignore", stderr: "ignore" });
    try {
      const shutdown = registry.killTrackedOnShutdown(50);
      expect(registry.killTrackedOnShutdown(50)).toBe(shutdown);
      await shutdown;
      await child.exited;
      await Promise.resolve();
      expect(registry.listTracked()).toEqual([]);
      expect(() => registry.spawnTracked(idle, { purpose: "late" })).toThrow("退出");
    } finally { child.kill(); }
  }, 15000);

  test("stale sweep never kills and retains surviving old records across new writes", async () => {
    const { file, registry } = fixture();
    const child = Bun.spawn(idle, { stdout: "ignore", stderr: "ignore" });
    const entry = (pid: number, parentPid: number): TrackedChild => ({
      pid, parentPid, purpose: "previous", command: "bun", startedAt: Date.now(),
    });
    writeFileSync(file, JSON.stringify([entry(99999999, 99999998), entry(child.pid, 99999998), entry(process.pid, process.pid)]));
    try {
      expect(registry.sweepStaleOnStartup().stale.map(c => c.pid)).toEqual([99999999, child.pid]);
      const current = registry.spawnTracked([process.execPath, "-e", ""], { purpose: "current" });
      await current.exited;
      await registry.killTrackedOnShutdown(50);
      expect(child.exitCode).toBeNull();
      expect(JSON.parse(readFileSync(file, "utf8")).map((c: TrackedChild) => c.pid)).toContain(child.pid);
    } finally { child.kill(); await child.exited; }
  }, 15000);

  test("corrupt registry warns without preventing startup", () => {
    const { file, registry } = fixture();
    writeFileSync(file, "{broken");
    const oldWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args) => { warnings.push(args); };
    try {
      expect(registry.sweepStaleOnStartup()).toEqual({ stale: [] });
      expect(warnings).toHaveLength(1);
    } finally { console.warn = oldWarn; }
  });

  test("tracks Node children without changing stdio or exit handling", async () => {
    const { registry } = fixture();
    registry.sweepStaleOnStartup();
    const child = spawn(process.execPath, ["-e", "console.log('node-child')"], { stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    child.stdout.on("data", chunk => output.push(chunk));
    registry.trackNodeChild(child, process.execPath, "workspace-bash");
    expect(registry.listTracked()).toHaveLength(1);
    await new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
    expect(Buffer.concat(output).toString()).toContain("node-child");
    expect(registry.listTracked()).toEqual([]);
  });

  test("failed executable does not leave a registered PID", async () => {
    const { registry } = fixture();
    registry.sweepStaleOnStartup();
    try {
      const child = registry.spawnTracked(["rkh-command-does-not-exist"], { purpose: "missing" });
      await child.exited.catch(() => undefined);
      await Promise.resolve();
    } catch { /* Bun may throw synchronously for ENOENT. */ }
    expect(registry.listTracked()).toEqual([]);
  });

  test("shutdown terminates a launcher and its long-running descendant", async () => {
    const { registry } = fixture();
    registry.sweepStaleOnStartup();
    // On POSIX, keep the descendant alive after TERM so the final process-group
    // KILL is exercised even when its launcher has already exited.
    const descendantSource = `process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000);`;
    const source = `const c=Bun.spawn([process.execPath,'-e',${JSON.stringify(descendantSource)}],{stdout:'pipe',stderr:'ignore'}); await c.stdout.getReader().read(); console.log(c.pid); setInterval(()=>{},1000);`;
    const child = registry.spawnTracked([process.execPath, "-e", source], {
      purpose: "test-tree", detached: process.platform !== "win32", stdout: "pipe", stderr: "ignore",
    });
    let descendant: number | undefined;
    try {
      const reader = child.stdout.getReader();
      const first = await reader.read();
      descendant = Number(new TextDecoder().decode(first.value).trim());
      expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
      reader.releaseLock();
      await registry.killTrackedOnShutdown(100);
      await child.exited;
      const isAlive = () => {
        try { process.kill(descendant!, 0); return true; } catch { return false; }
      };
      // Linux can retain a killed orphan as a zombie until init reaps it;
      // that is terminated, but a live process must fail this assertion.
      if (process.platform === "linux") {
        const isRunning = () => {
          try { return !/^State:\s+Z/m.test(readFileSync(`/proc/${descendant}/status`, "utf8")); }
          catch (err) {
            if (["ENOENT", "ESRCH"].includes((err as NodeJS.ErrnoException).code ?? "")) return false;
            throw err;
          }
        };
        for (let retry = 0; retry < 100 && isRunning(); retry++) await Bun.sleep(10);
        expect(isRunning()).toBe(false);
      }
      if (process.platform === "win32") expect(isAlive()).toBe(false);
      expect(registry.listTracked()).toEqual([]);
    } finally {
      child.kill();
      if (descendant && descendant > 0) { try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ } }
    }
  }, 20000);
});
