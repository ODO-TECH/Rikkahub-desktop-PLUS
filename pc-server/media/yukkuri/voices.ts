// media/yukkuri/voices.ts — 音色表:预设声种 + 情绪偏移 + 角色对照
// 移植自 reference/dsh-yukkuli 的 voice/presets.js + voice/characters.js。
// 数值直接取自 SDK 里 AquesTalk.h 的 gVoice_* 常量,不是凭印象写的。
//
// 只覆盖本机可用的引擎:AQTK10(原生 x64,7 个声质参数,16kHz;F3 因 fsc=148 是 23.68kHz)。
// 上游那份表里走 AQTK1 的角色(帕秋莉、比那名居天子、低音炮帕秋莉)需要 v86 WASM 模拟
// 32 位 DLL,并且官方只发 32 位库 —— 本版本没带那条链路,所以不列这些角色,
// 而不是拿 AQTK10 的近似音色冒充(那会让用户以为换错了设置)。

import type { AqtkVoice } from "./engine";

export const YUKKURI_PRESETS: Record<string, AqtkVoice> = {
  f1: { bas: 0, spd: 100, vol: 100, pit: 100, acc: 100, lmd: 100, fsc: 100 },
  f2: { bas: 1, spd: 100, vol: 100, pit: 77, acc: 150, lmd: 100, fsc: 100 },
  // fsc=148 → 输出 23680Hz,这也是 wav.ts 坚持从头部读采样率的原因
  f3: { bas: 0, spd: 80, vol: 100, pit: 100, acc: 100, lmd: 61, fsc: 148 },
  m1: { bas: 2, spd: 100, vol: 100, pit: 30, acc: 100, lmd: 100, fsc: 100 },
  m2: { bas: 2, spd: 105, vol: 100, pit: 45, acc: 130, lmd: 120, fsc: 100 },
  r1: { bas: 2, spd: 100, vol: 100, pit: 30, acc: 20, lmd: 190, fsc: 100 },
  r2: { bas: 1, spd: 70, vol: 100, pit: 50, acc: 50, lmd: 50, fsc: 180 },
};

/**
 * 情绪 → 参数偏移,叠加在声种之上而不是替换。
 * pit/acc/lmd 三者共同决定「语气」,单改一个听不出情绪。
 */
export const YUKKURI_EMOTIONS: Record<string, Partial<AqtkVoice>> = {
  neutral: {},
  happy: { pit: 18, acc: 30, spd: 6 },
  angry: { pit: 8, acc: 55, spd: 12, vol: 15 },
  sad: { pit: -14, acc: -25, spd: -10, lmd: -12 },
  surprised: { pit: 30, acc: 25, spd: 8 },
  shy: { pit: 10, acc: -15, spd: -6, vol: -10 },
  sleepy: { pit: -8, acc: -30, spd: -18, lmd: -8 },
};

/** 东方角色 → 声种。上游逐轮试听后的结论,原值照抄。 */
export const YUKKURI_CHARACTERS: Record<string, { name: string; preset: keyof typeof YUKKURI_PRESETS }> = {
  reimu: { name: "博丽灵梦", preset: "f1" },
  marisa: { name: "雾雨魔理沙", preset: "f2" },
  cirno: { name: "琪露诺", preset: "f3" },
};

const CLAMP: Record<string, readonly [number, number]> = {
  spd: [50, 300],
  vol: [0, 300],
  pit: [20, 200],
  acc: [0, 200],
  lmd: [0, 200],
  fsc: [50, 200],
};

const PARAM_KEYS = ["spd", "vol", "pit", "acc", "lmd", "fsc"] as const;

function clampParam(name: (typeof PARAM_KEYS)[number], value: number): number {
  const range = CLAMP[name] ?? [0, 300];
  return Math.min(range[1], Math.max(range[0], Math.round(value)));
}

/** 供上层把「倍速/倍音高」这类倍数换算成引擎量纲时复用同一套边界。 */
export function clampVoiceParam(name: (typeof PARAM_KEYS)[number], value: number): number {
  return clampParam(name, value);
}

export function isYukkuriEmotion(name: string): boolean {
  return Object.hasOwn(YUKKURI_EMOTIONS, name);
}

/** 声种名(f1…r2)与角色 id(reimu/marisa/cirno)都接受;认不出来时回落 f1 并留一行警告 ——
 *  值是 UI 下拉产生的,手改 state 或跨机恢复才可能拼错,这种情况「能出声」比「罢工」有用,
 *  但不能默默换个音色:日志里要说清楚用的是谁的嗓子。 */
function baseVoice(voiceName: string): AqtkVoice {
  const character = voiceName in YUKKURI_CHARACTERS ? YUKKURI_PRESETS[YUKKURI_CHARACTERS[voiceName]!.preset] : undefined;
  const preset = YUKKURI_PRESETS[voiceName] ?? character;
  if (!preset) console.warn(`[yukkuri] 未收录的音色名 ${JSON.stringify(voiceName)},按 f1 念(可用: ${Object.keys(YUKKURI_PRESETS).concat(Object.keys(YUKKURI_CHARACTERS)).join("、")})`);
  return preset ?? YUKKURI_PRESETS.f1!;
}

/**
 * 把(声源, 情绪, 显式覆盖)合成一份 AQTK_VOICE。
 * overrides 用的是引擎原生量纲(spd 100 = 常速),倍数换算是 index.ts 的事。
 */
export function resolveVoice(
  voiceName = "f1",
  emotionName = "neutral",
  overrides: Partial<AqtkVoice> = {},
): AqtkVoice {
  const emotion = YUKKURI_EMOTIONS[emotionName];
  if (!emotion) throw new Error(`未知的油库里情绪: ${emotionName}(可用: ${Object.keys(YUKKURI_EMOTIONS).join("、")})`);

  const base = baseVoice(voiceName);
  const out: AqtkVoice = { bas: base.bas, spd: 100, vol: 100, pit: 100, acc: 100, lmd: 100, fsc: 100 };

  for (const key of PARAM_KEYS) {
    const value = (base[key] ?? 100) + (emotion[key] ?? 0);
    out[key] = clampParam(key, overrides[key] ?? value);
  }
  return out;
}

/** 给设置页/自检用的扁平清单。 */
export function listYukkuriVoices(): { id: string; kind: "preset" | "character"; label: string }[] {
  return [
    ...Object.keys(YUKKURI_PRESETS).map((id) => ({ id, kind: "preset" as const, label: id.toUpperCase() })),
    ...Object.entries(YUKKURI_CHARACTERS).map(([id, c]) => ({ id, kind: "character" as const, label: c.name })),
  ];
}
