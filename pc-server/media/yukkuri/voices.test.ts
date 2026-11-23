// media/yukkuri/voices.test.ts — 声种参数表与情绪偏移
// 数值锁的是 SDK 里 AquesTalk.h 的 gVoice_* 原值:改错一个数字不会报错,只会让某个音色
// 听起来「怪但说不出哪怪」,这类只能靠断言钉住。
import { expect, test } from "bun:test";
import {
  clampVoiceParam,
  isYukkuriEmotion,
  listYukkuriVoices,
  resolveVoice,
  YUKKURI_CHARACTERS,
  YUKKURI_PRESETS,
} from "./voices";
import { voiceParamsFor } from "./index";

test("预设声种取自官方 gVoice_* 常量", () => {
  expect(YUKKURI_PRESETS.f1).toEqual({ bas: 0, spd: 100, vol: 100, pit: 100, acc: 100, lmd: 100, fsc: 100 });
  expect(YUKKURI_PRESETS.f2.pit).toBe(77);
  expect(YUKKURI_PRESETS.f2.acc).toBe(150);
  // F3 的 fsc=148 → 输出 23680Hz(琪露诺),这是 wav 侧必须按头算时长的原因
  expect(YUKKURI_PRESETS.f3).toMatchObject({ spd: 80, lmd: 61, fsc: 148 });
  expect(YUKKURI_PRESETS.r2).toMatchObject({ bas: 1, spd: 70, fsc: 180 });
});

test("角色只是声种别名,不额外改参数", () => {
  expect(YUKKURI_CHARACTERS.cirno.preset).toBe("f3");
  expect(YUKKURI_CHARACTERS.marisa.preset).toBe("f2");
  expect(resolveVoice("cirno")).toEqual(YUKKURI_PRESETS.f3);
  expect(resolveVoice("reimu")).toEqual(YUKKURI_PRESETS.f1);
});

test("情绪是叠加不是替换,且每个参数各自受边界约束", () => {
  const angry = resolveVoice("f1", "angry");
  expect(angry.pit).toBe(108); // 100 + 8
  expect(angry.acc).toBe(155);
  expect(angry.spd).toBe(112);
  expect(angry.vol).toBe(115);
  expect(angry.lmd).toBe(100); // 情绪没动 lmd → 保持原值

  const sad = resolveVoice("m1", "sad");
  expect(sad.spd).toBe(90);
  expect(sad.pit).toBe(20); // 30 - 14 = 16 → 被 pit 下界 20 收住(引擎手册区间)

  // 边界:m2 的 acc 130 + surprised 25 = 155 未越界;pit 45 + 30 = 75
  expect(resolveVoice("m2", "surprised")).toMatchObject({ pit: 75, acc: 155 });
  // m1 原值 pit 30 / spd 100:sleepy 是 -8 / -18,离下界还远,不该被 clamp 削平
  expect(resolveVoice("m1", "sleepy")).toMatchObject({ pit: 22, spd: 82, acc: 70, lmd: 92 });
});

test("未知情绪报错并列出可用值(不静默按 neutral 走)", () => {
  expect(() => resolveVoice("f1", "excited")).toThrow(/neutral/);
  expect(isYukkuriEmotion("happy")).toBe(true);
  expect(isYukkuriEmotion("excited")).toBe(false);
});

test("显式覆盖优先于声种与情绪", () => {
  const overridden = resolveVoice("f1", "angry", { spd: 200, pit: 20 });
  expect(overridden.spd).toBe(200);
  expect(overridden.pit).toBe(20);
  expect(overridden.acc).toBe(155); // 没覆盖的仍走情绪
});

test("clamp 按手册区间收边并取整", () => {
  expect(clampVoiceParam("spd", 999)).toBe(300);
  expect(clampVoiceParam("spd", 10)).toBe(50);
  expect(clampVoiceParam("vol", -5)).toBe(0);
  expect(clampVoiceParam("pit", 200.6)).toBe(200);
  expect(clampVoiceParam("fsc", 10)).toBe(50);
});

test("倍速倍音高相对音色原值,而不是相对 100", () => {
  // 琪露诺原速 80:1.2 倍 = 96 再加 happy 的 +6 → 102.4 → 103(实测值,不是 80×1.2 之后再算)
  expect(voiceParamsFor({ voice: "cirno", emotion: "happy", speed: 1.2, pitch: 1.05 })).toEqual({
    bas: 0, spd: 103, vol: 100, pit: 124, acc: 130, lmd: 61, fsc: 148,
  });
  // 不设倍率时倍率不参与,保持声种原值
  expect(voiceParamsFor({ voice: "f3" })).toEqual(YUKKURI_PRESETS.f3);
  // 非法倍率(0 / NaN)不改原值,避免把引擎参数清零
  expect(voiceParamsFor({ voice: "f1", speed: 0 })).toEqual(YUKKURI_PRESETS.f1);
  expect(voiceParamsFor({ voice: "f1", pitch: Number.NaN })).toEqual(YUKKURI_PRESETS.f1);
});

test("清单覆盖声种与角色,前端下拉与后端校验同源", () => {
  const ids = listYukkuriVoices().map((v) => v.id);
  expect(ids).toContain("f1");
  expect(ids).toContain("r2");
  expect(ids).toContain("cirno");
  expect(ids.filter((id) => id in YUKKURI_PRESETS)).toHaveLength(7);
  expect(listYukkuriVoices().find((v) => v.id === "marisa")).toMatchObject({ kind: "character" });
});
