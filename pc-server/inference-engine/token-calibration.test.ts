// inference-engine/token-calibration.test.ts — 用量自校准 k̂ 契约(S2)
//
// 锁定"学坏了反而更糟"的每一道闸:
//   - 准入区间 [0.2, 5]:超出视为配对错误,丢弃而不是钳进去;
//   - 单样本不发布;两样本互差 >×2 不发布;
//   - 发布值钳在 [0.25, 4];离群样本不带偏一致簇;
//   - 环长 ≤8,超出丢最旧;
//   - estimated 兜底 usage 不产样本;只配对本轮第一次 usage;
//   - 无样本 → 1.0(判定与引入前逐字节一致);
//   - 落盘/读回一致,坏文件降级为"没有校准"。

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 校准环会落盘:必须在任何业务模块加载前把 dataDir 指到临时目录,绝不碰用户真实 pc-data。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-token-calibration-"));

const { tokenCalibrationPath } = await import("../foundation/paths");
const {
  CALIBRATION_ADMIT_MAX,
  CALIBRATION_ADMIT_MIN,
  CALIBRATION_PUBLISH_MAX,
  CALIBRATION_PUBLISH_MIN,
  CALIBRATION_RING_MAX,
  appendCalibrationSample,
  calibrationFactorFor,
  calibrationKey,
  calibrationRatio,
  flushTokenCalibration,
  learnFromUsage,
  noteOutboundEstimate,
  publishCalibrationFactor,
  recordCalibrationSample,
  resetTokenCalibration,
  takeOutboundEstimate,
} = await import("./token-calibration");

const sample = (local: number, billed: number) => ({ local, billed, at: 0 });

/** 每个用例前后都清内存态与磁盘文件:校准是全局单例,串味会让断言互相污染。 */
function clean(): void {
  resetTokenCalibration();
  if (existsSync(tokenCalibrationPath)) rmSync(tokenCalibrationPath, { force: true });
}

afterEach(clean);

describe("准入(calibrationRatio)", () => {
  test("区间内的比值原样返回", () => {
    expect(calibrationRatio(1000, 1200)).toBeCloseTo(1.2, 6);
    expect(calibrationRatio(1000, 1000)).toBe(1);
  });

  test("区间外一律拒收(配对错误,不是模型特性)", () => {
    expect(calibrationRatio(1000, 100)).toBeNull(); // 0.1 < 0.2
    expect(calibrationRatio(1000, 10000)).toBeNull(); // 10 > 5
    expect(CALIBRATION_ADMIT_MIN).toBe(0.2);
    expect(CALIBRATION_ADMIT_MAX).toBe(5);
  });

  test("零/负/非有限输入拒收", () => {
    expect(calibrationRatio(0, 100)).toBeNull();
    expect(calibrationRatio(100, 0)).toBeNull();
    expect(calibrationRatio(-1, 100)).toBeNull();
    expect(calibrationRatio(Number.NaN, 100)).toBeNull();
    expect(calibrationRatio(100, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("发布(publishCalibrationFactor)", () => {
  test("无样本 / 单样本 → 1(不发布)", () => {
    expect(publishCalibrationFactor([])).toBe(1);
    expect(publishCalibrationFactor([sample(1000, 1500)])).toBe(1);
  });

  test("两样本一致 → 发布中位数", () => {
    expect(publishCalibrationFactor([sample(1000, 1200), sample(2000, 2400)])).toBeCloseTo(1.2, 6);
  });

  test("两样本互差 >×2 → 不发布(方差没收敛,给假精确不如给 1)", () => {
    expect(publishCalibrationFactor([sample(1000, 500), sample(1000, 2000)])).toBe(1);
  });

  test("恰好 ×2 边界算一致", () => {
    expect(publishCalibrationFactor([sample(1000, 1000), sample(1000, 2000)])).toBeCloseTo(1.5, 6);
  });

  test("离群样本不带偏一致簇:取最大一致簇的中位数", () => {
    const samples = [
      sample(1000, 1200),
      sample(1000, 1250),
      sample(1000, 1300),
      sample(1000, 4800), // 离群(与 1.2 差 4 倍)
    ];
    expect(publishCalibrationFactor(samples)).toBeCloseTo(1.25, 6);
  });

  test("发布值钳在 [0.25, 4]", () => {
    expect(publishCalibrationFactor([sample(1000, 210), sample(1000, 220)])).toBe(CALIBRATION_PUBLISH_MIN);
    expect(publishCalibrationFactor([sample(1000, 4800), sample(1000, 4900)])).toBe(CALIBRATION_PUBLISH_MAX);
    expect(CALIBRATION_PUBLISH_MIN).toBe(0.25);
    expect(CALIBRATION_PUBLISH_MAX).toBe(4);
  });

  test("准入外的样本不参与发布(不是被钳,是被丢)", () => {
    expect(publishCalibrationFactor([sample(1000, 10), sample(1000, 20)])).toBe(1);
  });
});

describe("样本环(appendCalibrationSample)", () => {
  test("超过环长丢最旧,不改传入数组", () => {
    let ring = [] as ReturnType<typeof appendCalibrationSample>;
    const original = ring;
    for (let index = 0; index < CALIBRATION_RING_MAX + 3; index += 1) {
      ring = appendCalibrationSample(ring, sample(1000, 1000 + index));
    }
    expect(ring).toHaveLength(CALIBRATION_RING_MAX);
    expect(ring[0]!.billed).toBe(1003);
    expect(original).toHaveLength(0);
  });
});

describe("运行时存取", () => {
  test("无样本 → 1.0;键按 provider::model 隔离", () => {
    clean();
    expect(calibrationFactorFor("p1", "m1")).toBe(1);
    recordCalibrationSample("p1", "m1", 1000, 1500);
    recordCalibrationSample("p1", "m1", 2000, 3000);
    expect(calibrationFactorFor("p1", "m1")).toBeCloseTo(1.5, 6);
    expect(calibrationFactorFor("p1", "m2")).toBe(1);
    expect(calibrationFactorFor("p2", "m1")).toBe(1);
    expect(calibrationKey("p1", "m1")).toBe("p1::m1");
  });

  test("准入外的样本不落环,系数保持 1", () => {
    clean();
    recordCalibrationSample("p1", "m1", 1000, 10);
    recordCalibrationSample("p1", "m1", 1000, 99999);
    expect(calibrationFactorFor("p1", "m1")).toBe(1);
  });

  test("落盘后读回一致;文件里的 factor 不被信任,按样本重算", () => {
    clean();
    recordCalibrationSample("p1", "m1", 1000, 1200);
    recordCalibrationSample("p1", "m1", 1000, 1300);
    flushTokenCalibration();
    expect(existsSync(tokenCalibrationPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(tokenCalibrationPath, "utf8"));
    expect(onDisk["p1::m1"].samples).toHaveLength(2);
    // 手改一个荒谬的 factor,读回时必须被样本重算覆盖。
    onDisk["p1::m1"].factor = 999;
    writeFileSync(tokenCalibrationPath, JSON.stringify(onDisk));
    resetTokenCalibration();
    expect(calibrationFactorFor("p1", "m1")).toBeCloseTo(1.25, 6);
  });

  test("坏文件降级为没有校准,不抛", () => {
    clean();
    writeFileSync(tokenCalibrationPath, "{ this is not json");
    resetTokenCalibration();
    expect(() => calibrationFactorFor("p1", "m1")).not.toThrow();
    expect(calibrationFactorFor("p1", "m1")).toBe(1);
  });

  test("空 provider/model 不写不读", () => {
    clean();
    recordCalibrationSample("", "m1", 1000, 1200);
    recordCalibrationSample("p1", "", 1000, 1200);
    expect(calibrationFactorFor("", "m1")).toBe(1);
    expect(calibrationFactorFor("p1", "")).toBe(1);
  });
});

describe("出站估算 ↔ usage 配对", () => {
  test("第一次 usage 配成样本,后续轮取不到(口径不同源)", () => {
    clean();
    noteOutboundEstimate("c1", "p1", "m1", 1000);
    expect(learnFromUsage("c1", { promptTokens: 1200 })).toBe(true);
    expect(learnFromUsage("c1", { promptTokens: 1200 })).toBe(false);
    expect(takeOutboundEstimate("c1")).toBeNull();
    // 再来一轮一致样本 → 发布。
    noteOutboundEstimate("c1", "p1", "m1", 1000);
    expect(learnFromUsage("c1", { promptTokens: 1200 })).toBe(true);
    expect(calibrationFactorFor("p1", "m1")).toBeCloseTo(1.2, 6);
  });

  test("estimated 兜底载荷拒收(拿估算校准估算是自证循环)", () => {
    clean();
    noteOutboundEstimate("c1", "p1", "m1", 1000);
    expect(learnFromUsage("c1", { promptTokens: 1200, estimated: true })).toBe(false);
    // 拒收不消耗登记:真实 usage 后到时仍能配上。
    expect(learnFromUsage("c1", { promptTokens: 1200 })).toBe(true);
  });

  test("缺 promptTokens / 非对象载荷不产样本", () => {
    clean();
    noteOutboundEstimate("c1", "p1", "m1", 1000);
    expect(learnFromUsage("c1", null)).toBe(false);
    expect(learnFromUsage("c1", { completionTokens: 500 })).toBe(false);
    expect(learnFromUsage("c1", { promptTokens: 0 })).toBe(false);
  });

  test("没有登记过的会话不产样本", () => {
    clean();
    expect(learnFromUsage("never-sent", { promptTokens: 1200 })).toBe(false);
  });

  test("同一会话再次生成覆盖旧登记(只留最近一次)", () => {
    clean();
    noteOutboundEstimate("c1", "p1", "m1", 1000);
    noteOutboundEstimate("c1", "p1", "m1", 5000);
    const taken = takeOutboundEstimate("c1");
    expect(taken?.local).toBe(5000);
  });

  test("非法本地估算不登记", () => {
    clean();
    noteOutboundEstimate("c1", "p1", "m1", 0);
    noteOutboundEstimate("c1", "p1", "m1", Number.NaN);
    expect(takeOutboundEstimate("c1")).toBeNull();
  });
});