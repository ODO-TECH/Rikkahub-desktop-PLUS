// media/tts-yukkuri.test.ts — 油库里作为内置 TTS 厂商的「接线」校验
// 引擎本身的行为在 media/yukkuri/synth.test.ts;这里只管三层接线:默认模板、存储归一化、
// generateSpeechWithTtsProvider 的编排(本地分支必须在 apiKey 校验之前命中)。
import { expect, mock, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

mock.module("../api/logs", () => ({ addLog: () => {} }));

const { setState } = await import("../persistence/json-store");
const { describeSdk } = await import("./yukkuri/sdk");
const { defaultTtsProvider, generateSpeechWithTtsProvider, normalizeTtsProviders, warmupYukkuriIfConfigured } = await import("./tts");
const { TTS_PROVIDER_TYPES } = await import("./tts-providers/registry");

const absentRoot = join(homedir(), `rikkahub-yukkuri-absent-${process.pid}`);

function configure(overrides: Record<string, unknown> = {}) {
  const provider = {
    type: "yukkuri",
    id: "yk1",
    name: "Yukkuri TTS",
    apiKey: "",
    baseUrl: "",
    voice: "cirno",
    emotion: "happy",
    speed: 1,
    pitch: 1,
    sdkPath: absentRoot,
    ...overrides,
  };
  setState({
    settings: { ttsProviders: [provider], selectedTTSProviderId: "yk1", proxyConfig: undefined },
  } as never);
  return provider;
}

test("默认模板:不联网、不要 key,带音色/情绪/倍率与 SDK 路径", () => {
  const provider = defaultTtsProvider("yukkuri");
  expect(provider.type).toBe("yukkuri");
  expect(provider.apiKey).toBe("");
  expect(provider.baseUrl).toBe("");
  expect(provider.voice).toBe("f1");
  expect(provider.emotion).toBe("neutral");
  expect(provider.speed).toBe(1);
  expect(provider.pitch).toBe(1);
  expect(provider.sdkPath).toBe("");
  expect(TTS_PROVIDER_TYPES).toContain("yukkuri");
});

test("归一化往返:用户改过的每个字段都活着,type 不被收敛成 system", () => {
  const saved = {
    type: "yukkuri",
    id: "yk1",
    name: "我的油库里",
    apiKey: "",
    baseUrl: "",
    voice: "marisa",
    emotion: "sleepy",
    speed: 1.35,
    pitch: 0.9,
    sdkPath: "/home/me/yukkuri-sdk",
  };
  const [out] = normalizeTtsProviders([saved]);
  expect(out?.type).toBe("yukkuri");
  expect(out?.name).toBe("我的油库里");
  expect(out?.voice).toBe("marisa");
  expect(out?.emotion).toBe("sleepy");
  expect(out?.speed).toBe(1.35);
  expect(out?.pitch).toBe(0.9);
  expect(out?.sdkPath).toBe("/home/me/yukkuri-sdk");
  expect(out?.id).toBe("yk1");
});

/** 走一遍编排并把结果收成判别联合:成功/失败都要能类型安全地断言。 */
async function speak(text: string, providerId: string, speed?: number) {
  return generateSpeechWithTtsProvider(text, providerId, speed).then(
    (result) => ({ ok: true as const, result }),
    (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }),
  );
}

test("编排:本地分支在 apiKey 校验之前命中(否则空 key 会先报错)", async () => {
  configure();
  const outcome = await speak("你好，世界。", "yk1");
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.message).not.toContain("API Key");
  // Windows 上是「SDK 缺件」;非 Windows / 缺 koffi 原生件时是加载失败,两者都说明分支被走到了
  expect(outcome.message).toMatch(/油库里|AquesTalk|koffi/i);
});

test("speedOverride 透传给本地引擎(播放条的倍速不影响存储)", async () => {
  configure({ speed: 2 });
  const outcome = await speak("测试倍速。", "yk1", 0.5);
  // 只验证没在参数换算上先炸:换算发生在引擎之前,炸了会是别的文案
  expect(outcome.ok ? true : /油库里|AquesTalk|koffi/i.test(outcome.message)).toBe(true);
});

test("启动预热:没配 yukkuri 时完全不碰本地引擎", async () => {
  setState({
    settings: { ttsProviders: [defaultTtsProvider("system")], selectedTTSProviderId: "system", proxyConfig: undefined },
  } as never);
  await expect(warmupYukkuriIfConfigured()).resolves.toBeUndefined();
});

test("启动预热:配了但 SDK 缺失也只是跳过,不影响后端就绪", async () => {
  configure();
  await expect(warmupYukkuriIfConfigured()).resolves.toBeUndefined();
});

// 随包 SDK 在位时(源码 checkout 与便携版 dist 都算),留空就该直接出声 ——
// 这是「装完即用」这条产品口径的唯一机械证明。
test.skipIf(!describeSdk(null).ready)("sdkPath 留空 = 随包 SDK:整条链路无需配置", async () => {
  configure({ sdkPath: "" });
  const outcome = await speak("随包 SDK 测试。", "yk1");
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.result.audio.subarray(0, 4).toString()).toBe("RIFF");
  expect(outcome.result.audio.length).toBeGreaterThan(44);
  expect(outcome.result.mime).toBe("audio/wav");
});
