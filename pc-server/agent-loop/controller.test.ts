// agent-loop/controller.test.ts — 判定表(S3,计划 §3.3 / §6 用例 3–7)
//
// 全部为纯函数验收:构造观察项与计划快照,断言判定结果(continue / inject / halt)
// 与记账回调(replan / stall / goal)。不触网、不落库、不跑真实 Provider。
import { describe, expect, test } from "bun:test";

import type { LoopToolObservation } from "../inference-engine/events";
import { normalizePlan, type Plan, type PlanStepStatus } from "../tools/plan";
import {
  AgentLoopController,
  buildToolObservation,
  errorSignatureOf,
  normalizeToolArguments,
  outputSignature,
  verifyPlanCompletion,
  type AgentLoopControllerConfig,
  type AgentLoopControllerDeps,
} from "./controller";

function config(overrides: Partial<AgentLoopControllerConfig> = {}): AgentLoopControllerConfig {
  return {
    maxReplans: 2,
    stallRepeatLimit: 3,
    sameErrorLimit: 3,
    requireVerifiedCompletion: true,
    ...overrides,
  };
}

function v2Plan(
  steps: Array<{ id: string; status: PlanStepStatus; evidence?: string[] }>,
  goal = "finish the task",
): Plan {
  return normalizePlan({
    title: "test plan",
    goal,
    done_when: ["all steps settled"],
    steps: steps.map((step) => ({
      id: step.id,
      content: `step ${step.id}`,
      status: step.status,
      evidence: step.evidence ?? [],
    })),
  });
}

function graphPlan(
  steps: Array<{
    id: string;
    status: PlanStepStatus;
    evidence?: string[];
    depends_on?: string[];
    attempts?: number;
    max_attempts?: number;
    last_error?: string;
  }>,
): Plan {
  return normalizePlan(
    {
      title: "graph plan",
      goal: "finish the graph",
      done_when: ["all steps settled"],
      steps: steps.map((step) => ({
        id: step.id,
        content: `step ${step.id}`,
        status: step.status,
        evidence: step.evidence ?? [],
        depends_on: step.depends_on,
        attempts: step.attempts,
        max_attempts: step.max_attempts,
        last_error: step.last_error,
      })),
    },
    { graph: true, trusted: true },
  );
}

let callSeq = 0;function obs(
  toolName: string,
  args: unknown,
  outputText: string,
  errorText?: string,
): LoopToolObservation {
  callSeq += 1;
  return {
    toolCallId: `tc${callSeq}`,
    toolName,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
    outputText: errorText ?? outputText,
    errorSignature: errorText ? errorSignatureOf(toolName, errorText) : null,
  };
}

test("missing-evidence repair reuses successful call IDs and still requires the evidence field", () => {
  let plan = v2Plan([{id:"s1",status:"completed"}]);
  const controller = new AgentLoopController(config(), {readPlan:()=>plan});
  const success = obs("app_control", {action:"api"}, "saved");
  const failure = obs("bad_tool", {}, "", "failed");
  controller.evaluateToolRound([success, failure, obs("update_plan", {}, "recorded")]);
  const repair = controller.evaluateFinal();
  expect(repair.action).toBe("inject");
  if (repair.action !== "inject") throw new Error("Expected repair instructions");
  expect(repair.text).toContain('"evidence":["actual_tool_call_id"]');
  expect(repair.text).toContain(success.toolCallId);
  expect(repair.text).not.toContain(failure.toolCallId);
  expect(repair.text).toContain("verify field");
  expect(repair.text).toContain("instead of rerunning");
  plan = v2Plan([{id:"s1",status:"completed",evidence:[success.toolCallId]}]);
  expect(controller.evaluateFinal()).toEqual({action:"continue"});
});

function harness(
  initialPlan: Plan | null,
  overrides: Partial<AgentLoopControllerConfig> = {},
) {
  const state: {
    plan: Plan | null;
    replans: Array<{ reason: string; replanCount: number; settled: number }>;
    stalls: Array<{ kind: string; reason: string }>;
    goals: string[];
  } = { plan: initialPlan, replans: [], stalls: [], goals: [] };
  const deps: AgentLoopControllerDeps = {
    readPlan: () => state.plan,
    onReplan: (info) =>
      state.replans.push({ reason: info.reason, replanCount: info.replanCount, settled: info.settled }),
    onStall: (info) => state.stalls.push({ kind: info.kind, reason: info.reason }),
    onGoal: (goal) => state.goals.push(goal),
  };
  return { controller: new AgentLoopController(config(overrides), deps), state };
}

describe("S-F5 单轮体积预算刹车", () => {
  const round = (rawTokensEst: number) => ({
    round: 1,
    calls: 3,
    nestedCalls: 1,
    okCalls: 3,
    resultBytesRaw: rawTokensEst * 4,
    resultBytesClipped: rawTokensEst,
    rawTokensEst,
    savedTokensEst: 0,
  });

  test("默认 0 = 关:超多 token 也不干预", () => {
    const { controller } = harness(null);
    expect(controller.evaluateToolRound([], round(999_999))).toEqual({ action: "continue" });
  });

  test("超预算先注入一次收口提示,连续两轮超限 → awaiting_user", () => {
    const { controller, state } = harness(null, { roundBudgetTokens: 1000 });
    const first = controller.evaluateToolRound([], round(2000));
    expect(first.action).toBe("inject");
    if (first.action === "inject") {
      expect(first.text).toContain("Output budget");
      expect(first.text).toContain("~2000 tokens");
    }
    const second = controller.evaluateToolRound([], round(2000));
    expect(second.action).toBe("halt");
    if (second.action === "halt") {
      expect(second.status).toBe("awaiting_user");
      expect(second.reason).toContain("连续两轮");
    }
    expect(state.stalls.at(-1)?.kind).toBe("budget");
  });

  test("降到预算内即清零:再超限只回到提示,不直接停", () => {
    const { controller } = harness(null, { roundBudgetTokens: 1000 });
    expect(controller.evaluateToolRound([], round(2000)).action).toBe("inject");
    expect(controller.evaluateToolRound([], round(500))).toEqual({ action: "continue" });
    const again = controller.evaluateToolRound([], round(2000));
    expect(again.action).toBe("inject");
  });

  test("硬停滞优先:同参同输出三次 → stalled 而不是预算提示", () => {
    const { controller } = harness(null, { roundBudgetTokens: 1000 });
    const same = obs("read", { path: "a" }, "content");
    controller.evaluateToolRound([same], round(10));
    controller.evaluateToolRound([same], round(10));
    const third = controller.evaluateToolRound([same], round(2000));
    expect(third.action).toBe("halt");
    if (third.action === "halt") expect(third.status).toBe("stalled");
  });
});

describe("判定表 — 连续重复同参同输出(规则 3)", () => {
  test("前两次继续(第二次先提示换路径),第三次 halted=stalled", () => {
    const { controller, state } = harness(null);
    const round = () => controller.evaluateToolRound([obs("bash", { cmd: "ls" }, "a.txt")]);

    expect(round().action).toBe("continue");
    const hint = round();
    expect(hint.action).toBe("inject");
    if (hint.action === "inject") expect(hint.text).toContain("repeating the same bash call");

    const halt = round();
    expect(halt).toMatchObject({ action: "halt", status: "stalled" });
    if (halt.action === "halt") expect(halt.reason).toContain("连续调用 3 次");
    expect(state.stalls).toHaveLength(1);
    expect(state.stalls[0].kind).toBe("repeat");
    expect(state.stalls[0].reason).toContain("bash");
  });

  test("换参数(分页/翻页)重置重复计数,不误判停滞", () => {
    const { controller } = harness(null);
    expect(controller.evaluateToolRound([obs("bash", { cmd: "ls", page: 1 }, "a")]).action).toBe("continue");
    expect(controller.evaluateToolRound([obs("bash", { cmd: "ls", page: 1 }, "a")]).action).toBe("inject");
    // 参数变 → 新链;再连续两次同参仍只是提示,不 halt
    expect(controller.evaluateToolRound([obs("bash", { cmd: "ls", page: 2 }, "b")]).action).toBe("continue");
    expect(controller.evaluateToolRound([obs("bash", { cmd: "ls", page: 2 }, "b")]).action).toBe("inject");
    expect(controller.evaluateToolRound([obs("bash", { cmd: "ls", page: 2 }, "b")]).action).toBe("halt");
  });

  test("输出变化(拿到新信息)重置重复计数", () => {
    const { controller } = harness(null);
    const run = (text: string) => controller.evaluateToolRound([obs("read", { path: "f" }, text)]).action;
    expect(run("line1")).toBe("continue");
    expect(run("line1")).toBe("inject");
    expect(run("line1 plus line2")).toBe("continue"); // 输出变 → 重置
    // 同一组 (参数, 输出) 已经提示过一次换路径,不再重复提示,直接数到上限
    expect(run("line1 plus line2")).toBe("continue");
    expect(run("line1 plus line2")).toBe("halt");
  });

  test("参数键序不同视为同一次调用;stallRepeatLimit 最小值钳制为 2", () => {
    const { controller } = harness(null, { stallRepeatLimit: 1 });
    expect(controller.evaluateToolRound([obs("bash", '{"a":1,"b":2}', "x")]).action).toBe("continue");
    const second = controller.evaluateToolRound([obs("bash", '{"b":2,"a":1}', "x")]);
    expect(second).toMatchObject({ action: "halt", status: "stalled" });
  });
});

describe("判定表 — 同一错误签名连续出现(规则 4)", () => {
  const failing = (n: number) =>
    obs("bash", { attempt: n }, `Error: connection reset after ${n} tries`, `Error: connection reset after ${n} tries`);

  test("连续 3 次同错 → 注入一次 replan 并记账(不 halt)", () => {
    const { controller, state } = harness(v2Plan([{ id: "s1", status: "in_progress" }]));
    expect(controller.evaluateToolRound([failing(1)]).action).toBe("continue");
    expect(controller.evaluateToolRound([failing(2)]).action).toBe("continue");
    const decision = controller.evaluateToolRound([failing(3)]);
    expect(decision.action).toBe("inject");
    if (decision.action === "inject") expect(decision.text).toContain("Replan required");
    expect(state.replans).toHaveLength(1);
    expect(state.replans[0]).toMatchObject({ replanCount: 1, settled: 0 });
    expect(controller.replans).toBe(1);
  });

  test("replan 上限(默认 2 次)后转 awaiting_user", () => {
    const { controller, state } = harness(v2Plan([{ id: "s1", status: "in_progress" }]));
    let n = 0;
    const batch = () => controller.evaluateToolRound([failing((n += 1)), failing((n += 1)), failing((n += 1))]);

    expect(batch().action).toBe("inject"); // replan 1
    expect(batch().action).toBe("inject"); // replan 2
    const halt = batch();
    expect(halt).toMatchObject({ action: "halt", status: "awaiting_user" });
    expect(state.stalls.map((s) => s.kind)).toEqual(["same_error"]);
    expect(controller.replans).toBe(2);
  });

  test("maxReplans=0:首次触发同错上限直接交给人", () => {
    const { controller, state } = harness(v2Plan([{ id: "s1", status: "in_progress" }]), { maxReplans: 0 });
    controller.evaluateToolRound([failing(1)]);
    controller.evaluateToolRound([failing(2)]);
    expect(controller.evaluateToolRound([failing(3)])).toMatchObject({ action: "halt", status: "awaiting_user" });
    expect(state.replans).toHaveLength(0);
  });

  test("中间成功一次会打断\"连续\",不触发 replan", () => {
    const { controller, state } = harness(v2Plan([{ id: "s1", status: "in_progress" }]));
    controller.evaluateToolRound([failing(1)]);
    controller.evaluateToolRound([failing(2)]);
    // 成功一次(参数/输出都不同,不落入重复规则)
    expect(controller.evaluateToolRound([obs("bash", { cmd: "cat ok" }, "done")]).action).toBe("continue");
    controller.evaluateToolRound([failing(3)]);
    expect(controller.evaluateToolRound([failing(4)]).action).toBe("continue");
    expect(state.replans).toHaveLength(0);
  });

  test("计划有进展 → 重新允许 replan;连续两次无进展 → awaiting_user", () => {
    const { controller, state } = harness(v2Plan([{ id: "s1", status: "in_progress" }]), { maxReplans: 5 });
    let n = 0;
    const batch = () => controller.evaluateToolRound([failing((n += 1)), failing((n += 1)), failing((n += 1))]);

    expect(batch().action).toBe("inject"); // replan 1(settled 0)
    // 模型推进了一步计划:settled 0 → 1,算有进展
    state.plan = v2Plan([
      { id: "s1", status: "completed", evidence: ["tc-ev"] },
      { id: "s2", status: "in_progress" },
    ]);
    expect(batch().action).toBe("inject"); // replan 2(settled 1,无进展计数归零)
    expect(batch().action).toBe("inject"); // replan 3(settled 1,第一次无进展)
    const halt = batch(); // replan 4 之前:连续第二次无进展 → 交给人
    expect(halt).toMatchObject({ action: "halt", status: "awaiting_user" });
    expect(controller.replans).toBe(3);
  });

  test("重复停滞优先于同错 replan", () => {
    const { controller, state } = harness(null);
    const same = () =>
      obs("bash", { cmd: "npm test" }, "Error: boom", "Error: boom");
    controller.evaluateToolRound([same()]);
    controller.evaluateToolRound([same()]);
    const halt = controller.evaluateToolRound([same()]);
    expect(halt).toMatchObject({ action: "halt", status: "stalled" });
    expect(state.stalls.map((s) => s.kind)).toEqual(["repeat"]);
    expect(state.replans).toHaveLength(0);
  });
});

describe("判定表 — 最终轮完成校验(规则 1/2)", () => {
  test("未了结步骤 → 第一次注入重采样,同一份未了结状态再犯 → stalled", () => {
    const { controller, state } = harness(
      v2Plan([
        { id: "s1", status: "completed", evidence: ["tc1"] },
        { id: "s2", status: "pending" },
      ]),
    );
    const first = controller.evaluateFinal();
    expect(first.action).toBe("inject");
    if (first.action === "inject") {
      expect(first.text).toContain("Do not finish yet");
      expect(first.text).toContain("s2");
    }
    const second = controller.evaluateFinal();
    expect(second).toMatchObject({ action: "halt", status: "stalled" });
    expect(state.stalls.map((s) => s.kind)).toEqual(["unsettled"]);
  });

  test("未了结状态变化(计划推进但仍有剩余)→ 允许再次注入,不判停滞", () => {
    const { controller } = harness(
      v2Plan([
        { id: "s1", status: "pending" },
        { id: "s2", status: "pending" },
      ]),
    );
    expect(controller.evaluateFinal().action).toBe("inject");
    // 推进了 s1,仍有 s2:cancelled 计入已了结
    const changed = harness(
      v2Plan([
        { id: "s1", status: "cancelled" },
        { id: "s2", status: "pending" },
      ]),
    ).controller;
    expect(changed.evaluateFinal().action).toBe("inject");
    expect(changed.evaluateFinal()).toMatchObject({ action: "halt", status: "stalled" });
    expect(controller.evaluateFinal().action).toBe("halt");
  });

  test("completed 但无证据 = 未验证:注入里点名步骤;开关关闭证据要求则放行", () => {
    const plan = v2Plan([{ id: "s1", status: "completed" }]);
    const strict = harness(plan);
    const inject = strict.controller.evaluateFinal();
    expect(inject.action).toBe("inject");
    if (inject.action === "inject") expect(inject.text).toContain("without tool evidence");

    const lenient = harness(plan, { requireVerifiedCompletion: false });
    expect(lenient.controller.evaluateFinal()).toEqual({ action: "continue" });
  });

  test("全部了结(cancelled 也算)→ continue", () => {
    const { controller, state } = harness(
      v2Plan([
        { id: "s1", status: "completed", evidence: ["tc1"] },
        { id: "s2", status: "cancelled" },
      ]),
    );
    expect(controller.evaluateFinal()).toEqual({ action: "continue" });
    expect(state.stalls).toHaveLength(0);
  });

  test("无计划 / 旧形状计划 / 空步骤 → 不拦截(旧会话开总开关也不能被卡死)", () => {
    expect(harness(null).controller.evaluateFinal()).toEqual({ action: "continue" });
    const legacy = normalizePlan({ steps: [{ content: "a", status: "pending" }] });
    expect(harness(legacy).controller.evaluateFinal()).toEqual({ action: "continue" });
    expect(harness(normalizePlan({ goal: "g", steps: [] })).controller.evaluateFinal()).toEqual({
      action: "continue",
    });
  });

  test("计划目标回填给运行记录", () => {
    const { controller, state } = harness(v2Plan([{ id: "s1", status: "pending" }], "整理周报"));
    controller.evaluateToolRound([obs("read", { path: "a" }, "ok")]);
    expect(state.goals.at(-1)).toBe("整理周报");
  });
});

describe("判定表 — 任务图 v3", () => {
  test("halts awaiting_user when a step exhausts its retry budget", () => {
    const { controller, state } = harness(
      graphPlan([
        {
          id: "s1",
          status: "failed",
          attempts: 3,
          max_attempts: 3,
          last_error: "timeout",
        },
      ]),
    );
    expect(controller.evaluateFinal()).toEqual({
      action: "halt",
      status: "awaiting_user",
      reason: "任务图步骤重试预算耗尽:s1",
    });
    expect(state.stalls.map((stall) => stall.kind)).toEqual(["exhausted"]);
  });

  test("injects retryable step id and attempt budget", () => {
    const { controller } = harness(
      graphPlan([
        { id: "s1", status: "failed", attempts: 1, max_attempts: 3, last_error: "timeout" },
      ]),
    );
    const decision = controller.evaluateFinal();
    expect(decision.action).toBe("inject");
    expect(decision.action === "inject" ? decision.text : "").toContain("s1 (attempt 1/3)");
  });

  test("does not finish while blocked steps remain, and stalls if nothing changes", () => {
    const { controller, state } = harness(
      graphPlan([
        { id: "s1", status: "completed" },
        { id: "s2", status: "pending", depends_on: ["s1"] },
      ]),
    );
    const first = controller.evaluateFinal();
    expect(first.action).toBe("inject");
    expect(first.action === "inject" ? first.text : "").toContain("s2 needs s1");
    const second = controller.evaluateFinal();
    expect(second).toMatchObject({ action: "halt", status: "stalled" });
    expect(state.stalls.map((stall) => stall.kind)).toEqual(["unsettled"]);
  });

  test("does not unblock dependents of unverified completions", () => {
    const { controller } = harness(
      graphPlan([
        { id: "s1", status: "completed" },
        { id: "s2", status: "pending", depends_on: ["s1"] },
      ]),
    );
    const decision = controller.evaluateFinal();
    expect(decision.action).toBe("inject");
    const text = decision.action === "inject" ? decision.text : "";
    expect(text).toContain("Blocked steps");
    expect(text).toContain("without tool evidence: s1");
  });

  test("allows completion only when every non-cancelled step is verified", () => {
    const { controller } = harness(
      graphPlan([
        { id: "s1", status: "completed", evidence: ["tc-1"] },
        { id: "s2", status: "cancelled" },
        { id: "s3", status: "completed", evidence: ["tc-2"], depends_on: ["s1"] },
      ]),
    );
    expect(controller.evaluateFinal()).toEqual({ action: "continue" });
  });
});

describe("判定表 — 工具函数", () => {
  test("normalizeToolArguments:嵌套键排序;非法 JSON 退化为去空白原文", () => {
    expect(normalizeToolArguments('{"b":{"d":2,"c":1},"a":[2,1]}')).toBe(
      '{"a":[2,1],"b":{"c":1,"d":2}}',
    );
    expect(normalizeToolArguments("  {not json}  ")).toBe("{not json}");
    expect(normalizeToolArguments("")).toBe("");
  });

  test("outputSignature:空白折叠等价、内容不同则不同", () => {
    expect(outputSignature("a b\n c")).toBe(outputSignature("a  b c"));
    expect(outputSignature("a b c")).not.toBe(outputSignature("a b d"));
  });

  test("errorSignatureOf:丢弃易变 id/数字,保留错误语义", () => {
    const a = errorSignatureOf("bash", "ENOENT 8f3a2b1c9d /tmp/file-12.txt");
    const b = errorSignatureOf("bash", "enoent  0011223344 /tmp/file-99.txt");
    expect(a).toBe(b);
    expect(errorSignatureOf("bash", "permission denied")).not.toBe(a);
  });

  test("buildToolObservation:错误载荷进 outputText 并产出签名;成功为 null", () => {
    const failed = buildToolObservation(
      { id: "c1", name: "bash", arguments: '{"cmd":"x"}' },
      [{ error: "spawn failed: EACCES" }],
    );
    expect(failed.outputText).toBe("spawn failed: EACCES");
    expect(failed.errorSignature).toBe(errorSignatureOf("bash", "spawn failed: EACCES"));

    const ok = buildToolObservation(
      { id: "c2", name: "read", arguments: "{}" },
      [
        { type: "text", text: "hello" },
        { type: "image", url: "file:///a.png" },
      ],
    );
    expect(ok.outputText).toContain("hello");
    expect(ok.outputText).toContain("file:///a.png");
    expect(ok.errorSignature).toBeNull();
  });

  test("verifyPlanCompletion:settled 只数通过校验的步骤", () => {
    const plan = v2Plan([
      { id: "s1", status: "completed", evidence: ["e1"] },
      { id: "s2", status: "cancelled" },
      { id: "s3", status: "completed" },
      { id: "s4", status: "in_progress" },
    ]);
    expect(verifyPlanCompletion(plan, true)).toEqual({
      ok: false,
      pending: ["s4"],
      unverified: ["s3"],
      settled: 2,
    });
    expect(verifyPlanCompletion(plan, false)).toMatchObject({ pending: ["s4"], unverified: [], settled: 3 });
  });
});
