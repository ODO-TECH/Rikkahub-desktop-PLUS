// foundation/types/settings/agent-loop-config.ts — 自主循环设置(PC 专属)
//
// 对外命名:设置里这块叫 AgentBot(较大的实验性能力,自主循环只是其中一小部分,
// 还有运行记录 / 判定终局 / 传输重试,后续会加任务生命周期与调度)。存储键与接口
// 仍沿用 agentLoop / settings/agent-loop——改名只动展示面,不做无谓的数据迁移。
//
// 纪律:总开关默认关——关闭时两条生成通路(聊天 / pi)与运行记录/判定/面板全部不生效,
// 行为与引入前逐字一致。transportRetry 是唯一的例外:它只作用于「本轮零可见输出」的
// 传输失败窗口,属稳定性修复,可以在总开关关闭时独立生效(见 docs/plan-autonomous-loop.md §4.3)。
//
// 跨端:导出安卓时整块剥离(backup/export.ts 的 stripPcOnly 块 + backup/import.ts
// 的 PC_ONLY_SETTINGS_PRESERVED_ON_ANDROID_IMPORT);pc-backup(PC→PC)保留。
//
// 加载侧宽容原则(与 subagent-config / workspace-tools-config 同款):存量 state 无此键
// 或字段损坏 → 逐字段回落默认,永不因一个坏字段让 state 起不来。

export interface AgentLoopSettings {
  /** 总开关。关闭时:不建运行记录、不注入判定、不发运行事件、不显示面板。 */
  enabled: boolean;
  /** 传输重试(退避 1s→2s,合计最多 3 次尝试)。只作用于本轮尚未产生任何可见输出的可重试失败;
   *  已流出内容的轮次、副作用工具之后、用户中止、4xx/配额/计费错误一律不重试。 */
  transportRetry: boolean;
  /** 传输重试的退避基数(秒),第 N 次重试前等 基数 × 2^(N-1)。默认 1 = 既有的 1s→2s。
   *  服务端给了 Retry-After 时取两者中更长的:绝不比服务端要求的更早发,但它给得短
   *  也不会把这里的设置顶掉(降温型 429 常回 0/1s)。 */
  transportRetryDelaySeconds: number;
  /** replan 上限。计划连续改写后 settled 步骤数仍不增长 → awaiting_user。 */
  maxReplans: number;
  /** 同一 (工具名, 规范化参数) 连续重复触发停滞的阈值。 */
  stallRepeatLimit: number;
  /** 同一错误签名连续出现触发 replan 的阈值。 */
  sameErrorLimit: number;
  /** 完成必须带工具证据:模型标 completed 但无证据的步骤不计入完成判定。 */
  requireVerifiedCompletion: boolean;
  /** 生命周期 L3:耐久调度开关。关闭只停止投递,不删已有调度记录(可审计)。 */
  schedulingEnabled: boolean;
}

export function defaultAgentLoopConfig(): AgentLoopSettings {
  return {
    enabled: false,
    transportRetry: true,
    transportRetryDelaySeconds: 1,
    maxReplans: 2,
    stallRepeatLimit: 3,
    sameErrorLimit: 3,
    requireVerifiedCompletion: true,
    schedulingEnabled: false,
  };
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 加载侧归一化:非对象/损坏字段逐项回落默认,永不抛错。 */
export function normalizeAgentLoopConfig(raw: unknown): AgentLoopSettings {
  const defaults = defaultAgentLoopConfig();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaults;
  const input = raw as Record<string, unknown>;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : defaults.enabled,
    transportRetry: typeof input.transportRetry === "boolean" ? input.transportRetry : defaults.transportRetry,
    transportRetryDelaySeconds: boundedInt(
      input.transportRetryDelaySeconds,
      defaults.transportRetryDelaySeconds,
      1,
      30,
    ),
    maxReplans: boundedInt(input.maxReplans, defaults.maxReplans, 0, 10),
    stallRepeatLimit: boundedInt(input.stallRepeatLimit, defaults.stallRepeatLimit, 2, 20),
    sameErrorLimit: boundedInt(input.sameErrorLimit, defaults.sameErrorLimit, 2, 20),
    requireVerifiedCompletion:
      typeof input.requireVerifiedCompletion === "boolean"
        ? input.requireVerifiedCompletion
        : defaults.requireVerifiedCompletion,
    schedulingEnabled:
      typeof input.schedulingEnabled === "boolean"
        ? input.schedulingEnabled
        : defaults.schedulingEnabled,
  };
}

export type AgentLoopPatchResult =
  | { ok: true; value: Partial<AgentLoopSettings> }
  | { ok: false; error: string };

/** 写侧校验(与 subagent-config 的 validateSubagentPatch 同风格):越界/类型不符整体
 *  拒绝,不夹取、不部分生效;未提供的字段不进补丁。 */
export function validateAgentLoopPatch(body: Record<string, unknown>): AgentLoopPatchResult {
  const patch: Partial<AgentLoopSettings> = {};
  const booleans = ["enabled", "transportRetry", "requireVerifiedCompletion", "schedulingEnabled"] as const;
  for (const key of booleans) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return { ok: false, error: `${key} must be a boolean` };
    patch[key] = value;
  }
  const ranges: Array<
    [
      keyof Pick<
        AgentLoopSettings,
        "transportRetryDelaySeconds" | "maxReplans" | "stallRepeatLimit" | "sameErrorLimit"
      >,
      number,
      number,
    ]
  > = [
    ["transportRetryDelaySeconds", 1, 30],
    ["maxReplans", 0, 10],
    ["stallRepeatLimit", 2, 20],
    ["sameErrorLimit", 2, 20],
  ];
  for (const [key, min, max] of ranges) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      return { ok: false, error: `${key} must be an integer` };
    }
    if (value < min || value > max) return { ok: false, error: `${key} must be between ${min} and ${max}` };
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "no recognized agent loop settings in patch" };
  return { ok: true, value: patch };
}
