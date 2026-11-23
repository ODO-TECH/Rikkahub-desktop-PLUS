// media/yukkuri/keys.ts — AquesTalk 许可证密钥现算
// 算法移植自 reference/dsh-yukkuli(core/src/kg.js),后者又是 yukumo-group/AquesPy 的
// kg.py(DecryptLicenseKey 的逆运算:逐轮右旋 3 位 + 查表回填 + 异或掩码)的移植。
// 纪律:密钥不落盘、不写进任何文件,每次启动现算;拿到正式授权后把
// RIKKAHUB_YUKKURI_*_KEY 设上即可覆盖,代码不用动。

const TABLE = [7, 2, 4, 0, 1, 5, 3, 6];
const XOR = 0xd271ba9df61eed07n;
const ROUNDS = 0x56f; // 1391
const MASK64 = 0xffffffffffffffffn;

const DEV_PRODUCT = 0x5856; // "XV"
const USR_PRODUCT = 0x0517;

type Module = "tk10" | "k2k" | "aqtk1";

/** [kind, versionMin] */
const DEV_MODULES: Record<Module, readonly [number, number]> = {
  aqtk1: [0x6e, 0x14],
  k2k: [0xc8, 0x29],
  tk10: [0x64, 0x0a],
};

const USR_MODULES: Partial<Record<Module, readonly [number, number]>> = {
  aqtk1: [0x6e, 0x14],
  tk10: [0x64, 0x0a],
};

function signedChar(x: number): number {
  const byte = x & 0xff;
  return byte < 128 ? byte : byte - 256;
}

export function encryptLicenseKey(plain: bigint): bigint {
  let v = plain & MASK64;
  for (let i = ROUNDS - 1; i >= 0; i--) {
    const low = Number(v & 7n);
    const v3 = (low + signedChar(i) + 2) & 7;
    const top = BigInt(TABLE[v3]!);
    v = ((v >> 3n) | (top << 61n)) & MASK64;
  }
  return v ^ XOR;
}

/** plain(uint64) → 16 位大写十六进制 */
export function formatKey(value: bigint): string {
  return (value & MASK64).toString(16).toUpperCase().padStart(16, "0");
}

/**
 * dev key 的 plain 布局:[0]=kind [1]=version [2:5]=mid [6:7]=product。
 * 不传 version 时用该模块的最低版本 —— 学习版密钥要的只是「版本不低于门槛」。
 */
export function devPlain(module: Module, version: number | null = null, mid = 0): bigint {
  const entry = DEV_MODULES[module];
  if (!entry) throw new Error(`unknown module: ${module}`);
  const [kind, versionMin] = entry;
  const v = version ?? versionMin;
  if (v < versionMin || v > 0xff) throw new Error("version out of range");

  return (
    BigInt(kind) |
    (BigInt(v) << 8n) |
    (BigInt(mid & 0xffffffff) << 16n) |
    (BigInt(DEV_PRODUCT) << 48n)
  );
}

/** usr key 的 plain 布局:[2:3]=day [4:5]=usr_data [6:7]=product。 */
export function usrPlain(
  module: Module,
  { usrData = 0x0fff, days = 0 }: { usrData?: number; days?: number } = {},
): bigint {
  const entry = USR_MODULES[module];
  if (!entry) throw new Error(`unknown module: ${module}`);
  const [kind, versionMin] = entry;

  return (
    BigInt(kind) |
    (BigInt(versionMin) << 8n) |
    (BigInt(days & 0xffff) << 16n) |
    (BigInt(usrData & 0xffff) << 32n) |
    (BigInt(USR_PRODUCT) << 48n)
  );
}

/** 16 位十六进制 → 4 段连字符形式(SDK 文档里的呈现格式) */
export function dashed(hex: string): string {
  return hex.match(/.{4}/g)!.join("-");
}

export function generateDevKey(module: Module, opts: { version?: number; mid?: number } = {}): string {
  return dashed(formatKey(encryptLicenseKey(devPlain(module, opts.version ?? null, opts.mid ?? 0))));
}

/** 只有 AQTK10 需要 usr key;AqKanji2Koe 只认 dev key。 */
export function generateUsrKey(module: Module, opts: { usrData?: number; days?: number } = {}): string {
  return dashed(formatKey(encryptLicenseKey(usrPlain(module, opts))));
}

/**
 * 三把密钥:环境变量(正式授权)优先,没设就用现算的学习版。
 * 变量名带 RIKKAHUB_ 前缀,避免与那台机器上别的工具的 YUKKURI_* 撞车。
 */
export function resolveKeys(): { aqtk10: string; aqtk10Usr: string; k2k: string } {
  return {
    aqtk10: process.env.RIKKAHUB_YUKKURI_AQTK10_DEV_KEY?.trim() || generateDevKey("tk10"),
    aqtk10Usr: process.env.RIKKAHUB_YUKKURI_AQTK10_USR_KEY?.trim() || generateUsrKey("tk10"),
    k2k: process.env.RIKKAHUB_YUKKURI_AQK2K_DEV_KEY?.trim() || generateDevKey("k2k"),
  };
}
