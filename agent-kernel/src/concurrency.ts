/** FIFO, abortable slots. Slots cover model calls, not entire agent runs: children cannot deadlock a waiting parent. */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid concurrency limit");
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) { this.active++; return this.release(); }
    await new Promise<void>((resolve, reject) => {
      const enter = () => { signal.removeEventListener("abort", abort); this.active++; resolve(); };
      const abort = () => { this.queue = this.queue.filter(item => item !== enter); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(enter);
    });
    return this.release();
  }
  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}

/** Global writer barrier: known reads overlap; writes never overlap reads or other writes. */
export class ToolScheduler {
  private tail: Promise<void> = Promise.resolve();
  private readers = new Set<Promise<unknown>>();
  private slots: Semaphore;
  constructor(limit: number) { this.slots = new Semaphore(limit); }
  run<T>(readOnly: boolean, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const barrier = this.tail;
    const reads = readOnly ? [] : [...this.readers];
    const execute = async () => {
      await barrier;
      await Promise.allSettled(reads);
      const release = await this.slots.acquire(signal);
      try { signal.throwIfAborted(); return await work(); } finally { release(); }
    };
    const result = execute();
    if (readOnly) {
      this.readers.add(result);
      void result.then(() => this.readers.delete(result), () => this.readers.delete(result));
    } else {
      this.tail = result.then(() => undefined, () => undefined);
      this.readers.clear();
    }
    return result;
  }
}
