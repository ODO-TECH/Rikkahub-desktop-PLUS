// S-F2 PTC sandbox runtime tests.
//
// 钉住五条纪律:
//  ① 隔离:VM 内没有 process/require/Bun/fetch/setTimeout,工作区只能经 tools.* 触碰;
//  ② 桥:同步外观的 tools.name(args) 拿回宿主值;宿主抛错变成可 catch 的 JS 异常;
//  ③ 上限:maxCalls 拦截超额调用、超长结果进 VM 前截断(字符串截字符,对象换预览);
//  ④ 超时:CPU 死循环由 VM 内 deadline 打断(.timeoutMs=1s 起),工具等待由墙钟兜底;
//  ⑤ 有界输出:console 有字符与行数上限;调用记录 name/ok/ms/bytes 齐全。
import { describe, expect, test } from "bun:test";
import { runSandboxedProgram, sandboxSelfCheck, type SandboxToolBinding } from "./quickjs-sandbox";

function echoTool(impl?: (args: Record<string, unknown>) => Promise<unknown> | unknown): SandboxToolBinding {
  return {
    name: "echo",
    parameters: { type: "object" },
    invoke: (args) => Promise.resolve(impl ? impl(args) : args),
  };
}

const base = {
  timeoutMs: 3_000,
  maxCalls: 10,
  maxLogChars: 4_000,
  maxToolResultChars: 400,
};

describe("隔离", () => {
  test("VM 里拿不到任何宿主能力", async () => {
    const check = await sandboxSelfCheck();
    expect(check.ok).toBe(true);
    expect(check.result).toEqual({ sum: 6, iso: "undefinedundefinedundefined" });

    const run = await runSandboxedProgram({
      ...base,
      tools: [],
      code: `return [typeof process, typeof require, typeof Bun, typeof fetch, typeof setTimeout, typeof globalThis.window].join(",");`,
    });
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.result).toBe("undefined,undefined,undefined,undefined,undefined,undefined");
  });
});

describe("工具桥", () => {
  test("同步外观调用拿回宿主值,多次调用按序记录", async () => {
    const run = await runSandboxedProgram({
      ...base,
      tools: [echoTool()],
      code: `
        const a = tools.echo({ n: 1 });
        const b = tools.echo({ n: 2 });
        return { a, b };
      `,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(JSON.parse(run.result!)).toEqual({ a: { n: 1 }, b: { n: 2 } });
    expect(run.calls.map((call) => [call.name, call.ok])).toEqual([
      ["echo", true],
      ["echo", true],
    ]);
    for (const call of run.calls) {
      expect(call.ms).toBeGreaterThanOrEqual(0);
      expect(call.bytes).toBeGreaterThan(0);
    }
  });

  test("宿主错误变成可 catch 的异常,err.tool 指向工具名", async () => {
    const run = await runSandboxedProgram({
      ...base,
      tools: [
        echoTool(() => {
          throw new Error("path escapes workspace");
        }),
      ],
      code: `
        try {
          tools.echo({});
          return "should not reach";
        } catch (err) {
          return { caught: err.message, tool: err.tool };
        }
      `,
    });
    expect(run.ok).toBe(true);
    if (run.ok) expect(JSON.parse(run.result!)).toEqual({ caught: "path escapes workspace", tool: "echo" });
    expect(run.calls[0]?.ok).toBe(false);
  });

  test("未知工具名给出可用清单", async () => {
    const run = await runSandboxedProgram({
      ...base,
      tools: [echoTool()],
      code: `try { tools.nope({}); return "no"; } catch (err) { return err.message; }`,
    });
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.result).toContain("Unknown tool \"nope\"");
  });
});

describe("上限", () => {
  test("maxCalls 拦截超额调用,已执行的不回滚", async () => {
    const run = await runSandboxedProgram({
      ...base,
      maxCalls: 2,
      tools: [echoTool()],
      code: `
        tools.echo({ n: 1 });
        tools.echo({ n: 2 });
        let third = "";
        try { tools.echo({ n: 3 }); } catch (err) { third = err.message; }
        return third;
      `,
    });
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.result).toContain("Call limit reached (2");
    expect(run.calls).toHaveLength(2);
  });

  test("超长字符串结果进 VM 前被截断", async () => {
    const run = await runSandboxedProgram({
      ...base,
      tools: [echoTool(() => "x".repeat(1000))],
      code: `const text = tools.echo({}); return text.length + ":" + text.includes("truncated by the sandbox");`,
    });
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.result).toMatch(/^4\d\d:true$/); // 400 字符 + 标记
  });

  test("超长对象结果换成可读预览,程序不会因 JSON 截断而炸", async () => {
    const run = await runSandboxedProgram({
      ...base,
      tools: [echoTool(() => ({ rows: Array.from({ length: 200 }, (_, i) => ({ i, text: "y".repeat(20) })) }))],
      code: `const r = tools.echo({}); return { truncated: r.truncated, hasPreview: typeof r.preview === "string" };`,
    });
    expect(run.ok).toBe(true);
    if (run.ok) expect(JSON.parse(run.result!)).toEqual({ truncated: true, hasPreview: true });
  });

  test("console 输出有字符上限且不阻断程序", async () => {
    const run = await runSandboxedProgram({
      ...base,
      maxLogChars: 50,
      tools: [],
      code: `for (let i = 0; i < 200; i += 1) console.log("line-" + i); return "done";`,
    });
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.result).toBe("done");
      // 字符上限按记录内容计;join 的换行分隔符不占额度,留一点余量。
      expect(run.logs.length).toBeLessThanOrEqual(60);
    }
  });
});

describe("超时", () => {
  test("CPU 死循环被 VM 内 deadline 打断(不依赖宿主事件循环)", async () => {
    const started = Date.now();
    const run = await runSandboxedProgram({
      ...base,
      timeoutMs: 1_000,
      tools: [],
      code: `while (true) {}`,
    });
    const elapsed = Date.now() - started;
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.timedOut).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);

  test("工具长时间不返回由墙钟兜底,迟到的结果不再让程序继续", async () => {
    let invoked = 0;
    const started = Date.now();
    const run = await runSandboxedProgram({
      ...base,
      timeoutMs: 100,
      tools: [
        echoTool(async () => {
          invoked += 1;
          await new Promise((resolve) => setTimeout(resolve, 400));
          return "late";
        }),
      ],
      code: `return tools.echo({});`,
    });
    const elapsed = Date.now() - started;
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(1_500);
    expect(invoked).toBe(1);
    // 给迟到的桥回调一点时间:不应有第二次执行,也不应抛出未处理异常。
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(invoked).toBe(1);
  }, 10_000);
});

describe("程序错误", () => {
  test("语法错误折成 ok:false,不向宿主抛", async () => {
    const run = await runSandboxedProgram({ ...base, tools: [], code: `return (` });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.length).toBeGreaterThan(0);
  });

  test("外部 abort 立即返回(不等待程序跑完)", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const run = await runSandboxedProgram({
      ...base,
      timeoutMs: 5_000,
      tools: [echoTool(async () => new Promise((resolve) => setTimeout(() => resolve("x"), 2_000)))],
      code: `return tools.echo({});`,
      signal: controller.signal,
    });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error).toContain("aborted");
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 10_000);
});
