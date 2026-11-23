// tools/plan.ts — update_plan 工具的单一事实源(聊天引擎 + pi 工作区引擎共用)。
//
// 定位:模型把「这次要办哪几件事」以结构化清单发布出来,前端右侧工作台据此渲染计划面板。
// 与 ask-user.ts 同一纪律:纯函数、零 I/O、零状态——schema 声明 / 归一化 / 进度统计收在
// 这一处,两个引擎的适配层只做薄封装。web-ui 经 @server 别名 import 本文件的纯函数与
// 类型,UI 解析与后端逐字一致,避免双份逻辑漂移。
//
// 存储:不落库、不建表。计划就是消息流里的一条 tool part(input 是模型写的 JSON,
// output 是我们回给它的回执)。面板读「本会话最后一条 update_plan」即最新计划,
// 重放/刷新/换设备都免费得到同一结果,不需要额外的会话级状态机。
//
// 计划 v2(自主循环 S2):
//  - goal / done_when / boundaries 是「判断层」的三件套:首次由模型复述,之后同一轮内
//    模型再提交不同值一律保留旧值并在回执里警告(只有新的用户消息能改,见 mergePlan);
//  - steps 增加 id / verify / evidence;attempts 由代码层维护,模型输入里的值不采信;
//  - completed 但没有 evidence 的步骤 = 未验证,不计入完成判定(planReceipt/UI 徽标);
//  - 旧输入(只有 title/steps[{content,status}])的归一化结果与引入前逐字一致。
//
// 权威快照:合并后的计划随工具结果落在 text part 的 metadata.planV2 里(模型面文本
// 仍是精简回执)。面板优先读快照、回退读原始 input——这样模型即使提交了被拒绝的
// goal,面板显示的仍是服务端保留的旧值。

import type { JsonValue } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import { analyzePlanGraph, unsatisfiedDependencies, validatePlanGraph } from "./plan-graph";

export const PLAN_TOOL_NAME = "update_plan";

/** 单次计划的步数上限:再多说明模型没在拆任务,而是在抄目录。 */
export const PLAN_MAX_STEPS = 20;

/** 单步文案的字符钳制(面板一行放得下的长度)。 */
export const PLAN_MAX_CONTENT_LEN = 160;

/** v2 字段的钳制上限:目标原文、验收/边界条目数、单条长度、证据条数、错误摘要。 */
export const PLAN_MAX_GOAL_LEN = 800;
export const PLAN_MAX_DONE_WHEN = 8;
export const PLAN_MAX_BOUNDARIES = 10;
export const PLAN_MAX_ITEM_LEN = 200;
export const PLAN_MAX_VERIFY_LEN = 200;
export const PLAN_MAX_EVIDENCE = 20;
export const PLAN_MAX_ERROR_LEN = 240;
export const PLAN_MAX_STEP_ID_LEN = 40;
/** 任务图 v3:单步直接依赖上限与重试预算范围。 */
export const PLAN_MAX_DEPENDENCIES = 8;
export const PLAN_MAX_ATTEMPTS_DEFAULT = 3;
export const PLAN_MAX_ATTEMPTS_LIMIT = 5;

export const PLAN_STEP_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;

/** v3 额外状态:failed 不是终局,是否还能重试由图分析按 attempts/maxAttempts 判定。 */
export const PLAN_GRAPH_STEP_STATUSES = [...PLAN_STEP_STATUSES, "failed"] as const;

export type PlanStepStatus = (typeof PLAN_GRAPH_STEP_STATUSES)[number];

export interface PlanStep {
  content: string;
  status: PlanStepStatus;
  /** v2:稳定步骤 id(模型可给;缺省由代码按序生成)。 */
  id?: string;
  /** v2:如何验证这一步(模型给,用于完成校验提示)。 */
  verify?: string;
  /** v2:产生该结果的 toolCallId。completed 但为空 = 未验证。 */
  evidence?: string[];
  /** v2:代码维护的重试次数,模型提交值不采信。 */
  attempts?: number;
  /** v2:最近一次失败摘要(代码/模型可写,合并时不清空)。 */
  lastError?: string | null;
  /** v3:直接前置步骤 id(JSON: depends_on)。 */
  dependsOn?: string[];
  /** v3:失败重试预算,首次设定后同 run 内锁定。 */
  maxAttempts?: number;
}

export interface Plan {
  title: string;
  steps: PlanStep[];
  /** v2:用户目标原文(首次由模型复述,之后只能由用户消息改变)。 */
  goal?: string;
  /** v2:机器可判定的完成条件。 */
  doneWhen?: string[];
  /** v2:禁止事项(越界即失败)。 */
  boundaries?: string[];
}

export interface NormalizePlanOptions {
  /** true = 输入是服务端产出的权威快照(工具结果 metadata),attempts 可信;
   *  缺省 false = 模型输入,attempts 一律丢弃。 */
  trusted?: boolean;
  /** true = 按任务图 v3 解析 depends_on / max_attempts / failed;缺省 false 时
   *  v3 字段被忽略、"failed" 仍按旧规则落 pending。 */
  graph?: boolean;
}

const PLAN_TOOL_DESCRIPTION_BASE =
  "Publish or update the task plan for the current conversation. " +
  "Use it when the work needs 3 or more distinct steps, or when the user asks for a plan / checklist / progress view: " +
  "call it once before starting, then call it again whenever a step changes status. " +
  "Each call replaces the whole plan (it is not appended to), so always send the complete list. " +
  "Keep every step short, imperative and independently verifiable; keep at most one step in_progress. " +
  "Do NOT use it for single-step answers, role-play, casual chat, or pure information lookups. " +
  "When everything is done, send the final plan with every step completed or cancelled — do not leave a plan in_progress.";

const PLAN_TOOL_DESCRIPTION_V2 =
  "Plan v2: on the first call also state goal (the user's goal, restated in one or two sentences), " +
  "done_when (machine-checkable completion conditions) and boundaries (things you must not do, such as deleting tests or writing outside the workspace). " +
  "Once set, goal / done_when / boundaries are locked for this run: later calls must not change them — only a new user message can. " +
  "Give every step a stable id, and when you mark a step completed put the toolCallId(s) that produced the evidence in its evidence array. " +
  "A completed step without evidence is shown as unverified and does not count as done. " +
  "attempts is maintained by the runtime; do not try to set or reset it.";

const PLAN_TOOL_DESCRIPTION_V3 =
  "Task graph v3: every step must have a stable id, and depends_on lists the direct prerequisite step ids (at most 8). " +
  "Only start a step when all of its dependencies are completed with evidence; otherwise it is blocked. " +
  "Keep at most one step in_progress. If the current step fails, mark it failed and put a short reason in last_error instead of leaving it in_progress. " +
  "max_attempts (1-5, default 3) is the retry budget and is locked after the first call; attempts is owned by the runtime and must never be set or reset. " +
  "When attempts reaches max_attempts the step is exhausted and the run stops for the user; do not pretend it succeeded.";

/** 模型面工具描述。v2 = 自主循环总开关开启;关闭时与引入前逐字一致(不诱导模型提交新字段)。
 *  graph = 任务图 v3 开启,追加依赖与预算语义。 */
export function planToolDescription(v2 = false, graph = false): string {
  const base = v2 ? `${PLAN_TOOL_DESCRIPTION_BASE} ${PLAN_TOOL_DESCRIPTION_V2}` : PLAN_TOOL_DESCRIPTION_BASE;
  return graph ? `${base} ${PLAN_TOOL_DESCRIPTION_V3}` : base;
}

/** 模型面 schema 的 steps 数组片段(双引擎同源)。 */
export function planStepsSchema(v2 = false, graph = false): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    content: {
      type: "string",
      description: "Short imperative description of this step",
    },
    status: {
      type: "string",
      enum: graph ? [...PLAN_GRAPH_STEP_STATUSES] : [...PLAN_STEP_STATUSES],
      description: graph
        ? "pending (not started), in_progress (currently worked on), completed (done with evidence), cancelled (no longer needed), failed (failed; retry only while attempts < max_attempts)"
        : "pending (not started), in_progress (currently being worked on), completed (done), cancelled (no longer needed)",
    },
  };
  if (v2) {
    properties.id = {
      type: "string",
      description: "Stable short id for this step (e.g. s1); keep it unchanged across plan updates",
    };
    properties.verify = {
      type: "string",
      description: "How this step will be verified (command, check, or observable result)",
    };
    properties.evidence = {
      type: "array",
      description: "toolCallId(s) that produced the evidence for a completed step",
      items: { type: "string" },
    };
  }
  if (graph) {
    properties.depends_on = {
      type: "array",
      description: `Direct prerequisite step ids (max ${PLAN_MAX_DEPENDENCIES}); a step stays blocked until every dependency is completed with evidence`,
      items: { type: "string" },
    };
    properties.max_attempts = {
      type: "integer",
      minimum: 1,
      maximum: PLAN_MAX_ATTEMPTS_LIMIT,
      description: `Retry budget for this step (default ${PLAN_MAX_ATTEMPTS_DEFAULT}); locked after the first plan`,
    };
  }
  return {
    type: "array",
    description: graph
      ? `The complete task graph as a flat step list (1-${PLAN_MAX_STEPS} steps); dependencies are expressed by depends_on, not by array order`
      : `The complete plan, in execution order (1-${PLAN_MAX_STEPS} steps)`,
    items: {
      type: "object",
      properties,
      required: ["content", "status"],
    },
  };
}

/** update_plan 的参数面(definitions.ts 声明用)。v2 才带目标三件套;graph 才带依赖与预算。 */
export function planToolParameters(v2 = false, graph = false): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Optional short heading shown above the plan (defaults to the conversation topic)",
      },
      ...(v2
        ? {
            goal: {
              type: "string",
              description:
                "The user's goal, restated. Set it on the first plan; locked for the rest of this run.",
            },
            done_when: {
              type: "array",
              description:
                "Machine-checkable conditions that mean the goal is achieved (locked after first set)",
              items: { type: "string" },
            },
            boundaries: {
              type: "array",
              description:
                "Things that must not happen (e.g. deleting tests, writing outside the workspace); locked after first set",
              items: { type: "string" },
            },
          }
        : {}),
      steps: planStepsSchema(v2, graph),
    },
    required: ["steps"],
  };
}

function normalizeStatus(value: unknown, graph: boolean): PlanStepStatus {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "done" || text === "complete" || text === "finished") return "completed";
  if (text === "doing" || text === "active" || text === "in progress") return "in_progress";
  if (text === "skipped" || text === "canceled" || text === "removed") return "cancelled";
  if (text === "failed" || text === "error") return graph ? "failed" : "pending";
  const statuses: readonly string[] = graph ? PLAN_GRAPH_STEP_STATUSES : PLAN_STEP_STATUSES;
  return statuses.includes(text) ? (text as PlanStepStatus) : "pending";
}

function clampText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 验收/边界列表:接受数组或单字符串,逐条 trim/钳制,丢弃空项。 */
function normalizeStringList(value: unknown, maxItems: number, maxLen: number): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, maxLen);
    if (!text) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** 证据:去重 + 条数/长度钳制。只认字符串(JSON 里的 toolCallId)。 */
function normalizeEvidence(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, PLAN_MAX_ITEM_LEN);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= PLAN_MAX_EVIDENCE) break;
  }
  return out;
}

function normalizeStepId(value: unknown, index: number, used: Set<string>): string {
  const base = typeof value === "string"
    ? value.trim().replace(/\s+/g, "-").slice(0, PLAN_MAX_STEP_ID_LEN)
    : "";
  let id = base || `s${index + 1}`;
  if (used.has(id)) id = `s${index + 1}`;
  let suffix = 2;
  while (used.has(id)) id = `${base || `s${index + 1}`}-${suffix++}`;
  used.add(id);
  return id;
}

const STEP_V2_KEYS = ["id", "verify", "evidence", "attempts", "last_error", "lastError"] as const;
const STEP_V3_KEYS = ["depends_on", "dependsOn", "max_attempts", "maxAttempts"] as const;

/** 依赖:只认字符串,去空白/去重/保序。这里保留超量项,由 validatePlanGraph
 *  明确拒绝 > PLAN_MAX_DEPENDENCIES;只做防爆上限,避免畸形输入撑大快照。 */
function normalizeDependencies(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.trim().replace(/\s+/g, "-").slice(0, PLAN_MAX_STEP_ID_LEN);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= PLAN_MAX_DEPENDENCIES * 8) break;
  }
  return out;
}

/** 重试预算:整数 1..5,缺省 3。 */
function normalizeMaxAttempts(value: unknown): number {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(raw)) return PLAN_MAX_ATTEMPTS_DEFAULT;
  return Math.min(PLAN_MAX_ATTEMPTS_LIMIT, Math.max(1, Math.floor(raw)));
}

function rawStepsOf(input: Record<string, unknown>): unknown[] {
  return Array.isArray(input.steps)
    ? input.steps
    : Array.isArray(input.plan)
      ? input.plan
      : Array.isArray(input.todos)
        ? input.todos
        : [];
}

/** 容错归一化:模型给的 JSON 可能缺字段、多字段、状态拼错、步数爆表——
 *  面板与回执都吃这个函数,保证同一份计划在任何一侧读到的是同一个形状。
 *  空/非法输入返回 {title:"",steps:[]},调用方按"没有计划"处理。
 *  没有任何 v2 字段的旧输入,输出形状与引入前逐字一致(不补空字段)。
 *  graph=true 时额外解析 v3 的依赖、预算与 failed;缺省忽略这些字段。 */
export function normalizePlan(input: unknown, options: NormalizePlanOptions = {}): Plan {
  if (!isRecord(input)) return { title: "", steps: [] };
  const rawSteps = rawStepsOf(input);
  const v2 =
    "goal" in input ||
    "done_when" in input ||
    "doneWhen" in input ||
    "boundaries" in input ||
    rawSteps.some((raw) => isRecord(raw) && STEP_V2_KEYS.some((key) => key in raw));
  const v3 =
    options.graph === true &&
    (v2 ||
      "depends_on" in input ||
      "dependsOn" in input ||
      "max_attempts" in input ||
      "maxAttempts" in input ||
      rawSteps.some(
        (raw) =>
          isRecord(raw) &&
          (STEP_V3_KEYS.some((key) => key in raw) || normalizeStatus(raw.status, true) === "failed"),
      ));
  const usedIds = new Set<string>();
  const steps: PlanStep[] = [];
  for (const [index, raw] of rawSteps.slice(0, PLAN_MAX_STEPS).entries()) {
    if (typeof raw === "string") {
      const content = raw.trim().slice(0, PLAN_MAX_CONTENT_LEN);
      if (!content) continue;
      if (!v2) {
        steps.push({ content, status: "pending" });
        continue;
      }
      steps.push({
        id: normalizeStepId(undefined, index, usedIds),
        content,
        status: "pending",
        verify: "",
        evidence: [],
        attempts: 0,
        lastError: null,
        ...(v3
          ? { dependsOn: [], maxAttempts: PLAN_MAX_ATTEMPTS_DEFAULT }
          : {}),
      });
      continue;
    }
    if (!isRecord(raw)) continue;
    const content = String(
      raw.content ?? raw.title ?? raw.text ?? raw.description ?? "",
    )
      .trim()
      .slice(0, PLAN_MAX_CONTENT_LEN);
    if (!content) continue;
    const status = normalizeStatus(raw.status, v3);
    if (!v2) {
      steps.push({ content, status });
      continue;
    }
    const attemptsRaw = options.trusted ? Number(raw.attempts) : 0;
    steps.push({
      id: normalizeStepId(raw.id, index, usedIds),
      content,
      status,
      verify: clampText(raw.verify, PLAN_MAX_VERIFY_LEN),
      evidence: normalizeEvidence(raw.evidence),
      attempts: Number.isFinite(attemptsRaw) && attemptsRaw > 0 ? Math.floor(attemptsRaw) : 0,
      lastError: clampText(raw.last_error ?? raw.lastError, PLAN_MAX_ERROR_LEN) || null,
      ...(v3
        ? {
            dependsOn: normalizeDependencies(raw.depends_on ?? raw.dependsOn),
            maxAttempts:
              raw.max_attempts === undefined && raw.maxAttempts === undefined
                ? PLAN_MAX_ATTEMPTS_DEFAULT
                : normalizeMaxAttempts(raw.max_attempts ?? raw.maxAttempts),
          }
        : {}),
    });
  }
  const title = String(rawTitle(input)).trim().slice(0, 80);
  if (!v2) return { title, steps };
  return {
    title,
    steps,
    goal: clampText(input.goal, PLAN_MAX_GOAL_LEN),
    doneWhen: normalizeStringList(input.done_when ?? input.doneWhen, PLAN_MAX_DONE_WHEN, PLAN_MAX_ITEM_LEN),
    boundaries: normalizeStringList(input.boundaries, PLAN_MAX_BOUNDARIES, PLAN_MAX_ITEM_LEN),
  };
}

function rawTitle(input: Record<string, unknown>): unknown {
  return input.title ?? input.name ?? "";
}

function parseToolInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  if (!input.trim()) return null;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

/** 从工具结果的 output 里取服务端权威快照(最后一个带 metadata.planV2 的 part)。 */
export function planSnapshotFromToolOutput(output: unknown): unknown | null {
  if (!Array.isArray(output)) return null;
  for (let index = output.length - 1; index >= 0; index--) {
    const entry = output[index];
    if (!isRecord(entry)) continue;
    const metadata = entry.metadata;
    if (isRecord(metadata) && "planV2" in metadata) return metadata.planV2;
  }
  return null;
}

/** 单个 update_plan tool part → 权威 Plan(最新面板与历史 run 投影共用)。
 *  优先 metadata.planV2(合并/改写保护后的快照),回退解析模型原始 input;空计划返回 null。
 *  调用方负责确认 part 确实是 update_plan 工具。 */
export function planFromToolPart(part: unknown): Plan | null {
  if (!isRecord(part)) return null;
  const snapshot = planSnapshotFromToolOutput(part.output);
  if (snapshot) {
    const plan = normalizePlan(snapshot, { trusted: true, graph: true });
    if (plan.steps.length > 0) return plan;
  }
  const plan = normalizePlan(parseToolInput(part.input), { graph: true });
  return plan.steps.length > 0 ? plan : null;
}

/** 是否 v2 计划(v2 字段存在,哪怕是空值)。旧计划为 false——UI 据此保持旧样式。 */
export function isPlanV2(plan: Plan): boolean {
  return (
    plan.goal !== undefined ||
    plan.doneWhen !== undefined ||
    plan.boundaries !== undefined ||
    plan.steps.some((step) => step.id !== undefined)
  );
}

/** 是否任务图 v3:有依赖、预算或 failed 状态。v3 同时满足 isPlanV2。 */
export function isPlanV3(plan: Plan): boolean {
  return plan.steps.some(
    (step) =>
      step.dependsOn !== undefined ||
      step.maxAttempts !== undefined ||
      step.status === "failed",
  );
}

/** completed 但没有工具证据 = 未验证(不计入完成判定,面板标徽标)。 */
export function isStepUnverified(step: PlanStep): boolean {
  return step.status === "completed" && (step.evidence?.length ?? 0) === 0;
}

/** 面板与回执共用的进度口径:cancelled 计入"已了结"但不算完成。
 *  形状与引入前逐字一致;未验证统计走 isStepUnverified/planReceipt。 */
export function planProgress(plan: Plan) {
  const total = plan.steps.length;
  const completed = plan.steps.filter((s) => s.status === "completed").length;
  const cancelled = plan.steps.filter((s) => s.status === "cancelled").length;
  const inProgress = plan.steps.find((s) => s.status === "in_progress")?.content ?? null;
  return {
    total,
    completed,
    cancelled,
    settled: completed + cancelled,
    inProgress,
    finished: total > 0 && completed + cancelled === total,
  };
}

function sameList(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export interface PlanMergeOptions {
  /** true = 上一版计划之后用户发过新消息(新 run):允许模型重新设定目标三件套。
   *  缺省 false = 同一轮内,改写被拒绝并回执警告。 */
  allowGoalChange?: boolean;
  /** true = 按任务图 v3 合并(依赖校验、预算锁定、failed 计数)。 */
  taskGraph?: boolean;
  /** 依赖"完成"是否必须带证据;与 agentLoop.requireVerifiedCompletion 同口径。 */
  requireVerified?: boolean;
  /** Successful calls from the selected conversation, supplied by the host. */
  availableEvidence?: Array<{ toolCallId: string; toolName: string }>;
}

export interface PlanMergeResult {
  plan: Plan;
  /** 模型面回执里的警告(英文,给模型看);UI 不展示。 */
  warnings: string[];
  /** false = 输入被整体拒绝,plan 仍是上一版权威计划(首次发布则为空)。 */
  accepted: boolean;
}

function graphIssueWarning(issues: ReturnType<typeof validatePlanGraph>): string {
  const detail = issues
    .map((issue) =>
      issue.dependencyId
        ? `${issue.code}(${issue.stepId} -> ${issue.dependencyId})`
        : `${issue.code}(${issue.stepId})`,
    )
    .join(", ");
  return `plan graph rejected: ${detail}. Keep the previous plan and fix the dependencies.`;
}

/** v3 活动步骤校验:最多一个 in_progress,依赖必须已按证据口径完成,预算未耗尽。 */
function activeStepViolation(plan: Plan, requireVerified: boolean): string | null {
  const active = plan.steps.filter((step) => step.status === "in_progress");
  if (active.length > 1) {
    return `only one step may be in_progress at a time; rejected ${active.length} active steps.`;
  }
  const step = active[0];
  if (!step) return null;
  const unmet = unsatisfiedDependencies(plan, step, { requireVerified });
  if (unmet.length > 0) {
    return `step ${step.id ?? ""} cannot start: unmet dependencies ${unmet.join(", ")}.`;
  }
  if ((step.attempts ?? 0) >= (step.maxAttempts ?? PLAN_MAX_ATTEMPTS_DEFAULT)) {
    return `step ${step.id ?? ""} exhausted its retry budget; it cannot be restarted.`;
  }
  return null;
}

/** 把一次 update_plan 输入合并到上一版计划上。纯函数:
 *  - goal/done_when/boundaries 同轮内只读(保留旧值 + 警告),新 run 才允许改写;
 *  - steps 按 id 优先、content 兜底匹配:attempts/evidence 向后携带,模型不能清零;
 *  - v3 追加依赖、预算锁定与 failed 计数;非法图整份拒绝,不静默修边;
 *  - 空 steps 视为误发,保留上一版计划。 */
export function mergePlan(
  previous: Plan | null,
  input: unknown,
  options: PlanMergeOptions = {},
): PlanMergeResult {
  const graph = options.taskGraph === true || isPlanV3(previous ?? { title: "", steps: [] });
  const requireVerified = options.requireVerified !== false;
  const incoming = normalizePlan(input, { graph });
  if (!previous && incoming.steps.length === 0) {
    return { plan: incoming, warnings: [], accepted: true };
  }
  if (previous && incoming.steps.length === 0 && previous.steps.length > 0) {
    return {
      plan: previous,
      warnings: ["empty plan ignored; kept the previous plan. Send the complete step list to update it."],
      accepted: true,
    };
  }

  const warnings: string[] = [];
  const allowGoalChange = options.allowGoalChange === true;
  const v2 = isPlanV2(previous ?? incoming) || isPlanV2(incoming);
  const v3 = graph || isPlanV3(previous ?? { title: "", steps: [] }) || isPlanV3(incoming);

  if (!previous) {
    const issues = validatePlanGraph(incoming);
    if (issues.length > 0) {
      return { plan: { title: "", steps: [] }, warnings: [graphIssueWarning(issues)], accepted: false };
    }
    const violation = activeStepViolation(incoming, requireVerified);
    if (violation) {
      return { plan: { title: "", steps: [] }, warnings: [violation], accepted: false };
    }
    return { plan: incoming, warnings: [], accepted: true };
  }

  const prevGoal = previous.goal ?? "";
  const nextGoal = incoming.goal ?? "";
  // 省略(空串)视为不改,不把旧目标冲掉;只有非空的不同值才进入改写判定。
  let goal = nextGoal || prevGoal;
  if (prevGoal && nextGoal && nextGoal !== prevGoal && !allowGoalChange) {
    goal = prevGoal;
    warnings.push(
      "goal is locked for this run; kept the previous goal (only a new user message can change it).",
    );
  }

  let doneWhen = incoming.doneWhen?.length ? incoming.doneWhen : (previous.doneWhen ?? []);
  if (
    (previous.doneWhen?.length ?? 0) > 0 &&
    (incoming.doneWhen?.length ?? 0) > 0 &&
    !sameList(previous.doneWhen, incoming.doneWhen) &&
    !allowGoalChange
  ) {
    doneWhen = previous.doneWhen ?? [];
    warnings.push(
      "done_when is locked for this run; kept the previous conditions (only a new user message can change them).",
    );
  }

  let boundaries = incoming.boundaries?.length ? incoming.boundaries : (previous.boundaries ?? []);
  if (
    (previous.boundaries?.length ?? 0) > 0 &&
    (incoming.boundaries?.length ?? 0) > 0 &&
    !sameList(previous.boundaries, incoming.boundaries) &&
    !allowGoalChange
  ) {
    boundaries = previous.boundaries ?? [];
    warnings.push(
      "boundaries are locked for this run; kept the previous list (only a new user message can change it).",
    );
  }

  const byId = new Map<string, PlanStep>();
  const byContent = new Map<string, PlanStep>();
  for (const step of previous.steps) {
    if (step.id) byId.set(step.id, step);
    if (!byContent.has(step.content)) byContent.set(step.content, step);
  }
  const steps: PlanStep[] = incoming.steps.map((step, index) => {
    const matched = (step.id ? byId.get(step.id) : undefined) ?? byContent.get(step.content);
    if (!v2) return { content: step.content, status: step.status };
    const seen = new Set<string>();
    const mergedEvidence: string[] = [];
    for (const id of [...(matched?.evidence ?? []), ...(step.evidence ?? [])]) {
      if (seen.has(id)) continue;
      seen.add(id);
      mergedEvidence.push(id);
    }
    const base: PlanStep = {
      id: step.id ?? matched?.id ?? `s${index + 1}`,
      content: step.content,
      status: step.status,
      verify: step.verify || matched?.verify || "",
      evidence: mergedEvidence.slice(0, PLAN_MAX_EVIDENCE),
      // code-owned:向后携带,模型提交值已被 normalizePlan 丢弃;绝不回退。
      attempts: Math.max(matched?.attempts ?? 0, step.attempts ?? 0),
      lastError: step.lastError ?? matched?.lastError ?? null,
    };
    if (!v3) return base;

    let maxAttempts = matched?.maxAttempts ?? step.maxAttempts ?? PLAN_MAX_ATTEMPTS_DEFAULT;
    if (
      matched?.maxAttempts !== undefined &&
      step.maxAttempts !== undefined &&
      step.maxAttempts !== matched.maxAttempts
    ) {
      maxAttempts = matched.maxAttempts;
      warnings.push(
        `max_attempts for step ${base.id} is locked for this run; kept ${matched.maxAttempts}.`,
      );
    }
    // 只在新一次进入 failed 时 +1;重复申报 failed 不刷计数。
    if (step.status === "failed" && matched?.status !== "failed") {
      base.attempts = (matched?.attempts ?? 0) + 1;
    }
    return {
      ...base,
      dependsOn: step.dependsOn !== undefined ? step.dependsOn : (matched?.dependsOn ?? []),
      maxAttempts,
    };
  });

  const plan: Plan = { title: incoming.title, steps };
  if (v2) {
    plan.goal = goal;
    plan.doneWhen = doneWhen;
    plan.boundaries = boundaries;
  }
  if (v3) {
    const issues = validatePlanGraph(plan);
    if (issues.length > 0) {
      return { plan: previous, warnings: [...warnings, graphIssueWarning(issues)], accepted: false };
    }
    const violation = activeStepViolation(plan, requireVerified);
    if (violation) {
      return { plan: previous, warnings: [...warnings, violation], accepted: false };
    }
  }
  return { plan, warnings, accepted: true };
}

/** 服务端权威快照(落在工具结果 text part 的 metadata.planV2,面板优先读它)。 */
export interface PlanSnapshot {
  title: string;
  goal: string;
  done_when: string[];
  boundaries: string[];
  steps: Array<{
    id: string;
    content: string;
    status: PlanStepStatus;
    verify: string;
    evidence: string[];
    attempts: number;
    last_error: string | null;
    /** v3 才有;旧快照缺省时应回退为空依赖 / 默认预算。 */
    depends_on?: string[];
    max_attempts?: number;
  }>;
}

export function toPlanSnapshot(plan: Plan): PlanSnapshot {
  const v3 = isPlanV3(plan);
  return {
    title: plan.title,
    goal: plan.goal ?? "",
    done_when: plan.doneWhen ?? [],
    boundaries: plan.boundaries ?? [],
    steps: plan.steps.map((step, index) => ({
      id: step.id ?? `s${index + 1}`,
      content: step.content,
      status: step.status,
      verify: step.verify ?? "",
      evidence: step.evidence ?? [],
      attempts: step.attempts ?? 0,
      last_error: step.lastError ?? null,
      ...(v3
        ? {
            depends_on: step.dependsOn ?? [],
            max_attempts: step.maxAttempts ?? PLAN_MAX_ATTEMPTS_DEFAULT,
          }
        : {}),
    })),
  };
}

/** 回给模型的执行结果:只确认"记下了",不把计划原样吐回去烧上下文。
 *  v2 额外给目标/验收/边界计数与未验证数;v3 再给图状态计数。旧回执形状逐字不变。 */
export function planReceipt(plan: Plan, warnings: string[] = []) {
  const progress = planProgress(plan);
  const v2 = isPlanV2(plan);
  const v3 = isPlanV3(plan);
  const analysis = v3 ? analyzePlanGraph(plan) : null;
  const unverified = plan.steps.filter(isStepUnverified);
  return {
    status: "plan_recorded",
    total: progress.total,
    completed: progress.completed,
    in_progress: progress.inProgress,
    ...(v2
      ? {
          goal: plan.goal ?? "",
          done_when: plan.doneWhen?.length ?? 0,
          boundaries: plan.boundaries?.length ?? 0,
          unverified: unverified.length,
          ...(unverified.length ? {
            missing_evidence: unverified.map(step => step.id),
            next_action: "Call update_plan with evidence: [actual toolCallId] on each listed step. Text in verify is not evidence; reuse successful tool results rather than repeating actions.",
          } : {}),
        }
      : {}),
    ...(v3 && analysis
      ? {
          failed: plan.steps.filter((step) => step.status === "failed").length,
          ready: analysis.ready.length,
          blocked: Object.keys(analysis.blocked).length,
          retryable: analysis.retryable.length,
          exhausted: analysis.exhausted.length,
        }
      : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** 旧入口(无上一版计划时):归一化后回执。legacy=true(自主循环关闭)时强制旧形状,
 *  即使模型自发提交了 v2 字段也不改回执——开关关闭零行为差。 */
export function planToolResult(input: unknown, options: { legacy?: boolean } = {}) {
  const plan = normalizePlan(input);
  if (!options.legacy) return planReceipt(plan);
  const progress = planProgress(plan);
  return {
    status: "plan_recorded",
    total: progress.total,
    completed: progress.completed,
    in_progress: progress.inProgress,
  };
}

/** update_plan 的完整执行结果:精简回执 + 权威快照。
 *  快照只在 v2/v3 计划时携带;旧计划与非法 v3 图的输出形状见下。 */
export function planToolOutcome(
  previous: Plan | null,
  input: unknown,
  options: PlanMergeOptions = {},
) {
  const available = options.availableEvidence;
  const allowed = available ? new Set(available.map(call => call.toolCallId)) : null;
  const unknown = allowed ? [...new Set(normalizePlan(input).steps.flatMap(step => step.evidence ?? []).filter(id => !allowed.has(id)))] : [];
  const merged = unknown.length ? {
    plan: previous ?? {title:"",steps:[]}, accepted:false,
    warnings:[`Unknown evidence toolCallIds: ${unknown.join(", ")}. Use actual IDs from available_evidence; never invent IDs or use a tool name as an ID.`],
  } : mergePlan(previous, input, options);
  if (!merged.accepted) {
    // 拒绝的是本次输入,不是上一版计划。带上旧计划的权威快照,面板才不会
    // 回退去解析被拒的原始 input 而显示一份根本没被接受的图。
    const keptSnapshot = merged.plan.steps.length > 0 ? toPlanSnapshot(merged.plan) : null;
    return {
      output: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "plan_rejected",
            ...(merged.warnings.length ? { warnings: merged.warnings } : {}),
            ...(available ? {available_evidence:available.slice(-12)} : {}),
          }),
          ...(keptSnapshot ? { metadata: { planV2: keptSnapshot as unknown as JsonValue } } : {}),
        },
      ],
    };
  }
  const receipt = planReceipt(merged.plan, merged.warnings);
  const snapshot = isPlanV2(merged.plan) ? toPlanSnapshot(merged.plan) : null;
  return {
    output: [
      {
        type: "text" as const,
        text: JSON.stringify({...receipt,...(available && receipt.unverified ? {available_evidence:available.slice(-12)} : {})}),
        ...(snapshot ? { metadata: { planV2: snapshot as unknown as JsonValue } } : {}),
      },
    ],
  };
}
