// tools/approval.ts — 工具审批状态判断
// 纪律：纯函数，只读取 assistant / settings / 工作区档位，不读写 state 运行时副作用。
// workspace 工具（read/write/edit/bash）按会话绑定工作区的 permissionPreset 走审批
// 矩阵（workspace/approval.ts）。判定两段式：参数未到（args 缺省）用无参数下界，
// 参数齐备用终局判定（危险命令/区外写入才在 balanced 档触发审批）——单调只升不降，
// 循环层负责把上调同步回已建的卡（见 workspace/approval.ts 头注）。

import { getStringArray, isRecord } from "../foundation/utils";
import type { Assistant, Conversation, JsonValue, ToolApprovalReasonCode, ToolApprovalState } from "../foundation/types";
import type { ToolBoundaryObserver } from "../foundation/tool-boundary";
import { observeToolBoundarySafely } from "../foundation/tool-boundary";
import { skillsDir } from "../foundation/paths";
import { state } from "../persistence/json-store";
import {
  findDangerousCommandRule,
  isWorkspaceToolName,
  lexicalWorkspaceCwd,
  workspaceCallApprovalReason,
  workspaceCallTargetScope,
  workspaceToolAccess,
  workspaceToolNeedsApproval,
  type WorkspaceToolName,
} from "../workspace/approval";
import { buildWorkspaceBoundarySnapshot } from "../workspace/boundary-snapshot";
import { getWorkspace } from "../workspace";
import { sandboxBoundaryActive } from "../workspace/sandbox";

type ConversationWorkspacePick = Pick<Conversation, "workspaceId" | "workspaceCwd">;

function parseArgsRecord(args: string): Record<string, JsonValue> {
  try {
    const parsed = JSON.parse(args) as JsonValue;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

interface WorkspaceApprovalDecision {
  pending: boolean;
  /** 审批卡展示的完整缘由(可含目标路径)——现有字段,行为不变。 */
  reason?: string;
  /** O4:run 流水白名单字段,短缘由去路径化。 */
  reasonCode?: ToolApprovalReasonCode;
  reasonSummary?: string;
  ruleId?: string;
}

/** 工作区工具审批判定。args 缺省 = 参数未到（流式建卡），给无参数下界。 */
function workspaceApprovalDecision(
  toolName: WorkspaceToolName,
  conversation: ConversationWorkspacePick | null | undefined,
  args?: string,
): WorkspaceApprovalDecision {
  // 工作区工具只在 workspaceId 非空的会话挂载；非工作区会话的残留调用在执行层被拒
  // （workspace/runtime.ts 守卫），这里不挂审批。
  const workspaceId = conversation?.workspaceId;
  if (!workspaceId) return { pending: false };
  const workspace = getWorkspace(workspaceId);
  // 工作区记录丢失 → 按最严档处理（执行层同样会拒，pending 卡只是多一道门）。
  const preset = workspace?.permissionPreset ?? "confirm_each";
  if (args === undefined || !workspace) {
    const pending = workspaceToolNeedsApproval(toolName, preset);
    return pending
      ? { pending: true, reasonCode: "preset_confirm_each" }
      : { pending: false };
  }
  const reason = workspaceCallApprovalReason(toolName, preset, parseArgsRecord(args), {
    root: workspace.root,
    cwd: lexicalWorkspaceCwd(workspace.root, conversation?.workspaceCwd),
    // §6.7:技能库 pc-data/skills/ 免审批可写(AI 装/改技能不弹窗)。
    approvalExemptWritePrefixes: [skillsDir],
    // 实测边界生效时,区外写入批准了也会被操作系统拒绝——卡片直接说明,不装样子。
    sandboxBoundaryActive: sandboxBoundaryActive(),
  });
  if (reason === null) return { pending: false };
  // confirm_each:档位本身要求逐项确认,没有额外缘由。
  if (preset === "confirm_each") {
    return { pending: true, reasonCode: "preset_confirm_each", ...(reason ? { reason } : {}) };
  }
  const parsed = parseArgsRecord(args);
  if (toolName === "bash") {
    const rule = findDangerousCommandRule(String(parsed.command ?? ""));
    if (rule) {
      return {
        pending: true,
        reasonCode: "destructive_command",
        reasonSummary: rule.reason,
        ruleId: rule.id,
        ...(reason ? { reason } : {}),
      };
    }
  }
  // balanced 档走到这里的非 bash 分支只有区外写入(免审批前缀已在终局判定里排除)。
  return {
    pending: true,
    reasonCode: "outside_workspace_write",
    reasonSummary: sandboxBoundaryActive()
      ? "Writes outside the workspace are blocked by the system sandbox boundary."
      : "Writes outside the workspace require approval.",
    ...(reason ? { reason } : {}),
  };
}

/** O4:审批最终判定处的可选观测。toolCallId 缺失(纯编码回放)时不观测。 */
export interface ToolApprovalObservation {
  toolCallId?: string;
  observer?: ToolBoundaryObserver;
}

function observeWorkspaceApproval(
  toolName: WorkspaceToolName,
  conversation: ConversationWorkspacePick | null | undefined,
  args: string | undefined,
  decision: WorkspaceApprovalDecision,
  observation: ToolApprovalObservation | undefined,
): void {
  if (!decision.pending || !observation?.toolCallId || !observation.observer) return;
  const workspaceId = conversation?.workspaceId;
  if (!workspaceId) return;
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return;
  const cwd = lexicalWorkspaceCwd(workspace.root, conversation?.workspaceCwd);
  const snapshot = buildWorkspaceBoundarySnapshot(
    workspace,
    cwd,
    // 审批时点的有效写边界:用户批准后的宽界是执行时语境,由 execution 快照单独记录;
    // full_access 也只是应用权限档——系统沙箱生效时写边界仍是严界。
    workspace.permissionPreset === "full_access" && !sandboxBoundaryActive() ? "wide" : "strict",
  );
  observeToolBoundarySafely(observation.observer, {
    toolCallId: observation.toolCallId,
    toolName,
    stage: "approval",
    access: workspaceToolAccess(toolName),
    targetScope: workspaceCallTargetScope(toolName, parseArgsRecord(args ?? "{}"), {
      root: workspace.root,
      cwd,
    }),
    snapshot,
    ...(decision.reasonCode
      ? {
          approval: {
            reasonCode: decision.reasonCode,
            ...(decision.reasonSummary ? { reasonSummary: decision.reasonSummary } : {}),
            ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
          },
        }
      : {}),
  });
}

function pendingApprovalState(decision: WorkspaceApprovalDecision): ToolApprovalState {
  return {
    type: "pending",
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {}),
    ...(decision.reasonSummary ? { reasonSummary: decision.reasonSummary } : {}),
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
  };
}

export function getMcpToolOverride(
  assistant: Assistant,
  serverId: string,
  toolName: string,
): { enable?: boolean; needsApproval?: boolean } | undefined {
  const overrides = isRecord(assistant.mcpToolOverrides)
    ? (assistant.mcpToolOverrides as Record<string, Record<string, { enable?: boolean; needsApproval?: boolean }>>)
    : undefined;
  if (!overrides) return undefined;
  const perServer = overrides[serverId];
  if (!perServer) return undefined;
  return perServer[toolName];
}

// Per-assistant resolved enable state for a tool. Global tool.enable=false ⇒ false (override
// can never reactivate a globally-disabled tool — matches the user's stated rule "设置中关闭
// 的工具会话里看不见"). Otherwise, the override.enable wins; absence falls back to true.
export function isMcpToolEnabledForAssistant(
  assistant: Assistant,
  serverId: string,
  tool: Record<string, unknown>,
): boolean {
  if (tool.enable === false) return false;
  const override = getMcpToolOverride(assistant, serverId, String(tool.name ?? ""));
  if (override?.enable === false) return false;
  return true;
}

// Per-assistant resolved needsApproval state. Override wins when set (true/false), otherwise
// falls back to the global per-tool needsApproval flag.
export function isMcpToolApprovalRequiredForAssistant(
  assistant: Assistant,
  serverId: string,
  tool: Record<string, unknown>,
): boolean {
  const override = getMcpToolOverride(assistant, serverId, String(tool.name ?? ""));
  if (typeof override?.needsApproval === "boolean") return override.needsApproval;
  return tool.needsApproval === true;
}

// Returns true if this tool requires user approval before executing — mirrors Android's
// GenerationHandler.kt:184-189 logic (`toolDef?.needsApproval == true && state is Auto -> Pending`).
// PC scope: `ask_user` is always pending (it's literally a "ask the user" prompt), and any
// MCP tool whose effective needsApproval (override-resolved) is true gets pending too. Local
// built-ins (search/scrape/memory/etc.) currently never need approval — Android matches.
// S6 核查（2026-11-28）：MCP 已由 hostCapabilities(true) 暴露给 Agent/工作区，
// 下方仍按逐工具 needsApproval 判定，并不按工作区档位覆盖。docs/dev-workflow.md §7
// 与 docs/plan-agent-lite.md S6 的“只看档位”是待实现提案，本次只澄清现状，不改审批行为。
export function toolNeedsApproval(
  toolName: string,
  assistant: Assistant,
  conversation?: ConversationWorkspacePick | null,
  args?: string,
): boolean {
  if (!toolName) return false;
  if (toolName === "ask_user") return true;
  if (isWorkspaceToolName(toolName)) {
    return workspaceApprovalDecision(toolName, conversation, args).pending;
  }
  if (!toolName.startsWith("mcp__")) return false;
  const selected = new Set(getStringArray(assistant.mcpServers));
  const servers = (state.settings.mcpServers as Array<Record<string, unknown>>)
    .filter((server) => selected.has(String(server.id ?? "")) && isRecord(server.commonOptions) && server.commonOptions.enable !== false);
  for (const server of servers) {
    const common = server.commonOptions as Record<string, unknown>;
    const tools = Array.isArray(common.tools) ? common.tools.filter(isRecord) : [];
    const matched = tools.find(
      (tool) =>
        isMcpToolEnabledForAssistant(assistant, String(server.id ?? ""), tool)
        && `mcp__${String(tool.name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")}` === toolName,
    );
    if (matched) return isMcpToolApprovalRequiredForAssistant(assistant, String(server.id ?? ""), matched);
  }
  return false;
}

export function initialApprovalState(
  toolName: string,
  assistant: Assistant,
  conversation?: ConversationWorkspacePick | null,
  args?: string,
  observation?: ToolApprovalObservation,
): ToolApprovalState {
  if (isWorkspaceToolName(toolName)) {
    const decision = workspaceApprovalDecision(toolName, conversation, args);
    if (!decision.pending) return { type: "auto" };
    observeWorkspaceApproval(toolName, conversation, args, decision, observation);
    return pendingApprovalState(decision);
  }
  if (toolNeedsApproval(toolName, assistant, conversation)) {
    return toolName.startsWith("mcp__")
      ? { type: "pending", reasonCode: "mcp_tool_requires_approval" }
      : { type: "pending" };
  }
  return { type: "auto" };
}
