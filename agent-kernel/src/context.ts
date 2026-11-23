import type { Message, ToolDeclaration } from "./types.ts";

export const COMPACTION_PROMPT = "Summarize this agent history for continuation. Preserve the task, decisions, constraints, tool evidence, artifact IDs, and unfinished work. Return only the summary; do not execute work.";

/** Fallback estimate, not a tokenizer. A provider with strict budgets should supply countTokens. */
export function estimateTokens(messages: readonly Message[], tools: readonly ToolDeclaration[] = []): number {
  return Math.ceil(new TextEncoder().encode(JSON.stringify({ messages, tools })).byteLength / 3) + 16;
}

/** Keep assistant tool calls and their following results in the same indivisible group. */
export function contextSplit(messages: readonly Message[], keepTokens: number): { prefix: Message[]; older: Message[]; recent: Message[] } {
  const prefix: Message[] = [];
  let first = 0;
  while (messages[first]?.role === "system") prefix.push(messages[first++]);
  const groups: Message[][] = [];
  for (const message of messages.slice(first)) {
    if (message.role === "tool") {
      const group = groups.at(-1);
      if (!group?.[0].toolCalls?.some(call => call.id === message.toolCallId)) throw new Error("Orphan tool result in history");
      group.push(message);
    } else groups.push([message]);
  }
  let cut = groups.length;
  let tokens = 0;
  do {
    if (cut === 0) break;
    tokens += estimateTokens(groups[--cut]);
  } while (tokens < keepTokens);
  return { prefix, older: groups.slice(0, cut).flat(), recent: groups.slice(cut).flat() };
}

export function validateHistory(messages: readonly Message[]): void {
  let pending = new Set<string>();
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.toolCallId || !pending.delete(message.toolCallId)) throw new Error("Unexpected tool result in history");
    } else {
      if (pending.size) throw new Error("Incomplete tool batch in history");
      pending = new Set();
      for (const call of message.toolCalls ?? []) {
        if (message.role !== "assistant" || !call.id || ids.has(call.id)) throw new Error("Invalid tool call in history");
        ids.add(call.id);
        pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new Error("History ends with unresolved tool calls");
}
