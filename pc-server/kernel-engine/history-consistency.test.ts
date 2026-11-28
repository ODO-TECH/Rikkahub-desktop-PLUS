import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const scenario of ["two-turns", "edit", "branch", "recovery", "delete"]) {
  test(`application history remains authoritative: ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "rkh-history-"));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../test-utils/kernel-history-scenario.ts"), scenario], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dir, RIKKAHUB_ANALYTICS: "0" },
      stdout: "pipe", stderr: "pipe", timeout: 20000,
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain(`PASS ${scenario}`);
  }, 30000);
}
