import type { AgentRuntime } from "./runtime.ts";
import { Semaphore } from "./concurrency.ts";
import { answerOf, isTerminal, limitsOf } from "./types.ts";
import type { Delivery, Limits, Task, TaskSpec, Ticket } from "./types.ts";

export interface Intake {
  budgetId?: string;
  /** Stable source event ID is required for idempotent intake. Source authorization happens before intake. */
  source: string;
  triggerId: string;
  prompt: string;
  model: string;
  system?: string;
  tools?: string[];
  tasks?: TaskSpec[];
  limits?: Partial<Limits>;
}
export interface SuperagentOptions {
  runtime: AgentRuntime;
  maxWorkers?: number;
  maxReplans?: number;
  /** A caller can verify tool evidence or artifacts. Without this, task success means run completion only. */
  verify?: (task: Task) => Promise<{ ok: boolean; evidence: string }>;
}

function plan(specs: TaskSpec[]): Task[] {
  if (!specs.length || specs.length > 64) throw new Error("A plan must contain 1–64 tasks");
  const map = new Map<string, TaskSpec>();
  for (const spec of specs) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(spec.id) || map.has(spec.id) || !spec.prompt.trim()) throw new Error("Invalid task plan");
    map.set(spec.id, spec);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Task dependency cycle");
    if (done.has(id)) return;
    const task = map.get(id);
    if (!task) throw new Error(`Unknown task dependency: ${id}`);
    visiting.add(id);
    for (const dependency of task.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of map.keys()) visit(id);
  return structuredClone(specs).map(task => ({ ...task, status: "pending" }));
}

/** Small durable coordinator: tasks, dependencies, bounded workers, explicit replans and delivery receipts. */
export class Superagent {
  private readonly busy = new Map<string, Promise<Ticket>>();
  private readonly maxWorkers: number;
  private readonly maxReplans: number;
  private readonly runtime: AgentRuntime;
  private readonly workers: Semaphore;
  private flushing = false;
  private stopped = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly options: SuperagentOptions) {
    this.runtime = options.runtime;
    this.maxWorkers = options.maxWorkers ?? 2;
    this.maxReplans = options.maxReplans ?? 2;
    if (!Number.isSafeInteger(this.maxWorkers) || this.maxWorkers < 1 || this.maxWorkers > 16 ||
      !Number.isSafeInteger(this.maxReplans) || this.maxReplans < 0 || this.maxReplans > 10) throw new Error("Invalid supervisor limits");
    this.workers = new Semaphore(this.maxWorkers);
  }
  accept(input: Intake): Ticket {
    if (!input.source.trim() || !input.triggerId.trim() || !input.prompt.trim() || !input.model.trim()) throw new Error("Invalid intake");
    return this.runtime.store.atomic(() => {
      const existing = this.runtime.store.findTicket(input.source, input.triggerId);
      if (existing) return existing;
      const id = crypto.randomUUID();
      const limits = limitsOf(input.limits);
      const ticket: Ticket = {
        id, budgetId: input.budgetId, source: input.source, triggerId: input.triggerId, prompt: input.prompt, model: input.model,
        system: input.system, tools: input.tools, limits,
        tasks: plan(input.tasks ?? [{ id: "work", prompt: input.prompt }]), replans: 0,
        status: "open", createdAt: Date.now(), updatedAt: Date.now(),
      };
      if (input.budgetId) this.runtime.store.budget(input.budgetId);
      else this.runtime.store.createBudget(id, limits.maxRequests, limits.maxTokens);
      this.runtime.store.saveTicket(ticket);
      return ticket;
    });
  }
  inspect(id: string): Ticket { return this.runtime.store.ticket(id); }
  async advance(id: string): Promise<Ticket> {
    const active = this.busy.get(id);
    if (active) return active;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const promise = Promise.resolve().then(() => this.drive(id, controller.signal)).finally(() => {
      this.busy.delete(id); this.stopped.delete(id); this.controllers.delete(id);
    });
    this.busy.set(id, promise);
    return promise;
  }
  private async drive(id: string, signal: AbortSignal): Promise<Ticket> {
    const ticket = this.inspect(id);
    if (["completed", "cancelled", "ready"].includes(ticket.status)) return ticket;
    ticket.status = "running";
    this.runtime.store.saveTicket(ticket);
    const attempted = new Set<string>();
    while (true) {
      if (this.stopped.has(id)) return this.inspect(id);
      const candidates = ticket.tasks.filter(task => !attempted.has(task.id) && task.status !== "completed" && task.status !== "failed" &&
        (task.dependsOn ?? []).every(dependency => ticket.tasks.find(item => item.id === dependency)?.status === "completed"));
      if (!candidates.length) break;
      const wave = candidates.slice(0, this.maxWorkers);
      await Promise.all(wave.map(async task => {
        attempted.add(task.id);
        let release: (() => void) | undefined;
        try {
          release = await this.workers.acquire(signal);
          if (this.stopped.has(id)) return;
          if (!task.runId) {
            const dependencies = (task.dependsOn ?? []).map(dependency => ticket.tasks.find(item => item.id === dependency)!);
            const context = dependencies.map(item => `[${item.id}]\n${item.result?.slice(0, 8000) ?? ""}`).join("\n\n");
            this.runtime.store.atomic(() => {
              const requested = task.tools ?? ticket.tools;
              if (task.tools && ticket.tools && task.tools.some(name => !ticket.tools!.includes(name))) throw new Error("Task tools exceed ticket scope");
              task.runId = this.runtime.createWork({
                model: ticket.model, system: ticket.system,
                input: `Overall task: ${ticket.prompt}\n\nAssignment: ${task.prompt}${context ? `\n\nDependency results:\n${context}` : ""}`,
                tools: requested, limits: ticket.limits,
              }, ticket.budgetId ?? ticket.id);
              task.status = "running";
              this.runtime.store.saveTicket(ticket);
            });
          }
          const run = await this.runtime.resume(task.runId!, signal);
          if (this.stopped.has(id)) return;
          task.result = (answerOf(run) || run.error || "").slice(0, 16000);
          if (run.status === "completed") {
            if (this.options.verify) {
              const verification = await this.options.verify(structuredClone(task));
              task.evidence = verification.evidence;
              task.status = verification.ok ? "completed" : "failed";
            } else task.status = "completed";
          } else task.status = isTerminal(run.status) ? "failed" : "waiting";
        } catch (error) {
          task.status = "failed";
          task.result = error instanceof Error ? error.message : String(error);
        } finally { release?.(); }
        if (!this.stopped.has(id)) this.runtime.store.saveTicket(ticket);
      }));
      if (this.stopped.has(id)) return this.inspect(id);
    }
    if (ticket.tasks.every(task => task.status === "completed")) {
      ticket.status = "ready";
      this.runtime.store.atomic(() => {
        this.runtime.store.saveTicket(ticket);
        this.runtime.store.enqueue({ id: `${id}:ready:${ticket.replans}`, ticketId: id,
          content: ticket.tasks.map(task => `${task.id}: ${task.result ?? ""}`).join("\n\n") });
      });
    } else {
      ticket.status = ticket.tasks.some(task => task.status === "failed") ? "failed" : "waiting";
      this.runtime.store.saveTicket(ticket);
    }
    return this.inspect(id);
  }
  /** Explicit bounded replan; no mandatory planner/reviewer model requests. */
  replan(id: string, tasks: TaskSpec[]): Ticket {
    if (this.busy.has(id)) throw new Error("Ticket is active");
    const ticket = this.inspect(id);
    if (!["failed", "waiting", "open"].includes(ticket.status) || ticket.replans >= this.maxReplans) throw new Error("Replan unavailable");
    const next = plan(tasks);
    for (const task of ticket.tasks) if (task.runId && !isTerminal(this.runtime.inspect(task.runId).status)) this.runtime.cancel(task.runId);
    ticket.tasks = next;
    ticket.replans++;
    ticket.status = "open";
    this.runtime.store.saveTicket(ticket);
    return ticket;
  }
  /** New source messages route to the matching task; the source adapter decides routing/authorization. */
  send(id: string, taskId: string, text: string): void {
    const ticket = this.inspect(id);
    const task = ticket.tasks.find(item => item.id === taskId);
    if (!task?.runId || ["ready", "completed", "cancelled"].includes(ticket.status)) throw new Error("Task cannot receive input");
    this.runtime.send(task.runId, text);
  }
  cancel(id: string): void {
    const ticket = this.inspect(id);
    if (["completed", "cancelled"].includes(ticket.status)) return;
    if (this.busy.has(id)) this.stopped.add(id);
    this.controllers.get(id)?.abort(new DOMException("Ticket cancelled", "AbortError"));
    for (const task of ticket.tasks) if (task.runId) this.runtime.cancel(task.runId);
    ticket.status = "cancelled";
    this.runtime.store.atomic(() => {
      this.runtime.store.saveTicket(ticket);
      this.runtime.store.withdrawDeliveries(id);
    });
  }
  complete(id: string): void {
    const ticket = this.inspect(id);
    if (ticket.status !== "ready") throw new Error("Ticket is not ready for acceptance");
    ticket.status = "completed";
    this.runtime.store.saveTicket(ticket);
  }
  /** Stable delivery.id is the destination's idempotency key. Failure leaves the row pending. */
  async flush(send: (delivery: Delivery) => Promise<void>): Promise<number> {
    if (this.flushing) throw new Error("Delivery is already active");
    this.flushing = true;
    let sent = 0;
    try {
      for (const delivery of this.runtime.store.deliveries()) {
        await send(delivery);
        this.runtime.store.delivered(delivery.id);
        sent++;
      }
    } finally { this.flushing = false; }
    return sent;
  }
}
