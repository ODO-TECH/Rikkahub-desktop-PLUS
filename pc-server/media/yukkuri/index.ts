// media/yukkuri/index.ts — 油库里(AquesTalk)语音合成:文本 → 一段可播的 WAV
//
// 这是 RDP 侧的唯一入口,管线顺序与 reference/dsh-yukkuli 一致:
//   readable(去 Markdown)→ segment(切成引擎能吃的长度)→ prepareText(中文转假名)
//   → AqKanji2Koe(汉字→音声記号列)→ AQTK10 Synthe → concatWavs
// 中间每一步都有独立模块,想换引擎/加角色只动 voices.ts 与 engine.ts。
//
// 与上游的差异(刻意):
// - 不做「本地引擎不行就换个在线服务」的静默降级:选的是油库里音色,换成别的音色
//   比报错更难查;SDK 不在就直接把缺什么说出来。
// - 单段失败不毁掉整轮:跳过那段继续念后面的,全部失败才抛错(上游 pipeline 同口径)。
// - 缓存键含全部影响输出的因素(文本/声源/情绪/倍速/倍音高/SDK 路径),少一个就会串音;
//   存和取都拷副本 —— 调用方拿到的是同一个 Buffer,它一改就会把缓存里的也改掉。

import { createHash } from "node:crypto";
import { LruCache } from "./cache";
import { closeEngines, getK2k, getSynth } from "./engine";
import { describeSdk, requireSdk } from "./sdk";
import { extractReadableText } from "./readable";
import { segment } from "./segment";
import { prepareText } from "./text";
import { concatWavs, wavSeconds } from "./wav";
import { clampVoiceParam, resolveVoice } from "./voices";

export interface YukkuriSynthesisSettings {
  /** AquesTalk SDK 目录;留空则按 RIKKAHUB_YUKKURI_SDK_ROOT / ~/yukkuri-sdk 解析 */
  sdkPath?: string | null;
  /** 声种 f1 f2 f3 m1 m2 r1 r2,或角色 reimu marisa cirno */
  voice?: string;
  /** neutral happy angry sad surprised shy sleepy */
  emotion?: string;
  /** 倍速,1 = 常速(引擎量纲 spd 50–300 的倍率) */
  speed?: number;
  /** 倍音高,1 = 原音高(AQTK10 用 pit 参数,不需要改采样率) */
  pitch?: number;
  /** 单段假名预算,默认 100 */
  maxKana?: number;
  /** 调试/预热用:绕过缓存 */
  noCache?: boolean;
}

export interface YukkuriSynthesisResult {
  audio: Buffer;
  mime: string;
  segments: number;
  /** 播完要多少秒(从 WAV 头算,不是猜的采样率) */
  seconds: number;
  /** 因引擎报错被跳过的段数 */
  skipped: number;
  fromCache: boolean;
}

const CACHE_CAPACITY = 200;
/** 一轮回复最多合成这么多段;超出部分截断(200 段 ≈ 两千余句,正常回复到不了)。 */
const MAX_SEGMENTS = 200;

/**
 * 音色与情绪的枚举单源:校验、状态接口、设置页下拉都从这里取,
 * 避免前端和后端各写一份清单再慢慢漂移。
 */
export const YUKKURI_VOICE_IDS = [
  "f1", "f2", "f3", "m1", "m2", "r1", "r2",
  "reimu", "marisa", "cirno",
] as const;
export const YUKKURI_EMOTION_IDS = [
  "neutral", "happy", "angry", "sad", "surprised", "shy", "sleepy",
] as const;

const KNOWN_VOICES = new Set<string>(YUKKURI_VOICE_IDS);
const KNOWN_EMOTIONS = new Set<string>(YUKKURI_EMOTION_IDS);

const cache = new LruCache<Buffer>(CACHE_CAPACITY);

function cacheKey(text: string, s: YukkuriSynthesisSettings): string {
  const payload = [
    s.sdkPath?.trim() || "(default)",
    s.voice || "f1",
    s.emotion || "neutral",
    String(s.speed ?? 1),
    String(s.pitch ?? 1),
    text,
  ].join("\u0000");
  return createHash("sha1").update(payload, "utf8").digest("hex");
}

/** 声种/角色 + 情绪 + 倍速倍音高 → 引擎那 7 个整数参数。 */
export function voiceParamsFor(s: YukkuriSynthesisSettings) {
  const voice = resolveVoice(s.voice || "f1", s.emotion || "neutral");
  const speed = Number.isFinite(s.speed) ? (s.speed as number) : 1;
  const pitch = Number.isFinite(s.pitch) ? (s.pitch as number) : 1;
  if (Number.isFinite(speed) && speed > 0 && speed !== 1) {
    voice.spd = clampVoiceParam("spd", voice.spd * speed);
  }
  if (Number.isFinite(pitch) && pitch > 0 && pitch !== 1) {
    voice.pit = clampVoiceParam("pit", voice.pit * pitch);
  }
  return voice;
}

export async function synthesizeYukkuri(
  text: string,
  settings: YukkuriSynthesisSettings = {},
): Promise<YukkuriSynthesisResult> {
  // 先校验 SDK:缺件要在任何 DLL 调用之前变成一句人话。
  const paths = requireSdk(settings.sdkPath);

  const readable = extractReadableText(text);
  if (!readable) throw new Error("没有可朗读的文本(代码块与表格不会被朗读)");

  const pieces = segment(readable, { maxKana: settings.maxKana });
  if (pieces.length === 0) throw new Error("没有可朗读的文本");
  const truncated = pieces.length > MAX_SEGMENTS;
  const targets = truncated ? pieces.slice(0, MAX_SEGMENTS) : pieces;

  const useCache = !settings.noCache;
  const key = useCache ? cacheKey(readable, settings) : "";
  if (useCache) {
    const hit = cache.get(key);
    if (hit) {
      return {
        audio: Buffer.from(hit),
        mime: "audio/wav",
        segments: 0,
        seconds: wavSeconds(hit),
        skipped: 0,
        fromCache: true,
      };
    }
  }

  const synth = getSynth(paths);
  const k2k = getK2k(paths);
  const voice = voiceParamsFor(settings);

  const clips: Buffer[] = [];
  let skipped = 0;
  let lastError: unknown = null;

  for (const piece of targets) {
    try {
      const koe = k2k.convert(await prepareText(piece));
      if (!koe.trim()) throw new Error(`无法转换为音声記号列:${piece.slice(0, 24)}`);
      clips.push(synth.synthe(koe, voice));
    } catch (err) {
      // 一段念不出来不该毁掉整轮:跳过它,把错误留着,全失败时才交代。
      skipped += 1;
      lastError = err;
      console.warn(`[yukkuri] 跳过一段合成失败的文字(${piece.slice(0, 24)}):`, err);
    }
  }

  if (clips.length === 0) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "未知错误");
    throw new Error(`油库里合成失败:${detail}`);
  }

  const audio = concatWavs(clips);
  if (useCache) cache.set(key, audio);

  return {
    audio: Buffer.from(audio),
    mime: "audio/wav",
    segments: clips.length,
    seconds: wavSeconds(audio),
    skipped: skipped + (truncated ? pieces.length - MAX_SEGMENTS : 0),
    fromCache: false,
  };
}

/**
 * 提前把 DLL 与词典打开,别让第一句朗读付这个代价。
 * 后端就绪时异步调用即可;失败只留日志,不影响其它功能。
 */
export async function warmupYukkuri(sdkPath?: string | null): Promise<boolean> {
  try {
    const paths = requireSdk(sdkPath);
    getSynth(paths);
    getK2k(paths);
    return true;
  } catch (err) {
    console.warn("[yukkuri] 预热跳过:", err);
    return false;
  }
}

/** 设置页/自检用:SDK 现状 + 可用音色。不抛错。 */
export function yukkuriStatus(sdkPath?: string | null) {
  return {
    sdk: describeSdk(sdkPath),
    voices: [...YUKKURI_VOICE_IDS],
    emotions: [...YUKKURI_EMOTION_IDS],
  };
}

export function isKnownVoice(value: string): boolean {
  return KNOWN_VOICES.has(value);
}

export function isKnownEmotion(value: string): boolean {
  return KNOWN_EMOTIONS.has(value);
}

/** 改了 SDK 路径或后端退出时调用:关掉句柄、清掉缓存,下次合成重新开。 */
export function resetYukkuri(): void {
  closeEngines();
  cache.clear();
}

export { AQTK10_ERRORS, K2K_ERRORS } from "./engine";
export { listYukkuriVoices } from "./voices";
export type { AqtkVoice } from "./engine";
