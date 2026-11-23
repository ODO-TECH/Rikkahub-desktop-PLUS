// media/yukkuri/cache.ts — 合成结果内存缓存
// 移植自 reference/dsh-yukkuli 的 cache.js,并沿用那条「不落盘」的权衡:
//   - 合成一段只要几毫秒,重算成本几乎为零,落盘收益抵不过管理成本
//   - 语音内容不该留在硬盘上(附件目录已经有足够的历史包袱)
// 代价:进程重启后缓存清空 —— 对这个成本来说可以忽略。

export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`LruCache capacity 必须是 >= 1 的整数,收到: ${capacity}`);
    }
  }

  get size(): number {
    return this.map.size;
  }

  /** 命中会把该项移到「最新」位置(Map 的迭代顺序 = 插入顺序) */
  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
