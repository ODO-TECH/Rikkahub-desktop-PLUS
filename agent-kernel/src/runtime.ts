import { Semaphore, ToolScheduler } from "./concurrency.ts";
import { COMPACTION_PROMPT, contextSplit, estimateTokens, validateHistory } from "./context.ts";
import { ProviderError } from "./openai.ts";
import { checkSchema, validate } from "./schema.ts";
import { KernelStore } from "./store.ts";
import { answerOf, errorText, isTerminal, limitsOf } from "./types.ts";
import type {
  ChildInput, Json, KernelEvent, Message, ModelEvent, ModelProvider, ModelRequest,
  Run, Schema, StartInput, Tool, ToolDeclaration, ToolOutput, ToolState,
} from "./types.ts";

class LimitError extends Error {}
const childSchema: Schema = { type: "object", properties: {
  input: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 },
  tools: { type: "array", items: { type: "string" } },
}, required: ["input"], additionalProperties: false };

export interface RuntimeOptions {
  store: KernelStore;
  provider: ModelProvider;
  tools?: Tool[];
  modelConcurrency?: number;
  toolConcurrency?: number;
  /** Share across runtimes when the host starts a separate runtime per conversation. */
  modelSlots?: Semaphore;
  /** Acquire before a global slot: background workers cannot occupy the foreground reserve. */
  backgroundModelSlots?: Semaphore;
  /** Hosts can disable the built-in paging tool for restricted chatbot sessions. */
  artifactPaging?: boolean;
  /** Optional host model allowlist; omitted models inherit their parent's model. */
  childModels?: string[];
  toolScheduler?: ToolScheduler;
  maxActiveRuns?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  /** Must include tool declarations and protocol overhead. Fallback is an estimate. */
  countTokens?: (messages: readonly Message[], tools: readonly ToolDeclaration[]) => number;
  onEvent?: (event: KernelEvent) => void;
  beforeStep?: (run: Run) => void;
  onFinal?: (run: Run) => string[];
}

/** One small execution engine shared by chats, bots and child agents. No UI or host imports. */
export class AgentRuntime {
  readonly store: KernelStore;
  private readonly tools = new Map<string, Tool>();
  private readonly active = new Map<string, { run: Run; controller: AbortController; promise: Promise<Run> }>();
  private readonly models: Semaphore;
  private readonly scheduler: ToolScheduler;
  private readonly count: NonNullable<RuntimeOptions["countTokens"]>;
  constructor(private readonly options: RuntimeOptions) {
    this.store = options.store;
    this.models = options.modelSlots ?? new Semaphore(options.modelConcurrency ?? 3);
    this.scheduler = options.toolScheduler ?? new ToolScheduler(options.toolConcurrency ?? 4);
    this.count = options.countTokens ?? estimateTokens;
    if (!Number.isSafeInteger(options.maxActiveRuns ?? 64) || (options.maxActiveRuns ?? 64) < 1) throw new Error("Invalid run concurrency");
    if (!Number.isSafeInteger(options.maxRetries ?? 2) || (options.maxRetries ?? 2) < 0 || (options.maxRetries ?? 2) > 5) throw new Error("Invalid retry limit");
    if (!Number.isFinite(options.retryDelayMs ?? 250) || (options.retryDelayMs ?? 250) < 0) throw new Error("Invalid retry delay");
    for (const tool of options.tools ?? []) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || this.tools.has(tool.name) || ["subagent", "artifact_read"].includes(tool.name)) {
        throw new Error(`Invalid or duplicate tool: ${tool.name}`);
      }
      checkSchema(tool.parameters);
      this.tools.set(tool.name, tool);
    }
    this.tools.set("artifact_read", {
      name: "artifact_read", description: "Read a saved tool-output artifact page.", readOnly: true,
      parameters: { type: "object", properties: {
        id: { type: "string" }, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 32000 },
      }, required: ["id"], additionalProperties: false },
      execute: async (args, context) => {
        const input = args as { id: string; offset?: number; length?: number };
        return { content: this.store.readArtifact(input.id, input.offset, input.length, this.inspect(context.runId).rootId) };
      },
    });
    this.tools.set("subagent", {
      name: "subagent", description: "Delegate one task to an isolated child agent; returns its final result.",
      parameters: options.childModels ? {...childSchema,properties:{...childSchema.properties,model:{type:"string",enum:options.childModels}}} : childSchema,
      execute: async () => { throw new Error("Subagent execution is owned by the runtime"); },
    });
  }
  private emit(event: KernelEvent): void {
    // Observation must not break or replay a model/tool request.
    try { this.options.onEvent?.(event); } catch { /* observer is best effort */ }
  }
  private save(run: Run): void { this.store.save(run); }
  private status(run: Run, status: Run["status"]): void {
    run.status = status;
    this.save(run);
    this.emit({ type: "run", runId: run.id, status });
  }
  inspect(id: string): Run { return this.store.run(id); }
  /** Host-owned capabilities refresh at a model boundary, including after installing extensions. */
  refreshTools(run: Run, tools: Tool[], names: string[]): void {
    for (const tool of tools) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || ["subagent", "artifact_read"].includes(tool.name)) throw new Error("Invalid host tool");
      checkSchema(tool.parameters);
      this.tools.set(tool.name, tool);
    }
    if (names.some(name => !this.tools.has(name))) throw new Error("Missing refreshed tool");
    run.tools = [...new Set(names)];
    this.save(run);
  }
  create(input: StartInput): string { return this.createRun(input).id; }
  /** Internal work scheduler entry: all ticket tasks reserve from the same durable root budget. */
  createWork(input: StartInput, budgetId: string): string { return this.createRun(input, undefined, budgetId).id; }
  private createRun(input: StartInput, parent?: Run, budgetId?: string): Run {
    if (!input.model.trim() || !input.input.trim()) throw new Error("Model and input are required");
    if (parent && parent.depth + 1 > parent.limits.maxDepth) throw new Error("Subagent depth limit reached");
    const limits = parent ? { ...parent.limits } : limitsOf(input.limits);
    const names = [...new Set(input.tools ?? [...this.tools.keys()].filter(name => name !== "subagent" && (this.options.artifactPaging !== false || name !== "artifact_read")))];
    for (const name of names) {
      if (!this.tools.has(name) || (parent && !parent.tools.includes(name))) throw new Error(`Tool is not available: ${name}`);
    }
    if (this.options.artifactPaging !== false && !names.includes("artifact_read")) names.push("artifact_read");
    if ((parent?.depth ?? -1) + 1 >= limits.maxDepth) {
      const index = names.indexOf("subagent");
      if (index >= 0) names.splice(index, 1);
    }
    const messages = structuredClone(input.history ?? []);
    validateHistory(messages);
    if (input.system) messages.unshift({ role: "system", content: input.system });
    messages.push({ role: "user", content: input.input });
    const id = crypto.randomUUID();
    const run: Run = {
      id, rootId: parent?.rootId ?? budgetId ?? id, ...(parent ? { parentId: parent.id } : {}),
      depth: parent ? parent.depth + 1 : 0, model: input.model, tools: names, limits,
      status: "queued", messages, pendingTools: [], inbox: [], steps: 0,
      usage: { inputTokens: 0, outputTokens: 0 }, createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.store.atomic(() => {
      if (parent || budgetId) this.store.budget(run.rootId);
      else this.store.createBudget(run.rootId, limits.maxRequests, limits.maxTokens);
      this.save(run);
    });
    return run;
  }
  async start(input: StartInput, signal?: AbortSignal): Promise<Run> { return this.resume(this.create(input), signal); }
  async resume(id: string, signal?: AbortSignal): Promise<Run> {
    const existing = this.active.get(id);
    if (existing) return existing.promise;
    if (this.active.size >= (this.options.maxActiveRuns ?? 64)) throw new Error("Active run limit reached");
    const run = this.store.run(id);
    if (isTerminal(run.status)) return run;
    if (run.pendingTools.some(tool => tool.status === "uncertain" || tool.status === "running")) {
      throw new Error("Interrupted tool requires explicit resolution before resume");
    }
    const controller = new AbortController();
    const abort = () => this.cancel(id);
    if (signal?.aborted) { this.cancel(id); return this.inspect(id); }
    signal?.addEventListener("abort", abort, { once: true });
    // Register before executing so synchronous event observers can send/cancel safely.
    const promise = Promise.resolve().then(() => this.drive(run, controller.signal)).finally(() => {
      signal?.removeEventListener("abort", abort);
      this.active.delete(id);
    });
    this.active.set(id, { run, controller, promise });
    return promise;
  }
  send(id: string, text: string, mode: "steer" | "followup" = "steer"): void {
    if (!text.trim()) throw new Error("Input is empty");
    const run = this.active.get(id)?.run ?? this.store.run(id);
    if (isTerminal(run.status)) throw new Error("Start a new run to continue a terminal run");
    run.inbox.push({ text, mode });
    this.save(run);
  }
  approve(id: string, callId: string, approved: boolean): void {
    if (this.active.has(id)) throw new Error("Wait for the run to pause before approving");
    const run = this.store.run(id);
    const tool = run.pendingTools.find(item => item.call.id === callId);
    if (run.status !== "awaiting_approval" || !tool || tool.approval !== "pending") throw new Error("No pending approval for this call");
    tool.approval = approved ? "approved" : "denied";
    this.save(run);
  }
  cancel(id: string): void {
    const run = this.active.get(id)?.run ?? this.store.run(id);
    for (const child of this.store.runs().filter(item => item.parentId === id && !isTerminal(item.status))) this.cancel(child.id);
    if (isTerminal(run.status)) return;
    this.status(run, "cancelled");
    this.active.get(id)?.controller.abort(new DOMException("Run cancelled", "AbortError"));
  }
  /** Call once at startup, before scheduling work. Never automatically replay an interrupted side effect. */
  recover(): string[] {
    if (this.active.size) throw new Error("Cannot recover while runs are active");
    const recovered: string[] = [];
    for (const run of this.store.runs()) if (run.status === "running") {
      for (const tool of run.pendingTools) if (tool.status === "running") tool.status = "uncertain";
      run.error = "Process stopped during execution";
      this.status(run, "interrupted");
      recovered.push(run.id);
    }
    return recovered;
  }
  resolveInterrupted(id: string, callId: string, output: ToolOutput): void {
    if (this.active.has(id)) throw new Error("Run is active");
    const run = this.store.run(id);
    const tool = run.pendingTools.find(item => item.call.id === callId);
    if (!tool || tool.status !== "uncertain") throw new Error("Tool is not uncertain");
    tool.output = structuredClone(output);
    tool.status = "done";
    this.save(run);
  }
  private declarations(run: Run): ToolDeclaration[] {
    return run.tools.map(name => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`Missing tool implementation: ${name}`);
      return { name: tool.name, description: tool.description, parameters: tool.parameters };
    });
  }
  private drain(run: Run, includeFollowups: boolean): void {
    const taken = run.inbox.filter(input => includeFollowups || input.mode === "steer");
    run.inbox = run.inbox.filter(input => !taken.includes(input));
    run.messages.push(...taken.map(input => ({ role: "user" as const, content: input.text })));
    this.save(run);
  }
  private async drive(run: Run, signal: AbortSignal): Promise<Run> {
    try {
      this.status(run, "running");
      while (true) {
        signal.throwIfAborted();
        if (run.pendingTools.length && !await this.executeBatch(run, signal)) return this.inspect(run.id);
        signal.throwIfAborted();
        this.drain(run, false);
        if (run.steps >= run.limits.maxSteps) throw new LimitError("Model step limit reached");
        this.options.beforeStep?.(run);
        await this.prepareContext(run, signal);
        const response = await this.request(run, {
          runId: run.id, model: run.model, messages: run.messages, tools: this.declarations(run), maxOutputTokens: run.limits.maxOutputTokens,
        }, signal, true);
        signal.throwIfAborted();
        if (response.message.role !== "assistant") throw new Error("Provider must return an assistant message");
        const message = structuredClone(response.message);
        const calls = message.toolCalls ?? [];
        if (response.finish === "tools" && !calls.length) throw new Error("Provider reported tools without any calls");
        const knownIds = new Set(run.messages.flatMap(item => item.toolCalls?.map(call => call.id) ?? []));
        for (const call of calls) {
          if (!call.id || knownIds.has(call.id)) throw new Error("Duplicate or empty tool call id");
          knownIds.add(call.id);
        }
        run.steps++;
        delete run.draft;
        run.messages.push(message);
        run.pendingTools = calls.map(call => ({
          call, status: "pending", approval: "auto",
          ...(response.finish === "length" ? { status: "done" as const,
            output: { content: "Response was truncated; issue this tool call again with complete arguments.", isError: true } } : {}),
        }));
        this.save(run);
        for (const tool of run.pendingTools) this.emit({type:"tool",runId:run.id,callId:tool.call.id,status:tool.status});
        if (calls.length) continue;
        if (response.finish === "length") throw new LimitError("Model output was truncated");
        const continuation = this.options.onFinal?.(run) ?? [];
        for (const content of continuation) run.messages.push({role:"user",content});
        if (continuation.length) { this.save(run); continue; }
        if (run.inbox.length) { this.drain(run, true); continue; }
        this.status(run, "completed");
        return this.inspect(run.id);
      }
    } catch (error) {
      run.error = errorText(error);
      this.status(run, signal.aborted ? "cancelled" : error instanceof LimitError ? "limited" : "failed");
      return this.inspect(run.id);
    }
  }
  private async request(run: Run, request: ModelRequest, signal: AbortSignal, visible: boolean): Promise<Extract<ModelEvent, { type: "response" }>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= (this.options.maxRetries ?? 2); attempt++) {
      signal.throwIfAborted();
      const queuedAt = Date.now();
      this.emit({type:"model_state",runId:run.id,phase:"queued",at:queuedAt});
      const releaseBackground = run.rootId !== run.id && this.options.backgroundModelSlots
        ? await this.options.backgroundModelSlots.acquire(signal) : undefined;
      let releaseModel: () => void;
      try { releaseModel = await this.models.acquire(signal); }
      catch (error) { releaseBackground?.(); throw error; }
      const release = () => { releaseModel(); releaseBackground?.(); };
      this.emit({type:"model_state",runId:run.id,phase:"request",at:Date.now(),queuedMs:Date.now()-queuedAt});
      const inputTokens = this.count(request.messages, request.tools);
      if (!Number.isFinite(inputTokens) || inputTokens < 0) { release(); throw new Error("Invalid token estimate"); }
      const reserved = Math.ceil(inputTokens) + request.maxOutputTokens;
      if (reserved > run.limits.contextTokens) { release(); throw new LimitError("Request exceeds context capacity"); }
      if (!this.store.reserve(run.rootId, reserved)) {
        release();
        const budget = this.store.budget(run.rootId);
        throw new LimitError(budget.requests >= budget.maxRequests
          ? `Shared request budget exhausted (${budget.requests}/${budget.maxRequests})`
          : `Shared token budget exhausted (used ${budget.tokens}, next request reserves ${reserved}, limit ${budget.maxTokens})`);
      }
      let observed = false;
      if (visible) run.draft = { role: "assistant", content: "" };
      try {
        let response: Extract<ModelEvent, { type: "response" }> | undefined;
        for await (const event of this.options.provider.stream(request, signal)) {
          signal.throwIfAborted();
          if (response) throw new Error("Provider emitted data after final response");
          if (event.type === "response") response = event;
          else {
            if (!observed && event.delta) this.emit({type:"model_state",runId:run.id,phase:"first_delta",at:Date.now()});
            if(event.delta) observed = true;
            if (visible) {
              if (event.type === "text") run.draft!.content += event.delta;
              else run.draft!.reasoning = (run.draft!.reasoning ?? "") + event.delta;
              this.emit({ type: "delta", runId: run.id, kind: event.type, text: event.delta });
            }
          }
        }
        if (!response) throw new Error("Provider returned no final response");
        if (response.usage) {
          const { inputTokens: input, outputTokens: output } = response.usage;
          if (![input, output].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid provider usage");
          this.store.reconcile(run.rootId, reserved, input + output);
          run.usage.inputTokens += input;
          run.usage.outputTokens += output;
        }
        this.save(run);
        return response;
      } catch (error) {
        lastError = error;
        if (signal.aborted || observed || !(error instanceof ProviderError) || !error.retryable || attempt === (this.options.maxRetries ?? 2)) throw error;
      } finally { release(); }
      const delay = (this.options.retryDelayMs ?? 250) * 2 ** attempt;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    throw lastError;
  }
  private async prepareContext(run: Run, signal: AbortSignal): Promise<void> {
    const tools = this.declarations(run);
    if (this.count(run.messages, tools) + run.limits.maxOutputTokens <= run.limits.contextTokens) return;
    const { prefix, older, recent } = contextSplit(run.messages, run.limits.keepRecentTokens);
    if (!older.length) throw new LimitError("Recent context alone exceeds capacity; reduce tool results or input");
    const summaryRequest = [...older, { role: "user" as const,
      content: COMPACTION_PROMPT }];
    const result = await this.request(run, {
      model: run.model, messages: [{ role: "system", content: "You summarize agent history faithfully." }, ...summaryRequest],
      tools: [], maxOutputTokens: Math.min(2048, run.limits.maxOutputTokens),
    }, signal, false);
    if (result.finish !== "stop" || result.message.toolCalls?.length || !result.message.content.trim()) throw new Error("Invalid compaction summary");
    const next: Message[] = [...prefix, { role: "user", content: `[Earlier work summary]\n${result.message.content}` }, ...recent];
    if (this.count(next, tools) + run.limits.maxOutputTokens > run.limits.contextTokens) throw new LimitError("Compaction did not free sufficient context");
    const before = this.count(run.messages, tools);
    this.store.artifact(JSON.stringify(run.messages), run.rootId);
    run.messages = next;
    this.save(run);
    this.emit({ type: "compacted", runId: run.id, before, after: this.count(next, tools) });
  }
  private async executeBatch(run: Run, signal: AbortSignal): Promise<boolean> {
    for (const state of run.pendingTools) {
      if (state.status === "done" || state.status === "waiting") continue;
      const tool = this.tools.get(state.call.name);
      try {
        if (!tool || !run.tools.includes(tool.name)) throw new Error(`Unknown tool: ${state.call.name}`);
        let args: Json;
        try {
          args = JSON.parse(state.call.arguments || "{}") as Json;
        } catch (error) {
          // 参数是模型生成的字符串，截断/坏 JSON 在派发前就要变成可读的工具错误；
          // 保留工具名，和宿主旧路径的报错口径一致，用户才知道是哪张卡坏了。
          throw new Error(`Invalid tool arguments JSON for ${state.call.name}: ${errorText(error)}`);
        }
        validate(tool.parameters, args);
        if (state.approval === "auto" && (typeof tool.needsApproval === "function" ? tool.needsApproval(args) : tool.needsApproval)) {
          state.approval = "pending";
        }
      } catch (error) { state.status = "done"; state.output = { content: errorText(error), isError: true }; }
    }
    this.save(run);
    if (run.pendingTools.some(state => state.approval === "pending")) { this.status(run, "awaiting_approval"); return false; }
    const tasks = run.pendingTools.map(async state => {
      if (state.status === "done") {
        this.emit({type:"tool",runId:run.id,callId:state.call.id,status:state.status});
        return;
      }
      if (state.status === "waiting" && !state.childRunId) return;
      if (state.approval === "denied") { state.status = "done"; state.output = { content: "Tool denied by user", isError: true }; this.save(run); return; }
      const tool = this.tools.get(state.call.name)!;
      const work = async () => {
        signal.throwIfAborted();
        state.status = "running";
        this.save(run);
        this.emit({ type: "tool", runId: run.id, callId: state.call.id, status: state.status });
        try {
          const args = JSON.parse(state.call.arguments || "{}") as Json;
          const output = tool.name === "subagent" ? await this.child(run, state, args as unknown as ChildInput, signal) :
            await tool.execute(args, { runId: run.id, callId: state.call.id, signal,
              emit: text => this.emit({ type: "tool_output", runId: run.id, callId: state.call.id, text }),
            });
          if (typeof output.content !== "string") throw new Error("Tool output must contain text");
          if (output.waitFor) {
            state.status = "waiting";
            state.output = output;
          } else {
            state.output = this.clip(output, run);
            state.status = "done";
          }
        } catch (error) {
          // Side effects interrupted by cancellation are not safe to retry automatically.
          state.status = signal.aborted ? "uncertain" : "done";
          state.output = { content: errorText(error), isError: true };
        }
        this.save(run);
        this.emit({ type: "tool", runId: run.id, callId: state.call.id, status: state.status });
      };
      if (tool.name === "subagent" || tool.orchestrator === true) await work(); // Never hold an execution slot while awaiting a child.
      else await this.scheduler.run(tool.readOnly === true, signal, work);
    });
    const settled = await Promise.allSettled(tasks);
    signal.throwIfAborted();
    const failed = settled.find(item => item.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (run.pendingTools.some(state => state.status === "waiting")) { this.status(run, "waiting"); return false; }
    const failures = run.pendingTools.filter(state => state.output?.isError);
    const signature = failures.length === run.pendingTools.length ? JSON.stringify(failures.map(state => [
      state.call.name, state.call.arguments, state.output?.content,
    ])) : undefined;
    run.repeatedErrors = signature && signature === run.lastFailure ? (run.repeatedErrors ?? 0) + 1 : signature ? 1 : 0;
    run.lastFailure = signature;
    this.store.atomic(() => {
      for (const state of run.pendingTools) run.messages.push({
        role: "tool", toolCallId: state.call.id, content: state.output?.content || "(no output)",
      });
      run.pendingTools = [];
      this.save(run);
    });
    if ((run.repeatedErrors ?? 0) >= run.limits.maxRepeatedErrors) throw new LimitError("Repeated tool failure limit reached");
    return true;
  }
  private clip(output: ToolOutput, run: Run): ToolOutput {
    if (output.content.length <= run.limits.maxToolOutputChars) return output;
    if (!run.tools.includes("artifact_read")) return {...output,content:output.content.slice(0,run.limits.maxToolOutputChars)+"\n[Tool output truncated]"};
    const id = this.store.artifact(output.content, run.rootId);
    return { ...output, content: `${output.content.slice(0, run.limits.maxToolOutputChars)}\n[Output saved: artifact ${id}; use artifact_read]` };
  }
  private async child(parent: Run, state: ToolState, input: ChildInput, signal: AbortSignal): Promise<ToolOutput> {
    if (!state.childRunId) {
      this.store.atomic(() => {
        const child = this.createRun({
          input: input.input, model: input.model ?? parent.model,
          system: input.system ?? "Complete the delegated task and return a concise, self-contained result with evidence.",
          tools: input.tools ?? parent.tools,
        }, parent);
        state.childRunId = child.id;
        this.save(parent);
      });
      this.emit({ type: "child", runId: parent.id, childId: state.childRunId! });
    }
    const child = await this.resume(state.childRunId!, signal);
    if (child.status === "completed") return { content: answerOf(child) || "Child completed without text" };
    if (isTerminal(child.status)) return { content: `Child ${child.status}: ${child.error ?? answerOf(child)}`, isError: true };
    return { content: `Child ${child.id} is ${child.status}`, waitFor: child.id };
  }
  /** Complete an explicitly asynchronous tool, then call resume. */
  completeTool(id: string, callId: string, output: ToolOutput): void {
    if (output.waitFor) throw new Error("Completion cannot wait again");
    if (this.active.has(id)) throw new Error("Wait for the run to pause");
    const run = this.store.run(id);
    const state = run.pendingTools.find(item => item.call.id === callId);
    if (run.status !== "waiting" || !state || state.status !== "waiting" || state.childRunId) throw new Error("No asynchronous tool waiting");
    state.output = this.clip(structuredClone(output), run);
    state.status = "done";
    this.save(run);
  }
}
