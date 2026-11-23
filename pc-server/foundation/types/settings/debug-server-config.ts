// foundation/types/settings/debug-server-config.ts — 本地调试端口(PC 专属)
//
// 用途:出问题时不必再让用户描述现象/截图——开启后本机多一个只绑 127.0.0.1 的
// 调试监听口,直接取实时控制台日志、最近模型请求/响应、助手与会话树、会话编码
// 产物(窗口起点/逐条 token/工具输出体积),并能从接口触发一次自重启。
//
// 纪律:
// - 默认关闭。关闭时进程不额外监听任何端口,也不安装 console 捕获之外的任何钩子。
// - 只绑回环:调试面绕过 Web 访问密码,绝不允许出现在对外监听地址上。
// - 设置里的 token 可留空。留空 = 本机即可访问;配置后所有调试端点要求 x-debug-token
//   头或 ?token= 查询参数(为 curl/浏览器直连保留两种方式)。
// - 跨端:导出安卓时整块剥离(stripPcOnly / PC_ONLY_SETTINGS_PRESERVED_ON_ANDROID_IMPORT)。
//   加载侧宽容:坏字段逐项回落默认,永不因配置损坏让 state 起不来。

export interface DebugServerConfig {
  /** 总开关:改动立即生效(开=拉起监听,关=停止监听),无需重启应用。 */
  enabled: boolean;
  /** 监听端口,默认 17456。仅接受 1024–65535,避免撞系统保留段。 */
  port: number;
  /** 访问令牌;空串 = 不校验(仍只绑回环)。 */
  token: string;
}

export function defaultDebugServerConfig(): DebugServerConfig {
  return { enabled: false, port: 17456, token: "" };
}

function clampPort(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  if (int < 1024 || int > 65535) return fallback;
  return int;
}

/** 加载侧归一化:非对象/损坏字段逐项回落默认,永不抛错。 */
export function normalizeDebugServerConfig(raw: unknown): DebugServerConfig {
  const defaults = defaultDebugServerConfig();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaults;
  const input = raw as Record<string, unknown>;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : defaults.enabled,
    port: clampPort(input.port, defaults.port),
    token: typeof input.token === "string" ? input.token.trim().slice(0, 256) : defaults.token,
  };
}
