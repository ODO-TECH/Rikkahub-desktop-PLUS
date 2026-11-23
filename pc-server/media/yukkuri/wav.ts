// media/yukkuri/wav.ts — 油库里输出的 WAV 头处理
// 移植自 reference/dsh-yukkuli(core/src/wav.js + concatWavs 的合并语义)。
// 纪律:只碰 RIFF 头里那 4 个字节的事(采样率/长度),不解码采样数据 —— 合成一段只有几毫秒,
// 任何重采样都是白付的 CPU 与失真。

export interface WavInfo {
  hz: number;
  channels: number;
  bits: number;
  seconds: number;
}

const EMPTY: WavInfo = { hz: 0, channels: 0, bits: 0, seconds: 0 };
/** 标准 44 字节头 + PCM 的裸 WAV 才有得可读;AquesTalk 的输出正好是这一种。 */
const HEADER_BYTES = 44;

/**
 * 读 WAV 头。
 *
 * 为什么值得单独一个模块:AQTK10 的输出采样率**不是固定的**。fsc 参数直接改采样率
 * (16000 × fsc / 100),而 F3(琪露诺)的 fsc = 148 → 23680Hz。哪处硬编码 16000 算时长,
 * 那一处的秒数就跟界面对不上。
 */
export function wavInfo(buf: Buffer): WavInfo {
  if (!Buffer.isBuffer(buf) || buf.length <= HEADER_BYTES) return EMPTY;
  // 不是 RIFF 就不猜(远端返回错误页时正是这种情况)
  if (buf.slice(0, 4).toString() !== "RIFF") return EMPTY;

  const channels = buf.readUInt16LE(22) || 1;
  const hz = buf.readUInt32LE(24) || 16000;
  const bits = buf.readUInt16LE(34) || 16;
  const bytesPerFrame = (bits / 8) * channels;

  return { hz, channels, bits, seconds: (buf.length - HEADER_BYTES) / bytesPerFrame / hz };
}

/** 只要时长时用这个。 */
export function wavSeconds(buf: Buffer): number {
  return wavInfo(buf).seconds;
}

/**
 * 音高调整:改 WAV 头的采样率字段。
 *
 * AQTK1 / AQTK2 没有音高参数,只有速度。把采样率乘 N,播放器就以 N 倍速播 ——
 * 音高和语速同时乘 N(跟 AQTK10 的 fsc 是同一回事)。所以「音高 +4%、语速 −4%」
 * = speed 92 + pitch 1.04。只动 4 个字节,无失真、零 CPU。
 */
export function shiftPitch(buf: Buffer, factor: number): Buffer {
  if (!(factor > 0)) throw new Error(`pitch 必须是正数,收到: ${factor}`);
  if (!Buffer.isBuffer(buf) || buf.length <= HEADER_BYTES || buf.slice(0, 4).toString() !== "RIFF") {
    return buf;
  }
  if (factor === 1) return buf;

  const out = Buffer.from(buf);
  const hz = out.readUInt32LE(24) || 16000;
  out.writeUInt32LE(Math.round(hz * factor), 24);
  return out;
}

/**
 * 把多段 WAV 接成一整条(朗读一轮回复时按标点切段,播完要还是一条音频)。
 *
 * 前提:同一轮合成的参数一致 → 采样率/声道/位深相同(F3 那 23680Hz 会整轮一致)。
 * 真出现不一致就是调用方的 bug,这里如实报错而不是硬拼出一条变速的音频。
 */
export function concatWavs(parts: Buffer[]): Buffer {
  const clips = parts.filter((p) => Buffer.isBuffer(p) && p.length > HEADER_BYTES);
  if (clips.length === 0) return Buffer.alloc(0);
  if (clips.length === 1) return clips[0]!;

  const head = wavInfo(clips[0]!);
  if (head.hz === 0) throw new Error("油库里分段音频不是可解析的 WAV,无法拼接");
  for (const clip of clips.slice(1)) {
    const info = wavInfo(clip);
    if (info.hz !== head.hz || info.channels !== head.channels || info.bits !== head.bits) {
      throw new Error(`分段音频采样率不一致(${head.hz}Hz / ${info.hz}Hz),无法拼接`);
    }
  }

  const pcm = clips.map((clip) => clip.subarray(HEADER_BYTES));
  const body = Buffer.concat(pcm);
  // 头取第一段的(前 44 字节),两个长度字段按合并后的 PCM 重写
  const header = Buffer.from(clips[0]!.subarray(0, HEADER_BYTES));
  header.writeUInt32LE(36 + body.length, 4); // RIFF chunk size
  header.writeUInt32LE(body.length, 40); // data chunk size
  return Buffer.concat([header, body]);
}
