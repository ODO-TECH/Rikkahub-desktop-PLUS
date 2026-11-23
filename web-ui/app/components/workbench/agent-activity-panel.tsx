import * as React from "react";
import { useConversationStore } from "~/stores/conversation-store";
import { AgentRunPanel } from "~/components/workspace/agent-run-panel";
import { AgentRunSelectionProvider } from "~/components/workspace/agent-run-selection";
import { ToolPart } from "~/components/message/parts/tool-part";
import type { ToolPart as UIToolPart } from "~/types";
import api from "~/services/api";

interface RunView {
  id: string;
  rootId: string;
  parentId: string | null;
  depth: number;
  status: string;
  model: string;
  steps: number;
  input: string;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number };
  modelState?: { phase: string; queuedMs?: number };
  messages: {
    role: string;
    content: string;
    reasoning?: string;
    toolCallId?: string;
    toolCalls?: { id: string; name: string; arguments: string }[];
  }[];
  draft: { content: string; reasoning?: string } | null;
  pendingTools: { call: { id: string; name: string; arguments: string }; status: string }[];
}
const statusName: Record<string, string> = {
  running: "执行中",
  completed: "已完成",
  cancelled: "已停止",
  interrupted: "已中断",
  failed: "失败",
  limited: "达到限制",
  queued: "排队中",
  waiting: "等待中",
  awaiting_approval: "等待审批",
};
const modelPhase: Record<string, string> = {
  queued: "等待模型容量",
  request: "等待模型返回",
  first_delta: "正在输出",
};
const toolStatus: Record<string, string> = {
  pending: "待执行",
  running: "执行中",
  done: "已完成",
  waiting: "等待中",
  uncertain: "需确认执行结果",
};

export function AgentActivityPanel({ conversationId }: { conversationId?: string | null }) {
  const [tab, setTab] = React.useState<"tools" | "children">("tools");
  const [runs, setRuns] = React.useState<RunView[]>([]);
  const [error, setError] = React.useState("");
  const detail = useConversationStore((s) =>
    conversationId ? s.entries[conversationId]?.detail : null,
  );
  React.useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    setRuns([]);
    setError("");
    const poll = async () => {
      if (!conversationId) return;
      try {
        const response = await api.get<{ runs: RunView[] }>(
          `conversations/${conversationId}/kernel-runs`,
        );
        if (!stopped) {
          setRuns(response.runs);
          setError("");
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!stopped) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [conversationId]);
  const children = runs.filter((r) => r.id !== r.rootId);
  const messages =
    detail?.messages.flatMap((n) =>
      n.messages[n.selectIndex] ? [n.messages[n.selectIndex]] : [],
    ) ?? [];
  const allTools = messages.flatMap((m) =>
    m.parts.filter((p) => p.type === "tool").map((p) => ({ tool: p as UIToolPart, message: m })),
  );
  const tools = allTools.filter(({ tool }) => !(tool.metadata as any)?.kernelChildRunId);
  const approve: React.ComponentProps<typeof ToolPart>["onToolApproval"] = async (
    id,
    approved,
    reason,
    answer,
  ) => {
    await api.post(`conversations/${conversationId}/tool-approval`, {
      toolCallId: id,
      approved,
      reason,
      answer,
    });
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-agent-activity>
      <div className="flex gap-1 border-b px-3 pt-2 pb-2" role="tablist" aria-label="运行详情">
        <button
          role="tab"
          aria-selected={tab === "tools"}
          onClick={() => setTab("tools")}
          className={`flex-1 rounded-md px-2 py-2 text-sm ${tab === "tools" ? "bg-background font-medium" : "text-muted-foreground"}`}
        >
          工具调用 {tools.length || ""}
        </button>
        <button
          role="tab"
          aria-selected={tab === "children"}
          onClick={() => setTab("children")}
          className={`flex-1 rounded-md px-2 py-2 text-sm ${tab === "children" ? "bg-background font-medium" : "text-muted-foreground"}`}
        >
          子任务 {children.length || ""}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3" role="tabpanel">
        {!conversationId ? (
          <p className="text-sm text-muted-foreground">打开会话后查看运行详情</p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {tab === "tools" ? (
          <>
            <AgentRunSelectionProvider conversationId={conversationId ?? null}>
              <AgentRunPanel conversationId={conversationId ?? null} />
            </AgentRunSelectionProvider>
            <div className="mt-3 space-y-3">
              {tools.map(({ tool, message }) => (
                <div key={tool.toolCallId} className="rounded-lg border bg-background/50 p-2">
                  <ToolPart
                    tool={tool}
                    messageCreatedAt={message.createdAt}
                    messageFinishedAt={message.finishedAt}
                    onToolApproval={approve}
                  />
                </div>
              ))}
            </div>
            {!tools.length ? (
              <p className="py-4 text-sm text-muted-foreground">暂无工具调用</p>
            ) : null}
          </>
        ) : (
          <div className="space-y-3">
            {!children.length ? (
              <p className="py-4 text-sm text-muted-foreground">暂无子任务；派发后会显示实时进度</p>
            ) : null}
            {children.map((run, index) => (
              <details key={run.id} open className="rounded-lg border bg-background/50 p-3">
                <summary title={run.id} className="cursor-pointer text-sm font-medium">
                  子任务 {index + 1} · {statusName[run.status] ?? run.status} · {run.steps} 轮
                </summary>
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">任务指令</summary>
                  <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                    {run.input}
                  </p>
                </details>
                <p className="my-2 text-xs text-muted-foreground">
                  {run.model} · {run.usage.inputTokens + run.usage.outputTokens} tokens{" "}
                  {run.status === "running" && run.modelState
                    ? `· ${modelPhase[run.modelState.phase] ?? "执行中"}`
                    : ""}
                </p>
                {allTools
                  .filter(
                    ({ tool }) =>
                      (tool.metadata as any)?.kernelChildRunId === run.id &&
                      tool.approvalState?.type === "pending",
                  )
                  .map(({ tool, message }) => (
                    <ToolPart
                      key={tool.toolCallId}
                      tool={tool}
                      messageCreatedAt={message.createdAt}
                      messageFinishedAt={message.finishedAt}
                      onToolApproval={approve}
                    />
                  ))}
                {run.messages
                  .filter((m) => m.role !== "user")
                  .map((m, i) => (
                    <div key={i} className="mt-2 rounded border p-2 text-xs">
                      <div className="mb-1 text-muted-foreground">
                        {m.role === "tool" ? "工具结果" : m.toolCalls?.length ? "工具调用" : "输出"}
                      </div>
                      {m.reasoning ? (
                        <details>
                          <summary>思考过程</summary>
                          <pre className="whitespace-pre-wrap break-words">{m.reasoning}</pre>
                        </details>
                      ) : null}
                      {m.toolCalls?.map((call) => (
                        <div key={call.id}>
                          <strong>{call.name}</strong>
                          <pre className="whitespace-pre-wrap break-words">{call.arguments}</pre>
                        </div>
                      ))}
                      {m.content ? (
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words">
                          {m.content}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                {run.draft ? (
                  <div className="mt-2 rounded border p-2 text-xs">
                    <span className="text-muted-foreground">实时输出</span>
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">
                      {run.draft.reasoning}
                      {"\n"}
                      {run.draft.content}
                    </pre>
                  </div>
                ) : null}
                {run.pendingTools.map((t) => (
                  <p key={t.call.id} className="mt-2 text-xs">
                    {t.call.name} · {toolStatus[t.status] ?? t.status}
                  </p>
                ))}
                {run.error ? <p className="mt-2 text-xs text-destructive">{run.error}</p> : null}
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
