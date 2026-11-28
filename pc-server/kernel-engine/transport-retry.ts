import { ProviderError } from "../../agent-kernel/src/openai";
import type { RuntimeOptions } from "../../agent-kernel/src/runtime";
import { normalizeAgentLoopConfig, type AgentLoopSettings } from "../foundation/types/settings/agent-loop-config";
import { transportRetryDelayMs } from "../inference-engine/transport-retry";

/** Share the transport policy with the active desktop kernel, including child runs. */
export function desktopTransportRetryOptions(settings?: Partial<AgentLoopSettings>):
  Pick<RuntimeOptions, "maxRetries" | "retryDelayMs" | "retryDelayFor"> {
  const config = normalizeAgentLoopConfig(settings);
  const baseDelayMs = config.transportRetryDelaySeconds * 1000;
  return {
    maxRetries: config.transportRetry ? 2 : 0,
    retryDelayMs: baseDelayMs,
    retryDelayFor: (failedAttempt, error) => transportRetryDelayMs(
      failedAttempt, error instanceof ProviderError ? error.retryAfterMs : null, baseDelayMs,
    ),
  };
}
