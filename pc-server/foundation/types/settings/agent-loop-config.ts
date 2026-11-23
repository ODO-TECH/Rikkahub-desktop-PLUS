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
  /** replan 上限。计划连续改写后 settled 步骤数仍不增长 → awaiting_user。 */
  maxReplans: number;
  /** 同一 (工具名, 规范化参数) 连续重复触发停滞的阈值。 */
  stallRepeatLimit: number;
  /** 同一错误签名连续出现触发 replan 的阈值。 */
  sameErrorLimit: number;
  /** 完成必须带工具证据:模型标 completed 但无证据的步骤不计入完成判定。 */
  requireVerifiedCompletion: boolean;
  /** S-F5:单轮工具输出体积预算(token,0 = 关)。超预算先注入一次收口提示,
   *  连续两轮超限 → awaiting_user(交给人,不再烧轮次)。 */
  roundBudgetTokens: number;
  /** 生命周期 L3:耐久调度开关。关闭只停止投递,不删已有调度记录(可审计)。 */
  schedulingEnabled: boolean;
}

export function defaultAgentLoopConfig(): AgentLoopSettings {
  return {
    enabled: true,
    transportRetry: true,
    maxReplans: 2,
    stallRepeatLimit: 3,
    sameErrorLimit: 3,
    requireVerifiedCompletion: true,
    roundBudgetTokens: 0,
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
    maxReplans: boundedInt(input.maxReplans, defaults.maxReplans, 0, 10),
    stallRepeatLimit: boundedInt(input.stallRepeatLimit, defaults.stallRepeatLimit, 2, 20),
    sameErrorLimit: boundedInt(input.sameErrorLimit, defaults.sameErrorLimit, 2, 20),
    requireVerifiedCompletion:
      typeof input.requireVerifiedCompletion === "boolean"
        ? input.requireVerifiedCompletion
        : defaults.requireVerifiedCompletion,
    roundBudgetTokens: boundedInt(input.roundBudgetTokens, defaults.roundBudgetTokens, 0, 2_000_000),
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
  const ranges: Array<[keyof Pick<AgentLoopSettings, "maxReplans" | "stallRepeatLimit" | "sameErrorLimit" | "roundBudgetTokens">, number, number]> = [
    ["maxReplans", 0, 10],
    ["stallRepeatLimit", 2, 20],
    ["sameErrorLimit", 2, 20],
    ["roundBudgetTokens", 0, 2_000_000],
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
