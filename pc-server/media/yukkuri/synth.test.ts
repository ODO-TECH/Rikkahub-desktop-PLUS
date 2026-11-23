// media/yukkuri/synth.test.ts — 端到端:文本 → 一条可播 WAV
//
// 分两组:
// ① 不需要 DLL 的口径校验(SDK 自检、错误文案、预热不炸)—— 任何机器都跑;
// ② 真机合成 —— 只有本机备好了 AquesTalk SDK 才跑(RIKKAHUB_YUKKURI_SDK_ROOT 或 ~/yukkuri-sdk),
//    CI/Docker 上整组 skip,但绝不假装通过。
// 第二组里锁的是「拼接后的头部与实际字节一致」这类只有真引擎能证伪的事:F3 输出 23680Hz,
// 硬编码 16000 的实现会在这里露馅。

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeSdk, requireSdk } from "./sdk";
import { synthesizeYukkuri, warmupYukkuri, resetYukkuri, yukkuriStatus } from "./index";

const sdk = describeSdk(null);
const absentRoot = join(homedir(), `rikkahub-yukkuri-absent-${process.pid}`);

describe("SDK 自检(不需要 DLL)", () => {
  test("目录不存在时,ready=false 且提示说清楚缺哪三件", () => {
    const status = describeSdk(absentRoot);
    expect(status.ready).toBe(false);
    expect(status.rootIsAscii).toBe(true);
    expect(status.aqtk10).toBe(false);
    expect(status.hint).toContain("aqtk10_win/lib64/AquesTalk.dll");
    expect(status.hint).toContain("aqdic.bin");
  });

  test("requireSdk 把缺件变成一句人话,而不是 DLL 层的空指针", () => {
    expect(() => requireSdk(absentRoot)).toThrow(/油库里合成不可用/);
  });

  test("含非 ASCII 字符的目录被点名(那会伪装成「词典不正」err=200)", () => {
    const status = describeSdk(join(homedir(), "油库里 SDK"));
    expect(status.rootIsAscii).toBe(false);
    expect(status.hint).toContain("ASCII");
  });

  test("预热失败只返回 false(启动流程不该因为这个挂掉)", async () => {
    expect(await warmupYukkuri(absentRoot)).toBe(false);
  });

  test("状态接口把音色/情绪清单一起给出(前端下拉同源)", () => {
    const status = yukkuriStatus(absentRoot);
    expect(status.voices).toContain("cirno");
    expect(status.emotions).toContain("shy");
    expect(status.sdk.root).toBe(absentRoot);
  });

  test("SDK 不在时合成如实报错,不降级到别的音色", async () => {
    await expect(synthesizeYukkuri("你好", { sdkPath: absentRoot })).rejects.toThrow(/油库里合成不可用/);
  });
});

describe("真机合成", () => {
  test.skipIf(!sdk.ready)("中文整轮:分段合成后拼成一条合法 WAV", async () => {
    resetYukkuri();
    const result = await synthesizeYukkuri("你好，世界。今天是 2026 年，端口 8080。", {
      sdkPath: sdk.root,
      voice: "f1",
      noCache: true,
    });
    expect(result.audio.subarray(0, 4).toString()).toBe("RIFF");
    expect(result.mime).toBe("audio/wav");
    expect(result.segments).toBeGreaterThan(0);
    expect(result.skipped).toBe(0); // 分段预算没被引擎拒收
    expect(result.seconds).toBeGreaterThan(0.5);
    expect(result.audio.length).toBeGreaterThan(44);
  });

  test.skipIf(!sdk.ready)("琪露诺走 F3:输出是 23680Hz,时长必须按头部算", async () => {
    const result = await synthesizeYukkuri("琪露诺是最强的。", { sdkPath: sdk.root, voice: "cirno", noCache: true });
    expect(result.audio.readUInt32LE(24)).toBe(23680);
    // 硬编码 16000 的实现会在这里给出偏大的秒数
    expect(result.seconds).toBeCloseTo((result.audio.length - 44) / 2 / 23680, 3);
  });

  test.skipIf(!sdk.ready)("同文本同参数命中缓存,换音色则重算", async () => {
    const settings = { sdkPath: sdk.root, voice: "f1" };
    const first = await synthesizeYukkuri("缓存一致性测试。", settings);
    const second = await synthesizeYukkuri("缓存一致性测试。", settings);
    expect(second.fromCache).toBe(true);
    expect(second.audio).toEqual(first.audio);

    const other = await synthesizeYukkuri("缓存一致性测试。", { ...settings, voice: "m1" });
    expect(other.fromCache).toBe(false);
    expect(other.audio.equals(first.audio)).toBe(false);

    // 缓存返回的是副本:调用方改动不能污染缓存里的字节
    first.audio.writeUInt32LE(0, 24);
    const third = await synthesizeYukkuri("缓存一致性测试。", settings);
    expect(third.audio.readUInt32LE(24)).toBe(16000);
  });

  test.skipIf(!sdk.ready)("Markdown 噪音不进引擎,纯代码块直接报错", async () => {
    const spoken = await synthesizeYukkuri("## 结论\n- 第一点\n\n```ts\nconst x = 1;\n```\n", {
      sdkPath: sdk.root,
      voice: "f1",
      noCache: true,
    });
    expect(spoken.segments).toBeGreaterThan(0);
    await expect(synthesizeYukkuri("```ts\nconst x = 1;\n```", { sdkPath: sdk.root })).rejects.toThrow(/没有可朗读/);
  });

  test.skipIf(!sdk.ready)("情绪与倍率参数真的改变了输出字节", async () => {
    const neutral = await synthesizeYukkuri("这条测试用来比较情绪参数。", { sdkPath: sdk.root, voice: "f1", emotion: "neutral", noCache: true });
    const sleepy = await synthesizeYukkuri("这条测试用来比较情绪参数。", { sdkPath: sdk.root, voice: "f1", emotion: "sleepy", noCache: true });
    const fast = await synthesizeYukkuri("这条测试用来比较情绪参数。", { sdkPath: sdk.root, voice: "f1", emotion: "neutral", speed: 1.5, noCache: true });
    expect(sleepy.audio.equals(neutral.audio)).toBe(false);
    expect(fast.seconds).toBeLessThan(neutral.seconds);
  });

  test.skipIf(!sdk.ready)("长回复不被引擎拒收:三十句中文全数合成", async () => {
    const long = "这是一段很长的中文测试文本。".repeat(30);
    const result = await synthesizeYukkuri(long, { sdkPath: sdk.root, voice: "marisa", emotion: "angry", noCache: true });
    expect(result.segments).toBe(30);
    expect(result.skipped).toBe(0);
  });

  test.skipIf(!sdk.ready)("resetYukkuri 关掉句柄后能重新开起来", async () => {
    await synthesizeYukkuri("第一次。", { sdkPath: sdk.root, noCache: true });
    resetYukkuri();
    const after = await synthesizeYukkuri("第二次。", { sdkPath: sdk.root, noCache: true });
    expect(after.audio.subarray(0, 4).toString()).toBe("RIFF");
  });
});
