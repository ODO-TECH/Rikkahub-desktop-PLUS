// tools/plan.test.ts — update_plan 共享核心(声明/归一化/进度/回执)行为锁。
//
// 这个文件同时被 pc-server 双引擎和 web-ui(@server 别名)消费,所以钉的是"两侧读到同一份
// 形状",不是实现细节:
//   1) 归一化(codex 式"不信模型"):steps/plan/todos 三种键、字符串步、别名状态、缺 content
//      的畸形项、步数与文案钳制;
//   2) 进度口径:cancelled 算"已了结"但不算完成,finished 只在全部了结时为真;
//   3) 回执形状:只确认记下了,不把计划原样吐回上下文。
import { describe, expect, test } from "bun:test";
import {
  isPlanV2,
  isPlanV3,
  isStepUnverified,
  mergePlan,
  normalizePlan,
  planFromToolPart,
  PLAN_MAX_CONTENT_LEN,
  PLAN_MAX_STEPS,
  planProgress,
  planReceipt,
  planStepsSchema,
  planToolOutcome,
  planToolParameters,
  PLAN_TOOL_NAME,
  planToolResult,
  toPlanSnapshot,
  type Plan,
  type PlanStep,
} from "./plan";

test("plan verification rejects invented call IDs and offers actual evidence for repair", () => {
  const availableEvidence=[{toolCallId:"tc-time",toolName:"get_time_info"}];
  const pending=normalizePlan({goal:"read time",steps:[{id:"s1",content:"read time",status:"pending"}]});
  const input={steps:[{id:"s1",content:"read time",status:"completed",evidence:["call_get_time_info"]}]};
  const rejected=planToolOutcome(pending,input,{availableEvidence});
  expect(JSON.parse(rejected.output[0].text)).toMatchObject({status:"plan_rejected",available_evidence:availableEvidence});
  expect(planFromToolPart({input,output:rejected.output})?.steps[0].status).toBe("pending");
  const missing=planToolOutcome(pending,{steps:[{id:"s1",content:"read time",status:"completed"}]},{availableEvidence});
  expect(JSON.parse(missing.output[0].text)).toMatchObject({unverified:1,missing_evidence:["s1"],available_evidence:availableEvidence});
  input.steps[0].evidence=["tc-time"];
  const repaired=planToolOutcome(pending,input,{availableEvidence});
  expect(JSON.parse(repaired.output[0].text)).toMatchObject({status:"plan_recorded",unverified:0});
});

describe("normalizePlan — 归一化与钳制", () => {
  test("非法/空输入读成空计划,调用方据此判定「没有计划」", () => {
    for (const input of [undefined, null, 42, "steps", [], {}, { steps: "x" }]) {
      expect(normalizePlan(input)).toEqual({ title: "", steps: [] });
    }
  });

  test("steps / plan / todos 三种键、title / name 两种标题同形", () => {
    const expected: PlanStep[] = [
      { content: "抓取原文", status: "in_progress" },
      { content: "整理笔记", status: "pending" },
    ];
    expect(normalizePlan({ title: "读书", steps: expected }).title).toBe("读书");
    expect(normalizePlan({ steps: expected }).steps).toEqual(expected);
    expect(normalizePlan({ plan: expected }).steps).toEqual(expected);
    expect(normalizePlan({ todos: expected }).steps).toEqual(expected);
    expect(normalizePlan({ name: "别名标题", steps: expected }).title).toBe("别名标题");
  });

  test("字符串步补 pending;content/title/text/description 任一同义字段都算正文", () => {
    expect(normalizePlan({ steps: ["先做 A", "", "  做 B  "] }).steps).toEqual([
      { content: "先做 A", status: "pending" },
      { content: "做 B", status: "pending" },
    ]);
    const variants = normalizePlan({
      steps: [
        { title: "按 title" },
        { text: "按 text" },
        { description: "按 description" },
        { content: "按 content" },
        { status: "completed" },
      ],
    });
    expect(variants.steps.map((s) => s.content)).toEqual([
      "按 title",
      "按 text",
      "按 description",
      "按 content",
    ]);
  });

  test("状态别名与大小写归一;认不出的状态落 pending", () => {
    const steps = normalizePlan({
      steps: [
        { content: "a", status: "DONE" },
        { content: "b", status: "in progress" },
        { content: "c", status: "Canceled" },
        { content: "d", status: "wip" },
        { content: "e", status: 7 },
      ],
    }).steps;
    expect(steps.map((s) => s.status)).toEqual([
      "completed",
      "in_progress",
      "cancelled",
      "pending",
      "pending",
    ]);
  });

  test("步数与单步文案都钳制(25 步 → 20 步;超长文案截到上限)", () => {
    const long = "字".repeat(PLAN_MAX_CONTENT_LEN + 40);
    const plan = normalizePlan({
      steps: Array.from({ length: 25 }, (_, index) => ({
        content: index === 0 ? long : `第 ${index} 步`,
        status: "pending",
      })),
    });
    expect(plan.steps.length).toBe(PLAN_MAX_STEPS);
    expect(plan.steps[0].content.length).toBe(PLAN_MAX_CONTENT_LEN);
  });

  test("title 超长同样钳到 80 字", () => {
    expect(normalizePlan({ title: "标".repeat(120), steps: ["a"] }).title.length).toBe(80);
  });
});

describe("planProgress — 进度口径", () => {
  test("cancelled 计入 settled,不计入 completed", () => {
    const plan = normalizePlan({
      steps: [
        { content: "a", status: "completed" },
        { content: "b", status: "cancelled" },
        { content: "c", status: "in_progress" },
        { content: "d" },
      ],
    });
    expect(planProgress(plan)).toEqual({
      total: 4,
      completed: 1,
      cancelled: 1,
      settled: 2,
      inProgress: "c",
      finished: false,
    });
  });

  test("全部了结才算 finished;空计划不算", () => {
    expect(planProgress(normalizePlan({ steps: [] })).finished).toBe(false);
    const done = normalizePlan({
      steps: [
        { content: "a", status: "completed" },
        { content: "b", status: "cancelled" },
      ],
    });
    expect(planProgress(done).finished).toBe(true);
  });
});

describe("声明与回执", () => {
  test("参数面 required 只有 steps——title 可选,模型漏写也能出面板", () => {
    expect(planToolParameters()).toMatchObject({ type: "object", required: ["steps"] });
  });

  test("回执确认「记下了」并带上计数,不回吐步骤正文", () => {
    const result = planToolResult({
      title: "整理图书馆",
      steps: [
        { content: "清点藏书", status: "completed" },
        { content: "编目", status: "in_progress" },
      ],
    });
    expect(result).toEqual({
      status: "plan_recorded",
      total: 2,
      completed: 1,
      in_progress: "编目",
    });
    expect(JSON.stringify(result)).not.toContain("清点藏书");
  });

  test("工具名常量与 UI 侧解析同源(改名即红)", () => {
    expect(PLAN_TOOL_NAME).toBe("update_plan");
  });
});

describe("计划 v2 — 声明门控(自主循环关闭时零行为差)", () => {
  const props = (v2: boolean) =>
    (planToolParameters(v2) as { properties: Record<string, unknown> }).properties;

  test("v2 才声明目标三件套;关闭时参数面与引入前一致", () => {
    expect(Object.keys(props(false))).toEqual(["title", "steps"]);
    expect(Object.keys(props(true))).toEqual(["title", "goal", "done_when", "boundaries", "steps"]);
  });

  test("v2 才声明 step 的 id/verify/evidence;attempts 永不出现在 schema 里", () => {
    const stepOf = (v2: boolean) =>
      (planStepsSchema(v2) as { items: { properties: Record<string, unknown> } }).items.properties;
    expect(Object.keys(stepOf(false))).toEqual(["content", "status"]);
    expect(Object.keys(stepOf(true))).toEqual(["content", "status", "id", "verify", "evidence"]);
    // attempts 由代码维护:声明出来只会诱导模型瞎写。
    expect(Object.keys(stepOf(true))).not.toContain("attempts");
  });

  test("legacy 回执:模型即使提交 v2 字段也只得旧形状(开关关闭逐字一致)", () => {
    const result = planToolResult(
      {
        title: "迁移",
        goal: "把旧数据迁到新表",
        done_when: ["行数一致"],
        steps: [
          { id: "s1", content: "备份", status: "completed", evidence: ["call_1"] },
          { id: "s2", content: "迁移", status: "in_progress" },
        ],
      },
      { legacy: true },
    );
    expect(result).toEqual({
      status: "plan_recorded",
      total: 2,
      completed: 1,
      in_progress: "迁移",
    });
  });

  test("v3 才声明依赖、预算与 failed 状态;关闭时 enum 与引入前一致", () => {
    const stepOf = (v2: boolean, graph: boolean) =>
      (planStepsSchema(v2, graph) as {
        items: { properties: { status: { enum: string[] }; [key: string]: unknown } };
      }).items.properties;
    expect(Object.keys(stepOf(true, false))).toEqual(["content", "status", "id", "verify", "evidence"]);
    expect(Object.keys(stepOf(true, true))).toEqual([
      "content",
      "status",
      "id",
      "verify",
      "evidence",
      "depends_on",
      "max_attempts",
    ]);
    expect(stepOf(true, false).status.enum).not.toContain("failed");
    expect(stepOf(true, true).status.enum).toContain("failed");
  });

  test("v3 回执带图状态计数", () => {
    const receipt = planReceipt(
      normalizePlan(
        {
          goal: "迁移",
          steps: [
            { id: "s1", content: "导出", status: "completed", evidence: ["tc"] },
            { id: "s2", content: "导入", status: "pending", depends_on: ["s1"] },
          ],
        },
        { graph: true, trusted: true },
      ),
    );
    expect(receipt).toMatchObject({ ready: 1, blocked: 0, retryable: 0, exhausted: 0, failed: 0 });
  });
});

describe("计划 v2 — 归一化与快照(自主循环 S2)", () => {
  const input = {
    title: "迁移",
    goal: "把旧数据迁到新表",
    done_when: ["新表行数 = 旧表行数", "回滚脚本演练通过"],
    boundaries: ["不删测试", "不越工作区"],
    steps: [
      { id: "s1", content: "导出", status: "completed", verify: "wc -l", evidence: ["tc-1"], attempts: 3 },
      { content: "导入", status: "in_progress", verify: "count(*)" },
    ],
  };

  test("v2 字段归一化;模型提交的 attempts 在非可信输入里不采信", () => {
    const plan = normalizePlan(input);
    expect(isPlanV2(plan)).toBe(true);
    expect(plan.goal).toBe("把旧数据迁到新表");
    expect(plan.doneWhen).toEqual(["新表行数 = 旧表行数", "回滚脚本演练通过"]);
    expect(plan.boundaries).toEqual(["不删测试", "不越工作区"]);
    expect(plan.steps[0]).toEqual({
      id: "s1",
      content: "导出",
      status: "completed",
      verify: "wc -l",
      evidence: ["tc-1"],
      attempts: 0,
      lastError: null,
    });
    expect(plan.steps[1].id).toBe("s2");
  });

  test("可信快照保留 attempts;快照往返归一化不丢字段", () => {
    const trusted = normalizePlan(
      {
        ...input,
        steps: [{ ...input.steps[0], attempts: 2 }, input.steps[1]],
      },
      { trusted: true },
    );
    expect(trusted.steps[0].attempts).toBe(2);
    const roundTrip = normalizePlan(toPlanSnapshot(trusted), { trusted: true });
    expect(roundTrip.goal).toBe(trusted.goal);
    expect(roundTrip.steps[0]).toMatchObject({ id: "s1", attempts: 2, evidence: ["tc-1"] });
  });

  test("旧输入仍是旧形状:不补 v2 空字段,isPlanV2=false", () => {
    const plan = normalizePlan({ title: "旧", steps: [{ content: "a", status: "completed" }] });
    expect(plan).toEqual({ title: "旧", steps: [{ content: "a", status: "completed" }] });
    expect(isPlanV2(plan)).toBe(false);
  });

  test("未验证:completed 且无 evidence;有证据/取消/进行中都不算", () => {
    expect(isStepUnverified({ content: "a", status: "completed", evidence: [] })).toBe(true);
    expect(isStepUnverified({ content: "a", status: "completed" })).toBe(true);
    expect(isStepUnverified({ content: "a", status: "completed", evidence: ["tc"] })).toBe(false);
    expect(isStepUnverified({ content: "a", status: "cancelled" })).toBe(false);
    expect(isStepUnverified({ content: "a", status: "in_progress" })).toBe(false);
  });
});

describe("计划 v2 — 改写保护与计数(自主循环 S2)", () => {
  // 前值来自服务端权威快照(attempts 可信),不是模型输入。
  const base: Plan = normalizePlan(
    {
      title: "迁移",
      goal: "原目标",
      done_when: ["条件 A"],
      boundaries: ["不删测试"],
      steps: [
        { id: "s1", content: "导出", status: "in_progress", verify: "wc -l", evidence: ["tc-1"], attempts: 2 },
        { id: "s2", content: "导入", status: "pending" },
      ],
    },
    { trusted: true },
  );

  test("同轮内改 goal/done_when/boundaries 被拒绝:保留旧值并回执警告", () => {
    const merged = mergePlan(base, {
      goal: "新目标",
      done_when: ["条件 B"],
      boundaries: ["可以删测试"],
      steps: [{ id: "s1", content: "导出", status: "in_progress" }],
    });
    expect(merged.plan.goal).toBe("原目标");
    expect(merged.plan.doneWhen).toEqual(["条件 A"]);
    expect(merged.plan.boundaries).toEqual(["不删测试"]);
    expect(merged.warnings.join("\n")).toContain("goal is locked");
    expect(merged.warnings.join("\n")).toContain("done_when is locked");
    expect(merged.warnings.join("\n")).toContain("boundaries are locked");
  });

  test("新用户消息之后(allowGoalChange)才允许改写目标三件套", () => {
    const merged = mergePlan(
      base,
      {
        goal: "新目标",
        done_when: ["条件 B"],
        boundaries: [],
        steps: [{ id: "s1", content: "导出", status: "pending" }],
      },
      { allowGoalChange: true },
    );
    expect(merged.plan.goal).toBe("新目标");
    expect(merged.plan.doneWhen).toEqual(["条件 B"]);
    // 空列表不清空旧边界
    expect(merged.plan.boundaries).toEqual(["不删测试"]);
    expect(merged.warnings).toEqual([]);
  });

  test("省略目标字段不清空旧值;attempts/evidence 向后携带且模型不能清零", () => {
    const merged = mergePlan(base, {
      steps: [{ id: "s1", content: "导出", status: "pending", attempts: 0, evidence: [] }],
    });
    expect(merged.plan.goal).toBe("原目标");
    expect(merged.plan.steps[0]).toMatchObject({
      attempts: 2,
      evidence: ["tc-1"],
      verify: "wc -l",
    });
  });

  test("旧形状的后续提交按 content 匹配也能携带代码字段", () => {
    const merged = mergePlan(base, {
      steps: [{ content: "导出", status: "completed" }],
    });
    expect(merged.plan.steps[0]).toMatchObject({ id: "s1", attempts: 2, evidence: ["tc-1"] });
    expect(merged.plan.goal).toBe("原目标");
  });

  test("空 steps 视为误发:保留上一版计划并警告", () => {
    const merged = mergePlan(base, { steps: [] });
    expect(merged.plan.steps.map((step) => step.id)).toEqual(["s1", "s2"]);
    expect(merged.warnings.join("\n")).toContain("empty plan ignored");
  });

  test("回执:旧计划逐字不变;v2 带计数与未验证数", () => {
    const legacy = planToolResult({
      title: "旧",
      steps: [{ content: "a", status: "completed" }],
    });
    expect(legacy).toEqual({ status: "plan_recorded", total: 1, completed: 1, in_progress: null });

    const v2 = planToolOutcome(null, {
      goal: "G",
      done_when: ["D"],
      boundaries: [],
      steps: [
        { id: "s1", content: "a", status: "completed" },
        { id: "s2", content: "b", status: "completed", evidence: ["tc"] },
      ],
    });
    const receipt = JSON.parse(v2.output[0].text);
    expect(receipt).toMatchObject({
      status: "plan_recorded",
      goal: "G",
      done_when: 1,
      boundaries: 0,
      unverified: 1,
    });
    expect(v2.output[0].metadata?.planV2).toMatchObject({ goal: "G" });
  });

  test("权威快照:被拒绝的篡改不会成为下一轮基线", () => {
    const first = planToolOutcome(null, {
      goal: "真目标",
      steps: [{ id: "s1", content: "a", status: "pending" }],
    });
    const snapshot = first.output[0].metadata!.planV2;
    const previous = normalizePlan(snapshot, { trusted: true });
    const second = planToolOutcome(previous, {
      goal: "篡改目标",
      steps: [{ id: "s1", content: "a", status: "pending" }],
    });
    const receipt = JSON.parse(second.output[0].text);
    expect(receipt.goal).toBe("真目标");
    expect(receipt.warnings.join("\n")).toContain("goal is locked");
    expect((second.output[0].metadata!.planV2 as { goal: string }).goal).toBe("真目标");
  });

  test("旧形状且无前值时,执行结果不带 metadata(与引入前逐字一致)", () => {
    const outcome = planToolOutcome(null, {
      title: "旧",
      steps: [{ content: "a", status: "pending" }],
    });
    expect(outcome.output[0].metadata).toBeUndefined();
  });
});

describe("计划 v3 — 任务图合并与重试所有权", () => {
  const base: Plan = normalizePlan(
    {
      goal: "迁移",
      steps: [
        { id: "s1", content: "导出", status: "in_progress", max_attempts: 3 },
        { id: "s2", content: "导入", status: "pending", depends_on: ["s1"] },
      ],
    },
    { graph: true, trusted: true },
  );

  test("rejects invalid graphs without replacing the previous plan", () => {
    const merged = mergePlan(
      base,
      {
        steps: [
          { id: "s1", content: "导出", status: "in_progress" },
          { id: "s2", content: "导入", status: "pending", depends_on: ["missing"] },
        ],
      },
      { taskGraph: true },
    );
    expect(merged.accepted).toBe(false);
    expect(merged.plan.steps.map((step) => step.id)).toEqual(["s1", "s2"]);
    expect(merged.warnings.join("\n")).toContain("unknown_dependency");

    const outcome = planToolOutcome(
      base,
      {
        steps: [
          { id: "s1", content: "导出", status: "in_progress" },
          { id: "s2", content: "导入", status: "pending", depends_on: ["missing"] },
        ],
      },
      { taskGraph: true },
    );
    expect(JSON.parse(outcome.output[0].text).status).toBe("plan_rejected");
    expect((outcome.output[0].metadata?.planV2 as { steps: unknown[] }).steps).toHaveLength(2);
  });

  test("increments attempts only on a new transition to failed", () => {
    const first = mergePlan(
      base,
      {
        steps: [
          { id: "s1", content: "导出", status: "failed", last_error: "timeout" },
          { id: "s2", content: "导入", status: "pending", depends_on: ["s1"] },
        ],
      },
      { taskGraph: true },
    );
    expect(first.accepted).toBe(true);
    expect(first.plan.steps[0]).toMatchObject({ status: "failed", attempts: 1, lastError: "timeout" });

    const second = mergePlan(
      first.plan,
      {
        steps: [
          { id: "s1", content: "导出", status: "failed", last_error: "timeout" },
          { id: "s2", content: "导入", status: "pending", depends_on: ["s1"] },
        ],
      },
      { taskGraph: true },
    );
    expect(second.plan.steps[0].attempts).toBe(1);
  });

  test("keeps retry counters and budgets code-owned", () => {
    const atLimit: Plan = normalizePlan(
      {
        goal: "迁移",
        steps: [
          {
            id: "s1",
            content: "导出",
            status: "failed",
            attempts: 2,
            max_attempts: 2,
            last_error: "timeout",
          },
        ],
      },
      { graph: true, trusted: true },
    );
    const changed = mergePlan(
      atLimit,
      { steps: [{ id: "s1", content: "导出", status: "failed", max_attempts: 5, attempts: 0 }] },
      { taskGraph: true },
    );
    expect(changed.accepted).toBe(true);
    expect(changed.plan.steps[0]).toMatchObject({ attempts: 2, maxAttempts: 2 });
    expect(changed.warnings.join("\n")).toContain("max_attempts");

    const restart = mergePlan(
      atLimit,
      { steps: [{ id: "s1", content: "导出", status: "in_progress" }] },
      { taskGraph: true },
    );
    expect(restart.accepted).toBe(false);
    expect(restart.plan.steps[0].status).toBe("failed");
    expect(restart.warnings.join("\n")).toContain("exhausted");
  });

  test("rejects starting a blocked or second active step", () => {
    const bothActive = mergePlan(
      base,
      {
        steps: [
          { id: "s1", content: "导出", status: "in_progress" },
          { id: "s2", content: "导入", status: "in_progress", depends_on: ["s1"] },
        ],
      },
      { taskGraph: true },
    );
    expect(bothActive.accepted).toBe(false);
    expect(bothActive.warnings.join("\n")).toContain("only one step");

    const blocked = mergePlan(
      base,
      {
        steps: [
          { id: "s1", content: "导出", status: "pending" },
          { id: "s2", content: "导入", status: "in_progress", depends_on: ["s1"] },
        ],
      },
      { taskGraph: true },
    );
    expect(blocked.accepted).toBe(false);
    expect(blocked.warnings.join("\n")).toContain("unmet dependencies");
  });

  test("依赖证据口径跟随 requireVerifiedCompletion", () => {
    const previous = normalizePlan(
      {
        goal: "迁移",
        steps: [
          { id: "s1", content: "导出", status: "completed" },
          { id: "s2", content: "导入", status: "pending", depends_on: ["s1"] },
        ],
      },
      { graph: true, trusted: true },
    );
    const input = {
      steps: [
        { id: "s1", content: "导出", status: "completed" },
        { id: "s2", content: "导入", status: "in_progress", depends_on: ["s1"] },
      ],
    };
    expect(mergePlan(previous, input, { taskGraph: true }).accepted).toBe(false);
    expect(mergePlan(previous, input, { taskGraph: true, requireVerified: false }).accepted).toBe(true);
  });

  test("首次非法图返回 plan_rejected 且不写权威快照", () => {
    const outcome = planToolOutcome(
      null,
      {
        goal: "迁移",
        steps: [{ id: "s1", content: "导出", status: "pending", depends_on: ["s1"] }],
      },
      { taskGraph: true },
    );
    const receipt = JSON.parse(outcome.output[0].text);
    expect(receipt.status).toBe("plan_rejected");
    expect(outcome.output[0].metadata).toBeUndefined();
  });

  test("v3 快照往返保留依赖与预算", () => {
    const snapshot = toPlanSnapshot(base);
    expect(snapshot.steps[1]).toMatchObject({ depends_on: ["s1"], max_attempts: 3 });
    const roundTrip = normalizePlan(snapshot, { graph: true, trusted: true });
    expect(roundTrip.steps[1]).toMatchObject({ dependsOn: ["s1"], maxAttempts: 3 });
    expect(isPlanV3(roundTrip)).toBe(true);
  });
});

describe("planFromToolPart — 单个工具卡还原权威计划(O3)", () => {  test("优先 metadata.planV2;缺失时回退解析 input JSON", () => {
    const snapshot = {
      title: "T",
      goal: "锁定目标",
      done_when: [],
      boundaries: [],
      steps: [
        {
          id: "s1",
          content: "步骤",
          status: "completed",
          verify: "",
          evidence: ["tc"],
          attempts: 3,
          last_error: null,
        },
      ],
    };
    const withSnapshot = planFromToolPart({
      input: JSON.stringify({ goal: "模型输入", steps: [{ content: "步骤", status: "pending" }] }),
      output: [{ type: "text", text: "{}", metadata: { planV2: snapshot } }],
    });
    expect(withSnapshot?.goal).toBe("锁定目标");
    expect(withSnapshot?.steps[0]?.attempts).toBe(3);

    const inputOnly = planFromToolPart({
      input: JSON.stringify({ goal: "只有输入", steps: [{ content: "旧步骤", status: "pending" }] }),
      output: [],
    });
    expect(inputOnly?.goal).toBe("只有输入");
    expect(isPlanV2(inputOnly!)).toBe(true);
  });

  test("空计划/坏 JSON/非对象返回 null", () => {
    expect(planFromToolPart({ input: "{bad", output: [] })).toBeNull();
    expect(planFromToolPart({ input: JSON.stringify({ steps: [] }), output: [] })).toBeNull();
    expect(planFromToolPart(null)).toBeNull();
  });
});
