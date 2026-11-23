// tools/plan-context.test.ts — 计划改写保护的前值读取(自主循环 S2)
//
// 钉住"上一版计划"的三个边界:同一 run 才参与合并、当前调用不算前值、
// 权威快照优先于模型可篡改的原始 input。
import { describe, expect, test } from "bun:test";

import type { Conversation, Message, MessageNode } from "../foundation/types";
import { findPlanContext, latestPlan, runResumeTarget } from "./plan-context";
import { PLAN_TOOL_NAME, toPlanSnapshot, type Plan } from "./plan";

function message(role: Message["role"], parts: Message["parts"]): Message {
  return {
    id: `m-${role}-${Math.random().toString(36).slice(2, 6)}`,
    role,
    parts,
    annotations: [],
    createdAt: "2026-11-01T00:00:00",
    finishedAt: null,
    modelId: null,
    usage: null,
    translation: null,
  };
}

function node(messages: Message[], selectIndex = 0): MessageNode {
  return { id: `n-${Math.random().toString(36).slice(2, 6)}`, messages, selectIndex };
}

function conversation(messages: MessageNode[]): Conversation {
  return {
    id: "c1",
    assistantId: "a1",
    systemPrompt: null,
    title: "t",
    messages,
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 1,
  };
}

function planPart(toolCallId: string, input: unknown, snapshot?: unknown): Message["parts"][number] {
  return {
    type: "tool",
    toolCallId,
    toolName: PLAN_TOOL_NAME,
    input: typeof input === "string" ? input : JSON.stringify(input),
    output: snapshot
      ? [{ type: "text", text: "{}", metadata: { planV2: snapshot as never } }]
      : [],
    approvalState: { type: "auto" },
  };
}

const planInput = {
  goal: "真目标",
  done_when: ["D"],
  steps: [{ id: "s1", content: "a", status: "pending" }],
};

test("plan context lists only completed successful calls from the selected branch", () => {
  const tool=(toolCallId:string,output:unknown[]):Message["parts"][number]=>({type:"tool",toolCallId,toolName:"get_time_info",input:"{}",output,approvalState:{type:"auto"}} as Message["parts"][number]);
  const context=findPlanContext(conversation([
    node([message("USER",[])]),
    node([message("ASSISTANT",[
      tool("tc-success",[{type:"text",text:"time"}]),tool("tc-error",[{error:"failed"}]),tool("tc-pending",[]),
    ]),message("ASSISTANT",[tool("tc-other-branch",[{type:"text",text:"other"}])])]),
  ]));
  expect(context.availableEvidence).toEqual([{toolCallId:"tc-success",toolName:"get_time_info"}]);
});

describe("findPlanContext", () => {
  test("没有计划:首次发布,允许设定目标", () => {
    expect(findPlanContext(conversation([node([message("USER", [])])]))).toEqual({
      previous: null,
      allowGoalChange: true,
      availableEvidence: [],
    });
  });

  test("本轮已有计划:作为合并基线,不允许改写目标", () => {
    const ctx = findPlanContext(
      conversation([
        node([message("USER", [])]),
        node([message("ASSISTANT", [planPart("tc1", planInput)])]),
      ]),
    );
    expect(ctx.allowGoalChange).toBe(false);
    expect(ctx.previous?.goal).toBe("真目标");
  });

  test("计划属于上一轮用户消息之前:新 run,不作为基线", () => {
    const ctx = findPlanContext(
      conversation([
        node([message("USER", [])]),
        node([message("ASSISTANT", [planPart("tc1", planInput)])]),
        node([message("USER", [])]),
        node([message("ASSISTANT", [])]),
      ]),
    );
    expect(ctx).toEqual({ previous: null, allowGoalChange: true, availableEvidence: [] });
  });

  test("当前工具调用不算自己的前值;同消息里的更早计划仍可作为基线", () => {
    const onlyCurrent = findPlanContext(
      conversation([node([message("USER", [])]), node([message("ASSISTANT", [planPart("tc-now", planInput)])])]),
      "tc-now",
    );
    expect(onlyCurrent.previous).toBeNull();

    const withEarlier = findPlanContext(
      conversation([
        node([message("USER", [])]),
        node([message("ASSISTANT", [planPart("tc-old", planInput), planPart("tc-now", { steps: [] })])]),
      ]),
      "tc-now",
    );
    expect(withEarlier.previous?.goal).toBe("真目标");
  });

  test("权威快照优先:原始 input 被篡改也不污染合并基线", () => {
    const trusted: Plan = {
      title: "",
      goal: "真目标",
      doneWhen: ["D"],
      boundaries: [],
      steps: [
        { id: "s1", content: "a", status: "pending", verify: "", evidence: [], attempts: 2, lastError: null },
      ],
    };
    const ctx = findPlanContext(
      conversation([
        node([message("USER", [])]),
        node([
          message("ASSISTANT", [
            planPart("tc1", { ...planInput, goal: "篡改目标" }, toPlanSnapshot(trusted)),
          ]),
        ]),
      ]),
    );
    expect(ctx.previous?.goal).toBe("真目标");
    expect(ctx.previous?.steps[0].attempts).toBe(2);
  });

  test("畸形 input 跳过,不抛错", () => {
    const ctx = findPlanContext(
      conversation([node([message("USER", [])]), node([message("ASSISTANT", [planPart("tc1", "{oops")])])]),
    );
    expect(ctx.previous).toBeNull();
    expect(ctx.allowGoalChange).toBe(true);
  });
});

describe("latestPlan(完成校验的当前 run 计划)", () => {
  const runPlan = () =>
    conversation([
      node([message("USER", [])]),
      node([message("ASSISTANT", [planPart("tc1", planInput)])]),
    ]);

  test("本轮已发布计划:返回该计划;无计划返回 null", () => {
    expect(latestPlan(runPlan())?.goal).toBe("真目标");
    expect(latestPlan(conversation([node([message("USER", [])])]))).toBeNull();
    expect(latestPlan(null)).toBeNull();
  });

  test("用户重新发言开启新 run:旧计划不再参与完成校验(等模型重新发布)", () => {
    const conv = runPlan();
    conv.messages.push(node([message("USER", [])]));
    expect(latestPlan(conv)).toBeNull();
    conv.messages.push(node([message("ASSISTANT", [planPart("tc2", { ...planInput, goal: "新目标" })])]));
    expect(latestPlan(conv)?.goal).toBe("新目标");
  });

  test("steer 补发不算新 run:带 steered 注解的用户消息之后,计划继续有效", () => {
    const steeredUser = message("USER", []);
    steeredUser.annotations.push({ type: "steered" });
    const conv = conversation([
      node([message("USER", [])]),
      node([message("ASSISTANT", [planPart("tc1", planInput)])]),
      node([steeredUser]),
      node([message("ASSISTANT", [])]),
    ]);
    expect(latestPlan(conv)?.goal).toBe("真目标");
  });

  test("run_resume 恢复消息不算新 run:旧计划仍可读、仍是合并基线且目标锁定", () => {
    const resumeUser = message("USER", []);
    resumeUser.annotations.push({ type: "run_resume", runId: "run-old" });
    const conv = conversation([
      node([message("USER", [])]),
      node([message("ASSISTANT", [planPart("tc1", planInput)])]),
      node([resumeUser]),
      node([message("ASSISTANT", [])]),
    ]);
    // latestPlan:完成校验仍认旧计划
    expect(latestPlan(conv)?.goal).toBe("真目标");
    // findPlanContext:旧计划仍是合并基线,目标三件套不允许改写(恢复不是新任务)
    const context = findPlanContext(conv);
    expect(context.previous?.goal).toBe("真目标");
    expect(context.allowGoalChange).toBe(false);
  });

  test("run_resume 之后的普通用户消息仍切边界:新任务不继承旧计划", () => {
    const resumeUser = message("USER", []);
    resumeUser.annotations.push({ type: "run_resume", runId: "run-old" });
    const conv = conversation([
      node([message("USER", [])]),
      node([message("ASSISTANT", [planPart("tc1", planInput)])]),
      node([resumeUser]),
      node([message("ASSISTANT", [])]),
      node([message("USER", [])]),
    ]);
    expect(latestPlan(conv)).toBeNull();
    expect(findPlanContext(conv)).toEqual({ previous: null, allowGoalChange: true, availableEvidence: [] });
  });
});

describe("runResumeTarget(触发生成的恢复消息识别)", () => {
  test("最近 USER 是恢复消息:返回目标 runId;普通/缺注解/缺 runId 返回 null", () => {
    const resumeUser = message("USER", []);
    resumeUser.annotations.push({ type: "run_resume", runId: "run-old" });
    const conv = conversation([
      node([message("USER", [])]),
      node([message("ASSISTANT", [])]),
      node([resumeUser]),
      node([message("ASSISTANT", [])]), // 新生成的助手节点在尾部,不影响识别
    ]);
    expect(runResumeTarget(conv)).toBe("run-old");

    expect(runResumeTarget(conversation([node([message("USER", [])])]))).toBeNull();
    const noRunId = message("USER", []);
    noRunId.annotations.push({ type: "run_resume" });
    expect(runResumeTarget(conversation([node([noRunId])]))).toBeNull();
    // 最近的 USER 是普通消息:即使更早有恢复消息也不认
    expect(
      runResumeTarget(conversation([node([resumeUser]), node([message("USER", [])])])),
    ).toBeNull();
  });
});
