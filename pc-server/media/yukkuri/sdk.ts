// media/yukkuri/sdk.ts — AquesTalk SDK 目录定位与自检
// 可选随包布局:若发布包/仓库根放入 `yukkuri-sdk/`(AQTK10 x64 DLL、AqKanji2Koe x64 DLL、
// aqdic.bin + SDK 自带 readme),编译与部署时与 icons/ fonts/ 一起重放到 exe 同级。
// 本仓库不附带官方**评估版** DLL:代码侧只如实记录来源与解析顺序,是否再分发由发布方判断。
// 解析顺序仍是 显式配置 > 环境变量 > 随包目录 > ~/yukkuri-sdk,且**不写死任何一台机器的绝对路径**
// —— 写死的那份在别人机器上只会变成「DLL 找不到」,或者更难查的「辞書パスの文字コード不正」。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { yukkuriSdkDir } from "../../foundation/paths";

export interface YukkuriSdkPaths {
  root: string;
  aqtk10Dll: string;
  k2kDll: string;
  k2kDicDir: string;
  k2kDicFile: string;
}

/** 目录级自检结果:UI/错误中心据此解释「为什么合成不出来」。 */
export interface YukkuriSdkStatus {
  root: string;
  /** 路径来源:随包 SDK(yukkuri-sdk/)是默认档,显式配置与环境变量都能盖掉它。 */
  rootFrom: "provider" | "env" | "bundled" | "default";
  /** AqKanji2Koe 用 ANSI 编码读词典路径,非 ASCII 路径会让 Create 直接返回 NULL(err=200)。 */
  rootIsAscii: boolean;
  aqtk10: boolean;
  k2k: boolean;
  dic: boolean;
  ready: boolean;
  platformSupported: boolean;
  hint?: string;
}

export const DEFAULT_SDK_DIR_NAME = "yukkuri-sdk";

function isAscii(value: string): boolean {
  return /^[\x20-\x7E]*$/.test(value);
}

/**
 * 优先级:提供商显式配置 > 环境变量 > **随包 SDK** > ~/yukkuri-sdk。
 *
 * 随包那档只认「aqtk10_win 在不在」,不认「件齐不齐」:目录在而件缺,提示要落在这个目录上
 * —— 否则用户会去翻一个自己根本没配的 ~/yukkuri-sdk,查错方向。
 */
export function resolveSdkRoot(explicit?: string | null): { root: string; from: YukkuriSdkStatus["rootFrom"] } {
  const provider = explicit?.trim();
  if (provider) return { root: provider, from: "provider" };
  const env = process.env.RIKKAHUB_YUKKURI_SDK_ROOT?.trim();
  if (env) return { root: env, from: "env" };
  if (existsSync(join(yukkuriSdkDir, "aqtk10_win"))) return { root: yukkuriSdkDir, from: "bundled" };
  return { root: join(homedir(), DEFAULT_SDK_DIR_NAME), from: "default" };
}

export function sdkPaths(root: string): YukkuriSdkPaths {
  return {
    root,
    aqtk10Dll: join(root, "aqtk10_win", "lib64", "AquesTalk.dll"),
    k2kDll: join(root, "aqk2k_win", "lib64", "AqKanji2Koe.dll"),
    k2kDicDir: join(root, "aqk2k_win", "aq_dic"),
    k2kDicFile: join(root, "aqk2k_win", "aq_dic", "aqdic.bin"),
  };
}

/**
 * 启动自检。不抛错 —— 这是一份「现状报告」,给错误中心和设置页用;
 * 真正要动用引擎时由 requireSdk() 把缺的东西变成可读的错误。
 */
export function describeSdk(explicit?: string | null): YukkuriSdkStatus {
  const { root, from } = resolveSdkRoot(explicit);
  const paths = sdkPaths(root);
  const platformSupported = process.platform === "win32";
  const rootIsAscii = isAscii(root);
  const aqtk10 = existsSync(paths.aqtk10Dll);
  const k2k = existsSync(paths.k2kDll);
  const dic = existsSync(paths.k2kDicFile);

  const status: YukkuriSdkStatus = {
    root,
    rootFrom: from,
    rootIsAscii,
    aqtk10,
    k2k,
    dic,
    ready: platformSupported && rootIsAscii && aqtk10 && k2k && dic,
    platformSupported,
  };

  if (!platformSupported) {
    status.hint = "AquesTalk 本地库只有 Windows x64 版,当前平台请用在线语音服务或系统 TTS。";
  } else if (!rootIsAscii) {
    status.hint = `SDK 路径含非 ASCII 字符(${root}),AqKanji2Koe 读不出词典。换到纯 ASCII 路径,例如 C:\\yukkuri-sdk。`;
  } else if (!aqtk10 || !k2k || !dic) {
    const missing = [
      !aqtk10 ? "aqtk10_win/lib64/AquesTalk.dll" : "",
      !k2k ? "aqk2k_win/lib64/AqKanji2Koe.dll" : "",
      !dic ? "aqk2k_win/aq_dic/aqdic.bin" : "",
    ].filter(Boolean);
    status.hint = `没在 ${root} 找到:${missing.join("、")}。把解压后的 AquesTalk10 与 AqKanji2Koe 放成这个结构,或在设置里把路径指对。`;
  }

  return status;
}

/** 合成前的一次性校验:缺什么就说什么,绝不静默换个引擎凑数。 */
export function requireSdk(explicit?: string | null): YukkuriSdkPaths {
  const status = describeSdk(explicit);
  if (status.ready) return sdkPaths(status.root);
  throw new Error(`油库里合成不可用:${status.hint ?? "SDK 未就绪"}`);
}
