// media/asr-deepseek.test.ts — DeepSeek ASR(官方 /v1/tools/asr)协议与分段上限的行为锁。
// 本地 stub 取代真实服务,验证与安卓 DeepSeekASRController 同款的口径:
//   · multipart 只带 file 一个字段(官方文档:多发字段直接 400)、Authorization: Bearer
//   · 响应顶层 text;非 2xx 抛 "DeepSeek ASR failed"
//   · 文件转写只接受 16-bit PCM WAV / Ogg Opus,且上传前就挡掉 120 秒 / 8 MiB 超限
//   · 实时听写沿用 HTTP 分段家族机器(攒 PCM → 补 WAV 头 → 分段上传 → 顺序拼接)
// 纪律:不桩任何模块。bun 1.4.2 的 mock.module 是进程级注册表、会泄漏进后续测试文件
// (见 media/ocr.test.ts 同款说明),而这里需要的只是「addLog 别炸」——给它真实的
// stats/logs 最小形状 + 临时数据目录即可。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-asr-deepseek-test-"));

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { setState } = await import("../persistence/json-store");
const {
  asrRealtimeSessions,
  isSegmentedHttpAsr,
  segmentedAsrSegmentBytes,
  sendAsrAudio,
  startAsrRealtimeSession,
  stopAsrRealtimeSession,
  transcribeAudioWithAsrProvider,
} = await import("./asr");

const requests: Array<{ url: string; headers: Record<string, string>; fields: string[]; name: string; head: number[]; bytes: number }> = [];
let reply: Record<string, unknown> = { request_id: "req-1", text: "你好世界", duration_ms: 3200 };
let failStatus = 0;

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const form = await request.formData().catch(() => null);
    const entries = form ? [...form.entries()] : [];
    const filePart: unknown = entries.find(([key]) => key === "file")?.[1];
    const bytes = filePart instanceof File || filePart instanceof Blob ? new Uint8Array(await filePart.arrayBuffer()) : new Uint8Array();
    requests.push({
      url: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers),
      fields: entries.map(([key]) => key),
      name: filePart instanceof File ? filePart.name : "",
      head: [...bytes.slice(0, 44)],
      bytes: bytes.length,
    });
    if (failStatus) {
      return new Response(JSON.stringify({ error: { message: "Insufficient Balance" } }), { status: failStatus, headers: { "Content-Type": "application/json" } });
    }
    return Response.json(reply);
  },
});

function configure(overrides: Record<string, unknown> = {}) {
  const provider = {
    type: "deepseek",
    id: "ds1",
    name: "DeepSeek ASR",
    apiKey: "secret-key",
    websocketUrl: "",
    baseUrl: `http://127.0.0.1:${server.port}`,
    sampleRate: 16000,
    segmentDurationSec: 30,
    ...overrides,
  };
  setState({
    logs: [],
    stats: { totalRequests: 0, failedRequests: 0, byProvider: {}, byGroup: {} },
    settings: { asrProviders: [provider], selectedASRProviderId: "ds1", proxyConfig: undefined },
  } as any);
  return provider;
}

/** 16-bit PCM mono 裸流 + 44 字节 RIFF 头(与 pcm16MonoToWav 同形态)。
 *  显式声明 Uint8Array<ArrayBuffer>:自有 ArrayBuffer 才是 TS 认可的 BlobPart。 */
function wavForSeconds(seconds: number, sampleRate = 16000): Uint8Array<ArrayBuffer> {
  const byteRate = sampleRate * 2;
  const pcm = new Uint8Array(Math.round(seconds * byteRate));
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

afterAll(async () => {
  server.stop(true);
  // addLog 走节流落盘:等它写完再删临时数据目录,免得测试结束后喷一条 ENOENT 噪声。
  await new Promise((resolve) => setTimeout(resolve, 260));
  rmSync(process.env.RIKKAHUB_PC_DATA_DIR!, { recursive: true, force: true });
});

test("文件转写:multipart 只带 file、Bearer 认证、取顶层 text", async () => {
  configure();
  requests.length = 0;
  reply = { request_id: "req-2", text: " 文件转写 ", duration_ms: 1500 };
  const file = new File([wavForSeconds(2)], "speech.wav", { type: "audio/wav" });
  const text = await transcribeAudioWithAsrProvider(file as any);
  expect(text).toBe("文件转写");
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("/v1/tools/asr");
  expect(requests[0].fields).toEqual(["file"]);
  expect(requests[0].name).toBe("speech.wav");
  expect(requests[0].headers.authorization).toBe("Bearer secret-key");
  expect(requests[0].bytes).toBe(44 + 2 * 32000);
});

test("文件转写:ogg/opus 直通,mp3/webm/m4a 上传前就拒绝", async () => {
  configure();
  requests.length = 0;
  const opus = new File([new Uint8Array(64)], "voice.ogg", { type: "audio/ogg" });
  await transcribeAudioWithAsrProvider(opus as any);
  expect(requests).toHaveLength(1);
  for (const [name, mime] of [["a.mp3", "audio/mpeg"], ["a.webm", "audio/webm"], ["a.m4a", "audio/mp4"]] as const) {
    await expect(transcribeAudioWithAsrProvider(new File([new Uint8Array(10)], name, { type: mime }) as any))
      .rejects.toThrow(/16-bit PCM WAV 或 Ogg Opus/);
  }
  expect(requests).toHaveLength(1); // 三家超格式的都没发出去
});

test("文件转写:官方单次上限在上传前挡下(120 秒 / 8 MiB)", async () => {
  configure();
  requests.length = 0;
  await expect(transcribeAudioWithAsrProvider(new File([wavForSeconds(122)], "long.wav", { type: "audio/wav" }) as any))
    .rejects.toThrow(/不能超过 120 秒/);
  await expect(transcribeAudioWithAsrProvider(new File([new Uint8Array(9 * 1024 * 1024)], "big.wav", { type: "audio/wav" }) as any))
    .rejects.toThrow(/不能超过 8 MiB/);
  expect(requests).toHaveLength(0);
});

test("文件转写:非 2xx 抛 DeepSeek ASR failed", async () => {
  configure();
  requests.length = 0;
  failStatus = 402;
  await expect(transcribeAudioWithAsrProvider(new File([wavForSeconds(1)], "a.wav", { type: "audio/wav" }) as any))
    .rejects.toThrow(/DeepSeek ASR failed: 402/);
  failStatus = 0;
});

test("实时听写:到阈值就分段上传,stop 冲刷尾段并按序拼接后推 idle", async () => {
  configure({ segmentDurationSec: 0.1 }); // 0.1s@16k = 3200 字节阈值(下限同为 3200)
  requests.length = 0;
  reply = { text: "第一段" };
  const messages: any[] = [];
  const client = { send: (raw: string) => messages.push(JSON.parse(raw)) };
  startAsrRealtimeSession(client, "ds1");
  expect(messages[0]).toEqual({ type: "status", status: "listening" });
  sendAsrAudio(asrRealtimeSessions.get(client)!, new Uint8Array(4800).buffer);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(requests).toHaveLength(1);
  expect(requests[0].fields).toEqual(["file"]);
  // 补头正确:RIFF/WAVE + 16000 Hz + mono + 16bit,data 段长度 = 实际 PCM 字节数
  const head = Buffer.from(requests[0].head);
  expect(head.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(head.readUInt32LE(24)).toBe(16000);
  expect(head.readUInt16LE(22)).toBe(1);
  expect(head.readUInt16LE(34)).toBe(16);
  expect(head.readUInt32LE(40)).toBe(3200);
  reply = { text: "第二段" };
  stopAsrRealtimeSession(client);
  const deadline = Date.now() + 3000;
  while (!messages.some((m) => m.type === "status" && m.status === "idle") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(requests).toHaveLength(2);
  expect(messages.at(-1)).toEqual({ type: "status", status: "idle" });
  const finalTranscript = [...messages].reverse().find((m) => m.type === "transcript")?.transcript;
  expect(finalTranscript).toBe("第一段 第二段");
});

test("分段字节数把两家官方上限编码进来(共用机器的差异点)", () => {
  // 30 秒 @16k = 960,000 字节:两家一致。
  const base = { type: "deepseek", id: "d", name: "n", apiKey: "k", websocketUrl: "", sampleRate: 16000 };
  expect(segmentedAsrSegmentBytes({ ...base, segmentDurationSec: 30 } as any)).toBe(960000);
  expect(segmentedAsrSegmentBytes({ ...base, type: "mimo", segmentDurationSec: 30 } as any)).toBe(960000);
  // 「0 = 只在停止时上传」时仍受各自硬上限:DeepSeek 压在 120 秒的 90%(108s×32000=3,456,000),
  // 而不是 MiMo 的 6 MiB——这条正是官方单次时长上限的防回归锁。
  expect(segmentedAsrSegmentBytes({ ...base, segmentDurationSec: 0 } as any)).toBe(3456000);
  expect(segmentedAsrSegmentBytes({ ...base, type: "mimo", segmentDurationSec: 0 } as any)).toBe(6 * 1024 * 1024);
  // 阈值恒为偶数:不会劈开 16-bit 采样点。
  for (const rate of [8000, 22050, 44100, 48000]) {
    expect(segmentedAsrSegmentBytes({ ...base, sampleRate: rate, segmentDurationSec: 5 } as any) % 2).toBe(0);
  }
});

test("分段家族判定:MiMo 与 DeepSeek 同一套机器,WebSocket 家不算", () => {
  expect(isSegmentedHttpAsr("mimo")).toBe(true);
  expect(isSegmentedHttpAsr("deepseek")).toBe(true);
  expect(isSegmentedHttpAsr("openai_realtime")).toBe(false);
  expect(isSegmentedHttpAsr("step")).toBe(false);
  expect(isSegmentedHttpAsr(undefined)).toBe(false);
});
