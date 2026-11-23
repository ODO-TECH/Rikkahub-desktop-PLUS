// media/yukkuri/wav.test.ts — WAV 头处理(时长、音高、分段合并)
// 锁的是「只动头部」这件事:任何对采样数据的处理都会把几毫秒的合成拖成 CPU 大户。
import { expect, test } from "bun:test";
import { concatWavs, shiftPitch, wavInfo, wavSeconds } from "./wav";

function fakeWav(hz: number, sampleCount: number, channels = 1, bits = 16): Buffer {
  const bytesPerFrame = (bits / 8) * channels;
  const pcm = Buffer.alloc(sampleCount * bytesPerFrame, 0x7f);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(hz, 24);
  header.writeUInt32LE(Math.round(hz * bytesPerFrame), 28);
  header.writeUInt16LE(bytesPerFrame, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

test("时长从头部算,不猜固定采样率", () => {
  const f3 = wavInfo(fakeWav(23680, 23680)); // F3(琪露诺)的真实输出率
  expect(f3.hz).toBe(23680);
  expect(f3.seconds).toBeCloseTo(1, 3);
  expect(wavSeconds(fakeWav(16000, 8000))).toBeCloseTo(0.5, 3);
  expect(wavInfo(fakeWav(16000, 16000, 2)).channels).toBe(2);
});

test("不是 WAV 就不猜(远端错误页、截断文件)", () => {
  expect(wavInfo(Buffer.from("<html>oops</html>"))).toEqual({ hz: 0, channels: 0, bits: 0, seconds: 0 });
  expect(wavInfo(Buffer.alloc(44))).toEqual({ hz: 0, channels: 0, bits: 0, seconds: 0 });
  expect(wavSeconds(Buffer.alloc(0))).toBe(0);
});

test("shiftPitch 只改采样率字段,并且不改原 Buffer", () => {
  const src = fakeWav(16000, 16000);
  const out = shiftPitch(src, 1.04);
  expect(out.readUInt32LE(24)).toBe(16640);
  expect(src.readUInt32LE(24)).toBe(16000);
  expect(out.length).toBe(src.length);
  expect(out.subarray(44)).toEqual(src.subarray(44)); // 采样数据一个字节没动
  expect(shiftPitch(src, 1)).toBe(src);
});

test("shiftPitch 拒绝非正倍数,非 WAV 原样返回", () => {
  expect(() => shiftPitch(fakeWav(16000, 100), 0)).toThrow(/pitch/);
  expect(() => shiftPitch(fakeWav(16000, 100), -1)).toThrow(/pitch/);
  const junk = Buffer.from("not-a-wav-at-all-x");
  expect(shiftPitch(junk, 1.2)).toBe(junk);
});

test("分段合并:头部两个长度字段按合并后的 PCM 重写", () => {
  const a = fakeWav(16000, 1600);
  const b = fakeWav(16000, 800);
  const merged = concatWavs([a, b]);
  expect(merged.length).toBe(44 + 1600 * 2 + 800 * 2);
  expect(merged.readUInt32LE(4)).toBe(36 + merged.length - 44);
  expect(merged.readUInt32LE(40)).toBe(merged.length - 44);
  expect(wavSeconds(merged)).toBeCloseTo(0.15, 3);
});

test("分段合并:空输入与单段、以及采样率不一致要如实报错", () => {
  expect(concatWavs([]).length).toBe(0);
  const single = fakeWav(16000, 100);
  expect(concatWavs([single])).toBe(single);
  // 短于头的碎片被忽略(引擎不会产出,但调用方传脏数据时不该拼出坏头)
  expect(concatWavs([single, Buffer.alloc(10)]).length).toBe(single.length);
  expect(() => concatWavs([fakeWav(16000, 100), fakeWav(22050, 100)])).toThrow(/采样率不一致/);
  expect(concatWavs([Buffer.from("junk-bytes-longer-than-a-header-for-sure")]).length).toBe(0);
});
