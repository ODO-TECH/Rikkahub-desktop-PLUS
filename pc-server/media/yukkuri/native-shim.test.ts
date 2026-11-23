// media/yukkuri/native-shim.test.ts — 只在随包布局存在时才动 process.resourcesPath
// 这条纪律防的是「源码运行时被我们改坏」:bun 直接跑 server.ts 时 koffi 靠 node_modules
// 解析就能命中,此时 shim 必须一步都不做。
// 「便携布局命中」那一支由 scripts/sync-dist-assets.ts + 编译产物冒烟覆盖(见交付说明),
// 这里不伪造 process.execPath —— 伪造出来的分支跑不到真加载器,测了也是假绿。
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { ensureKoffiNativePath } from "./native-shim";

const holder = process as unknown as { resourcesPath?: string };
const layoutNextToRunner = existsSync(join(dirname(process.execPath), "koffi", "build", "win32_x64", "koffi.node"));

test("测试宿主(bun 直跑)旁边没有随包布局 → 返回 null 且不写 resourcesPath", () => {
  expect(layoutNextToRunner).toBe(false);
  const before = holder.resourcesPath;
  expect(ensureKoffiNativePath()).toBeNull();
  expect(holder.resourcesPath).toBe(before);
});
