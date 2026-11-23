// media/yukkuri/keys.test.ts — 许可证密钥现算(移植保真锁)
// 期望值是 reference/dsh-yukkuli 的 kg.js 在本机跑出来的原样输出:密钥算法是「逆 DecryptLicenseKey」,
// 逐轮右旋/异或任何一处抄错都会让 DLL 回 rc≠0,而 DLL 的报错只说「被拒绝」,极难反推。
// 所以这几个常量就是移植的对错判据,不是随便写的快照。

import { expect, test } from "bun:test";
import { dashed, encryptLicenseKey, formatKey, generateDevKey, generateUsrKey, resolveKeys } from "./keys";

test("dev key / usr key 与上游逐字一致", () => {
  expect(generateDevKey("tk10")).toBe("E0A8-2620-8834-2809");
  expect(generateUsrKey("tk10")).toBe("AC13-1236-D79A-958E");
  expect(generateDevKey("k2k")).toBe("6044-9A95-8901-1638");
  expect(generateDevKey("aqtk1")).toBe("92C8-F818-DC66-ED37");
});

test("密钥形态:4 段 4 位大写十六进制", () => {
  expect(generateDevKey("tk10")).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  expect(formatKey(0x0102030405060708n)).toBe("0102030405060708");
  expect(dashed("AAAABBBBCCCCDDDD")).toBe("AAAA-BBBB-CCCC-DDDD");
});

test("版本号越界要拦住(学习版密钥的门槛位)", () => {
  expect(() => generateDevKey("tk10", { version: 0x09 })).toThrow("version out of range");
  expect(() => generateDevKey("tk10", { version: 0x100 })).toThrow("version out of range");
  expect(() => generateDevKey("nope" as "tk10")).toThrow("unknown module");
  // AqKanji2Koe 没有 usr key 这种形态
  expect(() => generateUsrKey("k2k")).toThrow("unknown module");
});

test("正式授权经环境变量覆盖,代码不用动", () => {
  const previous = process.env.RIKKAHUB_YUKKURI_AQK2K_DEV_KEY;
  process.env.RIKKAHUB_YUKKURI_AQK2K_DEV_KEY = "AAAA-BBBB-CCCC-DDDD";
  try {
    expect(resolveKeys().k2k).toBe("AAAA-BBBB-CCCC-DDDD");
    // 其余两把没设 → 仍然是现算的学习版
    expect(resolveKeys().aqtk10).toBe(generateDevKey("tk10"));
  } finally {
    if (previous === undefined) delete process.env.RIKKAHUB_YUKKURI_AQK2K_DEV_KEY;
    else process.env.RIKKAHUB_YUKKURI_AQK2K_DEV_KEY = previous;
  }
});

test("encryptLicenseKey 是纯位运算:同输入同输出、64 位内回绕", () => {
  expect(encryptLicenseKey(0n)).toBe(encryptLicenseKey(0n));
  expect(encryptLicenseKey(0x1234_5678_9abc_def0n)).toBe(encryptLicenseKey(0x1234_5678_9abc_def0n));
  // 掩码保证结果不超过 uint64
  expect(encryptLicenseKey(-1n) & 0xffffffffffffffffn).toBe(encryptLicenseKey(-1n));
});
