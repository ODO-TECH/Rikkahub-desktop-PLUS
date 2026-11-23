// media/yukkuri/cache.test.ts — 内存 LRU
// 这个缓存存在的唯一理由是「同一句重播不该再算一次」,所以淘汰顺序必须可信:
// Map 的插入顺序 = 最近使用顺序,这个不变量一旦被改坏,缓存就变成随机命中。
import { expect, test } from "bun:test";
import { LruCache } from "./cache";

test("超容量淘汰最久未用的,取用会把它挪回最新", () => {
  const cache = new LruCache<number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  expect(cache.get("a")).toBe(1); // a 变最新 → b 成为最久未用
  cache.set("c", 3);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe(1);
  expect(cache.get("c")).toBe(3);
  expect(cache.size).toBe(2);
});

test("重复 set 覆盖而不增容量,空缓存读取安全", () => {
  const cache = new LruCache<string>(1);
  cache.set("k", "first");
  cache.set("k", "second");
  expect(cache.size).toBe(1);
  expect(cache.get("k")).toBe("second");
  expect(new LruCache<string>(4).get("nope")).toBeUndefined();
});

test("clear 清空;容量非法直接报错(不静默按 1 处理)", () => {
  const cache = new LruCache<number>(3);
  cache.set("a", 1);
  cache.clear();
  expect(cache.size).toBe(0);
  expect(() => new LruCache<number>(0)).toThrow(/capacity/);
  expect(() => new LruCache<number>(1.5)).toThrow(/capacity/);
});
