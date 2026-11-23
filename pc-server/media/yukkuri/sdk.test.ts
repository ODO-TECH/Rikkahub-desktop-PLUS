// media/yukkuri/sdk.ts 的定位与自检测试
// 随包 SDK 之后,「留空能不能出声」完全取决于这里的优先级语义,所以每一档都要钉住:
// 显式配置 > 环境变量 > 随包 yukkuri-sdk/ > ~/yukkuri-sdk。
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { yukkuriSdkDir } from "../../foundation/paths";
import { describeSdk, requireSdk, resolveSdkRoot, sdkPaths } from "./sdk";

function scratchRoot(): string {
  return mkdtempSync(join(tmpdir(), "rkh-yukkuri-sdk-"));
}

test("显式配置压过环境变量,环境变量压过随包", () => {
  const previous = process.env.RIKKAHUB_YUKKURI_SDK_ROOT;
  process.env.RIKKAHUB_YUKKURI_SDK_ROOT = "/env/pointing/here";
  try {
    expect(resolveSdkRoot("/explicit/here").root).toBe("/explicit/here");
    expect(resolveSdkRoot("  ")).toEqual({ root: "/env/pointing/here", from: "env" });
  } finally {
    if (previous === undefined) delete process.env.RIKKAHUB_YUKKURI_SDK_ROOT;
    else process.env.RIKKAHUB_YUKKURI_SDK_ROOT = previous;
  }
});

test("两者都没设时:随包目录在就走随包,不在才回落到主目录", () => {
  const previous = process.env.RIKKAHUB_YUKKURI_SDK_ROOT;
  delete process.env.RIKKAHUB_YUKKURI_SDK_ROOT;
  try {
    const resolved = resolveSdkRoot(null);
    const bundledShipped = existsSync(join(yukkuriSdkDir, "aqtk10_win"));
    if (bundledShipped) {
      expect(resolved).toEqual({ root: yukkuriSdkDir, from: "bundled" });
    } else {
      expect(resolved.from).toBe("default");
      expect(resolved.root).toBe(join(homedir(), "yukkuri-sdk"));
    }
  } finally {
    if (previous !== undefined) process.env.RIKKAHUB_YUKKURI_SDK_ROOT = previous;
  }
});

test("sdkPaths 的目录结构与官方 SDK 压缩包一致", () => {
  const paths = sdkPaths("/root");
  expect(paths.aqtk10Dll).toBe(join("/root", "aqtk10_win", "lib64", "AquesTalk.dll"));
  expect(paths.k2kDll).toBe(join("/root", "aqk2k_win", "lib64", "AqKanji2Koe.dll"));
  expect(paths.k2kDicFile).toBe(join("/root", "aqk2k_win", "aq_dic", "aqdic.bin"));
});

test("缺件时 hint 只列真正缺的那几件(全缺/缺一件两种)", () => {
  const windows = process.platform === "win32";
  const empty = scratchRoot();
  try {
    const all = describeSdk(empty);
    expect(all.ready).toBe(false);
    if (windows) {
      expect(all.hint).toContain("AquesTalk.dll");
      expect(all.hint).toContain("AqKanji2Koe.dll");
      expect(all.hint).toContain("aqdic.bin");
    } else {
      // 非 Windows 的提示先说明平台不支持;缺件清单只用于 Windows 上的排查。
      expect(all.hint).toContain("Windows x64");
    }

    mkdirSync(join(empty, "aqtk10_win", "lib64"), { recursive: true });
    writeFileSync(join(empty, "aqtk10_win", "lib64", "AquesTalk.dll"), "stub");
    const partial = describeSdk(empty);
    expect(partial.aqtk10).toBe(true);
    expect(partial.k2k).toBe(false);
    if (windows) {
      expect(partial.hint).not.toContain("AquesTalk.dll");
      expect(partial.hint).toContain("AqKanji2Koe.dll");
    } else {
      expect(partial.hint).toContain("Windows x64");
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("非 ASCII 目录被点名,而不是等 DLL 回 err=200", () => {
  const status = describeSdk(join(homedir(), "油库里"));
  expect(status.rootIsAscii).toBe(false);
  expect(status.ready).toBe(false);
  if (process.platform === "win32") expect(status.hint).toContain("ASCII");
  else expect(status.hint).toContain("Windows x64");
});

test("requireSdk 就绪时给出路径,未就绪时把缺件说成一句人话", () => {
  const ready = describeSdk(null);
  if (ready.ready) {
    expect(sdkPaths(ready.root).aqtk10Dll).toBe(requireSdk(null).aqtk10Dll);
  } else {
    expect(() => requireSdk(join(homedir(), "rikkahub-yukkuri-absent"))).toThrow(/油库里合成不可用/);
  }
});
