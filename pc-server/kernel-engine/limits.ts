import type { Limits } from "../../agent-kernel/src/types";

export function desktopKernelLimits(agent: boolean, contextTokens: number, outputTokens: number, hasChatTools = false): Partial<Limits> {
  const maxRequests = agent ? 96 : hasChatTools ? 24 : 4;
  return {
    maxSteps: agent ? 48 : hasChatTools ? 12 : 1,
    maxRequests,
    // Input is billed again on every step. A fixed task cap smaller than the
    // model's window stops ordinary repository analysis after only a few reads.
    // Bound work by steps/requests; permit each request to use its context window.
    // Descendants still share this finite root budget.
    maxTokens: contextTokens * maxRequests,
    contextTokens,
    maxOutputTokens: Math.min(outputTokens, Math.floor(contextTokens / 3)),
    keepRecentTokens: Math.min(12000, Math.floor(contextTokens / 2)),
  };
}
