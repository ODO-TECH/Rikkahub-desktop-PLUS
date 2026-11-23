import { Database } from "bun:sqlite";
import type { Budget, Delivery, Run, Ticket } from "./types.ts";

/** Owns the supplied database. Use one KernelStore/runtime per database; runs are single-process. */
export class KernelStore {
  private readonly db: Database;
  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kernel_meta (version INTEGER NOT NULL);
      INSERT INTO kernel_meta SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM kernel_meta);`);
    const version = this.db.query("SELECT version FROM kernel_meta").get() as { version: number };
    if (version.version !== 1) { this.db.close(); throw new Error(`Unsupported kernel database version: ${version.version}`); }
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY, max_requests INTEGER NOT NULL, max_tokens INTEGER NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, root_id TEXT NOT NULL, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, source TEXT NOT NULL, trigger_id TEXT NOT NULL,
        body TEXT NOT NULL, UNIQUE(source, trigger_id));
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending');`);
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_root ON runs(json_extract(body,'$.rootId'))");
  }
  close(): void { this.db.close(); }
  atomic<T>(work: () => T): T { return this.db.transaction(work)(); }
  run(id: string): Run {
    const row = this.db.query("SELECT body FROM runs WHERE id=?").get(id) as { body: string } | null;
    if (!row) throw new Error(`Unknown run: ${id}`);
    return JSON.parse(row.body) as Run;
  }
  runs(rootIds?: string[]): Run[] {
    if (rootIds) {
      if (!rootIds.length) return [];
      return (this.db.query(`SELECT body FROM runs WHERE json_extract(body,'$.rootId') IN (${rootIds.map(()=>"?").join(",")})`)
        .all(...rootIds) as Array<{body:string}>).map(row=>JSON.parse(row.body) as Run);
    }
    return (this.db.query("SELECT body FROM runs").all() as Array<{ body: string }>).map(row => JSON.parse(row.body) as Run);
  }
  save(run: Run): void {
    run.updatedAt = Date.now();
    this.db.query("INSERT INTO runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(run.id, JSON.stringify(run));
  }
  budget(id: string): Budget {
    const row = this.db.query("SELECT * FROM budgets WHERE id=?").get(id) as
      { max_requests: number; max_tokens: number; requests: number; tokens: number } | null;
    if (!row) throw new Error(`Unknown budget: ${id}`);
    return { maxRequests: row.max_requests, maxTokens: row.max_tokens, requests: row.requests, tokens: row.tokens };
  }
  createBudget(id: string, maxRequests: number, maxTokens: number): void {
    this.db.query("INSERT OR IGNORE INTO budgets(id,max_requests,max_tokens) VALUES (?,?,?)").run(id, maxRequests, maxTokens);
  }
  /** Reserve the whole estimated request before starting; crashes keep the conservative charge. */
  reserve(id: string, tokens: number): boolean {
    return this.db.query(`UPDATE budgets SET requests=requests+1,tokens=tokens+? WHERE id=?
      AND requests<max_requests AND tokens+?<=max_tokens`).run(tokens, id, tokens).changes === 1;
  }
  reconcile(id: string, reserved: number, actual: number): void {
    this.db.query("UPDATE budgets SET tokens=MAX(0,tokens+?) WHERE id=?").run(actual - reserved, id);
  }
  artifact(content: string, rootId: string): string {
    const id = crypto.randomUUID();
    this.db.query("INSERT INTO artifacts VALUES (?,?,?)").run(id, rootId, content);
    return id;
  }
  readArtifact(id: string, offset = 0, length = 8000, rootId?: string): string {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 32000) {
      throw new Error("Invalid artifact page");
    }
    const row = this.db.query("SELECT SUBSTR(content,?,?) AS page FROM artifacts WHERE id=? AND (? IS NULL OR root_id=?)")
      .get(offset + 1, length, id, rootId ?? null, rootId ?? null) as { page: string } | null;
    if (!row) throw new Error(`Unknown artifact: ${id}`);
    return row.page;
  }
  ticket(id: string): Ticket {
    const row = this.db.query("SELECT body FROM tickets WHERE id=?").get(id) as { body: string } | null;
    if (!row) throw new Error(`Unknown ticket: ${id}`);
    return JSON.parse(row.body) as Ticket;
  }
  findTicket(source: string, triggerId: string): Ticket | undefined {
    const row = this.db.query("SELECT body FROM tickets WHERE source=? AND trigger_id=?").get(source, triggerId) as { body: string } | null;
    return row ? JSON.parse(row.body) as Ticket : undefined;
  }
  saveTicket(ticket: Ticket): void {
    ticket.updatedAt = Date.now();
    this.db.query(`INSERT INTO tickets VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`)
      .run(ticket.id, ticket.source, ticket.triggerId, JSON.stringify(ticket));
  }
  enqueue(delivery: Omit<Delivery, "status">): void {
    this.db.query("INSERT OR IGNORE INTO outbox(id,ticket_id,content) VALUES (?,?,?)")
      .run(delivery.id, delivery.ticketId, delivery.content);
  }
  deliveries(): Delivery[] {
    return (this.db.query("SELECT id,ticket_id,content,status FROM outbox WHERE status='pending'").all() as
      Array<{ id: string; ticket_id: string; content: string; status: "pending" }>).map(row => ({
        id: row.id, ticketId: row.ticket_id, content: row.content, status: row.status,
      }));
  }
  delivered(id: string): void { this.db.query("UPDATE outbox SET status='sent' WHERE id=?").run(id); }
  withdrawDeliveries(ticketId: string): void { this.db.query("DELETE FROM outbox WHERE ticket_id=? AND status='pending'").run(ticketId); }
}
