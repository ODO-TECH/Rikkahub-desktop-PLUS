// media/yukkuri/engine.ts — AquesTalk 本地引擎绑定(koffi FFI)
// 移植自 reference/dsh-yukkuli 的 codec/aqtk10.js + codec/aqk2k.js + engine/local.js。
// 纪律:
// - 这一层只管「把 DLL 的返回值变成 Buffer / 字符串」,不懂角色、情绪、分段;那些在 index.ts。
// - 引擎句柄按 SDK 根目录缓存复用(AQTK10 打开 8ms、AqKanji2Koe 打开词典更贵),
//   但 DLL 调用本身是同步的:整个模块运行在 Bun 主线程,天然串行,不需要额外锁。
// - 缺 DLL/词典一律由 sdk.ts 提前变成可读错误;这里只处理 DLL 调用失败。
// - 绝不做「本地引擎不行就换在线服务」的静默降级:用户选的是油库里音色,换成别的音色
//   比报错更难查。

// 顺序有讲究:这一行必须在 koffi 之前(import 求值按书写顺序走),
// 否则单文件编译产物里 koffi 会在自己的模块初始化阶段就抛「找不到原生模块」。
import "./native-shim";
import { array, decode, load, out, pointer, struct, type LibraryHandle } from "koffi";
import type { YukkuriSdkPaths } from "./sdk";
import { resolveKeys } from "./keys";

/** koffi 的 lib.func() 返回类型没对外导出,这里用索引访问取它(调用面本身是宽松签名)。 */
type KoffiFunction = ReturnType<LibraryHandle["func"]>;

/** AQTK10 的声质参数(结构体按值传,AquesTalk.h 的 AQTK_VOICE)。 */
export interface AqtkVoice {
  /** 基础音素片:0=F1E 1=F2E 2=M1E */
  bas: number;
  /** 话速 50-300 */
  spd: number;
  /** 音量 0-300 */
  vol: number;
  /** 音高 20-200 */
  pit: number;
  /** 重音 0-200 */
  acc: number;
  /** 声质1 0-200 */
  lmd: number;
  /** 声质2(同时改采样率)50-200 */
  fsc: number;
}

/** 错误码 → 可读文案(AQTK10 手册第 5 页 / AqKanji2Koe 手册:200 番台=系统词典不正)。 */
export const AQTK10_ERRORS: Record<number, string> = {
  100: "その他のエラー",
  101: "メモリ不足",
  103: "音声記号列指定エラー(語頭の長音・促音の連続など)",
  104: "音声記号列に有効な読みがない",
  105: "音声記号列に未定義の読み記号",
  106: "タグの指定が正しくない",
  107: "タグの長さ制限超過",
  108: "タグ内の値指定が正しくない",
  120: "音声記号列が長すぎる",
  121: "1フレーズ中の読み記号が多すぎる",
  122: "音声記号列が長い(内部バッファオーバ)",
};

export const K2K_ERRORS: Record<number, string> = {
  200: "システム辞書(aqdic.bin)が不正、または辞書パスの文字コード不正",
  300: "ユーザ辞書(aq_user.dic)が不正",
  1: "音声記号列に変換できない文字が含まれる",
  2: "出力バッファ不足",
};

// 结构体注册是进程级的:同名重复注册会抛,所以只在模块顶层做一次。
const VOICE_STRUCT = struct("RIKKAHUB_AQTK_VOICE", {
  bas: "int",
  spd: "int",
  vol: "int",
  pit: "int",
  acc: "int",
  lmd: "int",
  fsc: "int",
});

interface Aqtk10Api {
  Synthe: KoffiFunction;
  FreeWave: KoffiFunction;
}

interface K2kApi {
  Create: KoffiFunction;
  Release: KoffiFunction;
  Convert: KoffiFunction;
}

export interface YukkuriSynthHandle {
  /** @param koe 音声記号列(假名记号,不是普通文本) */
  synthe(koe: string, voice: AqtkVoice): Buffer;
  close(): void;
}

export interface K2kHandle {
  /** 汉字假名混じり文 → 音声記号列 */
  convert(text: string): string;
  close(): void;
}

function describeError(code: number, errors: Record<number, string>): string {
  return errors[code] ?? `code=${code}`;
}

function openAqtk10(paths: YukkuriSdkPaths, devKey: string, usrKey: string): YukkuriSynthHandle {
  const lib: LibraryHandle = load(paths.aqtk10Dll);

  const SetDevKey = lib.func("AquesTalk_SetDevKey", "int", ["const char *"]);
  const SetUsrKey = lib.func("AquesTalk_SetUsrKey", "int", ["const char *"]);
  const rcDev = SetDevKey(devKey);
  if (rcDev !== 0) throw new Error(`AquesTalk_SetDevKey 被拒绝(rc=${rcDev}),SDK 路径: ${paths.root}`);
  const rcUsr = SetUsrKey(usrKey);
  if (rcUsr !== 0) throw new Error(`AquesTalk_SetUsrKey 被拒绝(rc=${rcUsr}),SDK 路径: ${paths.root}`);

  const api: Aqtk10Api = {
    Synthe: lib.func("AquesTalk_Synthe_Utf8", "void *", [VOICE_STRUCT, "const char *", out(pointer("int"))]),
    FreeWave: lib.func("AquesTalk_FreeWave", "void", ["void *"]),
  };

  return {
    synthe(koe, voice) {
      const size = [0];
      const ptr = api.Synthe(voice, koe, size);
      if (!ptr) {
        throw new Error(`AquesTalk_Synthe 失败: ${describeError(size[0]!, AQTK10_ERRORS)}`);
      }
      try {
        return Buffer.from(decode(ptr, array("uint8", size[0]!)));
      } finally {
        api.FreeWave(ptr);
      }
    },
    close() {},
  };
}

function openK2k(paths: YukkuriSdkPaths, devKey: string): K2kHandle {
  const lib = load(paths.k2kDll);

  const SetDevKey = lib.func("AqKanji2Koe_SetDevKey", "int", ["const char *"]);
  const rc = SetDevKey(devKey);
  if (rc !== 0) throw new Error(`AqKanji2Koe_SetDevKey 被拒绝(rc=${rc})`);

  const api: K2kApi = {
    Create: lib.func("AqKanji2Koe_Create", "void *", ["const char *", out(pointer("int"))]),
    Release: lib.func("AqKanji2Koe_Release", "void", ["void *"]),
    Convert: lib.func("AqKanji2Koe_Convert_utf8", "int", ["void *", "const char *", out(pointer("char")), "int"]),
  };

  // dicDir 必须是纯 ASCII:该 DLL 用 ANSI 编码读路径,非 ASCII 会让 Create 返回 NULL(err=200)。
  // 这条约束在 sdk.ts 的自检里已经把住了,这里再兜一次是因为直接调 engine 的单测绕过自检。
  const err: [number] = [0];
  const handle = api.Create(paths.k2kDicDir, err);
  if (!handle) {
    throw new Error(`AqKanji2Koe_Create 失败: ${describeError(err[0], K2K_ERRORS)}(词典目录: ${paths.k2kDicDir})`);
  }

  let alive = true;

  return {
    convert(text) {
      if (!alive) throw new Error("AqKanji2Koe 已关闭");
      const bufSize = Math.max(256, Buffer.byteLength(text, "utf8") * 4 + 256);
      const outBuf = Buffer.alloc(bufSize);
      const code = api.Convert(handle, text, outBuf, bufSize);
      if (code !== 0) throw new Error(`AqKanji2Koe_Convert 失败: ${describeError(code, K2K_ERRORS)}`);
      return outBuf.toString("utf8").replace(/\0.*$/s, "");
    },
    close() {
      if (!alive) return;
      alive = false;
      api.Release(handle);
    },
  };
}

// ---- 按 SDK 根目录缓存的引擎单例 ----

const synthCache = new Map<string, YukkuriSynthHandle>();
const k2kCache = new Map<string, K2kHandle>();

export function getSynth(paths: YukkuriSdkPaths): YukkuriSynthHandle {
  const cached = synthCache.get(paths.root);
  if (cached) return cached;
  const keys = resolveKeys();
  const handle = openAqtk10(paths, keys.aqtk10, keys.aqtk10Usr);
  synthCache.set(paths.root, handle);
  return handle;
}

export function getK2k(paths: YukkuriSdkPaths): K2kHandle {
  const cached = k2kCache.get(paths.root);
  if (cached) return cached;
  const handle = openK2k(paths, resolveKeys().k2k);
  k2kCache.set(paths.root, handle);
  return handle;
}

/** 设置页改了 SDK 路径、或后端退出时调用:关掉全部句柄,下次合成重新打开。 */
export function closeEngines(): void {
  for (const handle of synthCache.values()) handle.close();
  for (const handle of k2kCache.values()) handle.close();
  synthCache.clear();
  k2kCache.clear();
}

export const __engineInternals = { openAqtk10, openK2k, VOICE_STRUCT, AQTK10_ERRORS, K2K_ERRORS };
