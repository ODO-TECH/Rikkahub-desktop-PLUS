export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ToolCall { id: string; name: string; arguments: string }
export interface Message {
  native?: Json;
  wire?: Json;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  reasoning?: string;
}
export interface Usage { inputTokens: number; outputTokens: number }
export interface ModelRequest {
  runId?: string;
  model: string;
  messages: readonly Message[];
  tools: readonly ToolDeclaration[];
  maxOutputTokens: number;
}
export type ModelEvent =
  | { type: "text" | "reasoning"; delta: string }
  | { type: "response"; message: Message; finish: "stop" | "tools" | "length"; usage?: Usage };
export interface ModelProvider {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
export interface ToolDeclaration { name: string; description: string; parameters: Schema }
/** Deliberately supported JSON Schema subset; unsupported keywords fail at registration. */
export interface Schema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: Json[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}
export interface ToolOutput { content: string; isError?: boolean; waitFor?: string }
export interface ToolContext {
  callId: string;
  runId: string;
  signal: AbortSignal;
  emit(text: string): void;
}
export interface Tool extends ToolDeclaration {
  /** Only explicitly declared read-only calls can overlap. Everything else is exclusive. */
  readOnly?: boolean;
  /** Host coordinator only: delegates work, never performs side effects itself. */
  orchestrator?: boolean;
  needsApproval?: boolean | ((args: Json) => boolean);
  execute(args: Json, context: ToolContext): Promise<ToolOutput>;
}
export interface Limits {
  maxSteps: number;
  maxRequests: number;
  maxTokens: number;
  maxOutputTokens: number;
  contextTokens: number;
  keepRecentTokens: number;
  maxDepth: number;
  maxToolOutputChars: number;
  maxRepeatedErrors: number;
}
export interface StartInput {
  model: string;
  input: string;
  system?: string;
  history?: Message[];
  tools?: string[];
  limits?: Partial<Limits>;
}
export interface ChildInput {
  input: string;
  model?: string;
  tools?: string[];
  system?: string;
}
export type RunStatus = "queued" | "running" | "awaiting_approval" | "waiting" |
  "completed" | "cancelled" | "failed" | "limited" | "interrupted";
export interface ToolState {
  call: ToolCall;
  status: "pending" | "running" | "waiting" | "done" | "uncertain";
  approval: "auto" | "pending" | "approved" | "denied";
  output?: ToolOutput;
  childRunId?: string;
}
export interface PendingInput { text: string; mode: "steer" | "followup" }
export interface Run {
  id: string;
  rootId: string;
  parentId?: string;
  depth: number;
  model: string;
  tools: string[];
  limits: Limits;
  status: RunStatus;
  messages: Message[];
  /** Partial model output retained on failure/cancellation, never replayed as a completed assistant turn. */
  draft?: Message;
  pendingTools: ToolState[];
  inbox: PendingInput[];
  steps: number;
  usage: Usage;
  lastFailure?: string;
  repeatedErrors?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
export interface Budget { maxRequests: number; maxTokens: number; requests: number; tokens: number }
export type KernelEvent =
  | { type: "model_state"; runId: string; phase: "queued" | "request" | "first_delta"; at: number; queuedMs?: number }
  | { type: "run"; runId: string; status: RunStatus }
  | { type: "delta"; runId: string; kind: "text" | "reasoning"; text: string }
  | { type: "tool"; runId: string; callId: string; status: ToolState["status"] }
  | { type: "tool_output"; runId: string; callId: string; text: string }
  | { type: "child"; runId: string; childId: string }
  | { type: "compacted"; runId: string; before: number; after: number };

export interface TaskSpec { id: string; prompt: string; dependsOn?: string[]; tools?: string[] }
export interface Task extends TaskSpec {
  status: "pending" | "running" | "waiting" | "completed" | "failed";
  runId?: string;
  result?: string;
  evidence?: string;
}
export interface Ticket {
  budgetId?: string;
  id: string;
  source: string;
  triggerId: string;
  prompt: string;
  model: string;
  system?: string;
  tools?: string[];
  status: "open" | "running" | "waiting" | "ready" | "completed" | "failed" | "cancelled";
  tasks: Task[];
  replans: number;
  limits: Limits;
  createdAt: number;
  updatedAt: number;
}
export interface Delivery { id: string; ticketId: string; content: string; status: "pending" | "sent" }

export const DEFAULT_LIMITS: Limits = {
  maxSteps: 64, maxRequests: 256, maxTokens: 500_000, maxOutputTokens: 4096,
  contextTokens: 64_000, keepRecentTokens: 12_000, maxDepth: 1, maxToolOutputChars: 16_000,
  maxRepeatedErrors: 3,
};

export function limitsOf(input: Partial<Limits> = {}): Limits {
  const value = { ...DEFAULT_LIMITS, ...input };
  for (const [key, number] of Object.entries(value)) {
    if (!Number.isSafeInteger(number) || number < (key === "maxDepth" ? 0 : 1)) {
      throw new Error(`Invalid limit: ${key}`);
    }
  }
  if (value.maxOutputTokens >= value.contextTokens) throw new Error("Output limit must be smaller than context");
  return value;
}
export const isTerminal = (status: RunStatus): boolean =>
  ["completed", "cancelled", "failed", "limited"].includes(status);
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const answerOf = (run: Run): string =>
  [...run.messages].reverse().find(message => message.role === "assistant" && !message.toolCalls?.length)?.content ?? "";
