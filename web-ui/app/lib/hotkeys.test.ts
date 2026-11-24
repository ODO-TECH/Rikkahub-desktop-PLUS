import { describe, expect, test } from "bun:test";
import { isMacPlatform } from "./hotkeys";

describe("快捷键的平台显示", () => {
  test("macOS 用 NavigatorUAData 的平台标识", () => {
    expect(isMacPlatform("macOS", "Win32")).toBe(true);
  });

  test("旧浏览器回退到 navigator.platform", () => {
    expect(isMacPlatform(undefined, "MacIntel")).toBe(true);
    expect(isMacPlatform(undefined, "Win32")).toBe(false);
  });

  test("服务器构建没有 navigator 时使用通用桌面格式", () => {
    const modulePath = new URL("./hotkeys.ts", import.meta.url).href;
    const script = `
      delete globalThis.navigator;
      const hotkeys = await import(${JSON.stringify(modulePath)});
      console.log(JSON.stringify({mac: hotkeys.IS_MAC_PLATFORM, binding: hotkeys.formatBinding(["Ctrl", "Shift", "F"])}));
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ mac: false, binding: "Ctrl+Shift+F" });
  });
});
