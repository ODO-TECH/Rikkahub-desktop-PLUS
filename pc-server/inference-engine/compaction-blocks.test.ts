// inference-engine/compaction-blocks.test.ts — S5 块化记录 / S6 分层蒸馏的纯函数契约
//
// 两代记录并存且**不做数据迁移**,所以这里最重要的断言是"v1 会话逐字节不变":
//   - 无 startMessageId 的记录 = 覆盖切点之前全部,多条时只有最后一条生效(链式语义);
//   - findEffectiveCompaction 单块时返回原记录对象本身(pi/估算/自动压缩都吃这个视图)。
// S5 新增的块形态要求首尾相接;一旦出现空洞就在断点处停下,让被丢弃块的原文重新
// 逐字可见——这是唯一不丢信息的降级方向。
// S6 的蒸馏计划只判定不调模型:输入永远是下层块摘要,原文一生只在 tier-1 折一次。

import { describe, expect, test } from "bun:test";

import type { Message } from "../foundation/types";
import { estimateTokens, message } from "../foundation/utils";
import {
  COMPACTION_TIER_MAX,
  compactionRecordId,
  compactionTierOf,
  findEffectiveCompaction,
  parseEngineCompactions,
  pinnedMessagesInRange,
  planCompactionDistillation,
  resolveCompactionBlocks,
  type CompactionBlock,
  type EngineCompactionRecord,
} from "./engine-compaction";

function history(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => message("USER", [{ type: "text", text: `第${index}条` }]));
}

function record(
  cutMessageId: string,
  summary: string,
  extra: Partial<EngineCompactionRecord> = {},
): EngineCompactionRecord {
  return { cutMessageId, summary, tokensBefore: 100, ...extra };
}

const always = () => true;

describe("S5 记录解析与身份", () => {
  test("新字段宽容解析:非法值丢弃,老记录形状不变", () => {
    const parsed = parseEngineCompactions([
      { cutMessageId: "m1", summary: "旧", tokensBefore: 5 },
      {
        cutMessageId: "m3", summary: "新", tokensBefore: 7, id: "r2", startMessageId: "m1",
        tier: 2, consumedRecordIds: ["r1", 42, ""], active: false, createdAt: "2026-01-01",
      },
      { cutMessageId: "m4", summary: "坏 tier", tokensBefore: 1, tier: "2", active: "no", id: "" },
      { cutMessageId: 9, summary: "坏切点" },
    ] as never);
    expect(parsed).toHaveLength(3);
    // v1 记录:不带任何新字段(序列化回 DB 时形状与引入前一致)。
    expect(parsed[0]).toEqual({ cutMessageId: "m1", summary: "旧", tokensBefore: 5 });
    expect(parsed[1]).toEqual({
      cutMessageId: "m3", summary: "新", tokensBefore: 7, createdAt: "2026-01-01",
      id: "r2", startMessageId: "m1", tier: 2, consumedRecordIds: ["r1"], active: false,
    });
    expect(parsed[2]!.tier).toBeUndefined();
    expect(parsed[2]!.active).toBeUndefined();
    expect(parsed[2]!.id).toBeUndefined();
  });

  test("身份与层级兜底:旧记录用 legacy:<cut>,缺省 tier=1,上限夹到 3", () => {
    expect(compactionRecordId(record("m1", "x"))).toBe("legacy:m1");
    expect(compactionRecordId(record("m1", "x", { id: "r9" }))).toBe("r9");
    expect(compactionTierOf(record("m1", "x"))).toBe(1);
    expect(compactionTierOf(record("m1", "x", { tier: 0 }))).toBe(1);
    expect(compactionTierOf(record("m1", "x", { tier: 99 }))).toBe(COMPACTION_TIER_MAX);
    expect(compactionTierOf(record("m1", "x", { tier: 2.7 }))).toBe(2);
  });
});

describe("S5 生效块解析:v1 兼容", () => {
  test("单条 v1 记录 → 一个块(起点 0),findEffectiveCompaction 返回原对象", () => {
    const messages = history(5);
    const legacy = record(messages[3]!.id, "旧摘要");
    const blocks = resolveCompactionBlocks([legacy], messages, always);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.startIndex).toBe(0);
    expect(blocks[0]!.cutIndex).toBe(3);
    expect(blocks[0]!.tier).toBe(1);
    expect(findEffectiveCompaction([legacy], messages, always)).toBe(legacy);
  });

  test("v1 链:多条旧记录只有最后一条生效(与引入前 .at(-1) 逐字节一致)", () => {
    const messages = history(6);
    const first = record(messages[2]!.id, "第一版");
    const second = record(messages[4]!.id, "第一版\n\n第二版");
    expect(findEffectiveCompaction([first, second], messages, always)).toBe(second);
    expect(resolveCompactionBlocks([first, second], messages, always)).toHaveLength(1);
  });

  test("v1 陈旧记录回落到更早一条;全陈旧 → null(退回全量原文)", () => {
    const messages = history(5);
    const earlier = record(messages[2]!.id, "早");
    const stale = record("gone", "晚");
    expect(findEffectiveCompaction([earlier, stale], messages, always)).toBe(earlier);
    expect(findEffectiveCompaction([stale], messages, always)).toBeNull();
    expect(resolveCompactionBlocks([stale], messages, always)).toEqual([]);
  });

  test("isUsable 谓词被尊重(pi 传'该行能否编出条目')", () => {
    const messages = history(4);
    const unusable = record(messages[2]!.id, "空行");
    expect(resolveCompactionBlocks([unusable], messages, () => false)).toEqual([]);
    expect(resolveCompactionBlocks([unusable], messages, (msg) => msg.id !== messages[2]!.id)).toEqual([]);
  });

  test("切点为首条消息时 v1 照样生效(不额外加'必须折掉东西'的门槛)", () => {
    const messages = history(3);
    const legacy = record(messages[0]!.id, "摘要");
    const blocks = resolveCompactionBlocks([legacy], messages, always);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.cutIndex).toBe(0);
    expect(findEffectiveCompaction([legacy], messages, always)).toBe(legacy);
  });
});

describe("S5 生效块解析:块形态", () => {
  test("首尾相接的多块按锚点排序并列生效(输入乱序也一样)", () => {
    const messages = history(9);
    const b0 = record(messages[3]!.id, "块0", { id: "r0", startMessageId: messages[0]!.id });
    const b1 = record(messages[6]!.id, "块1", { id: "r1", startMessageId: messages[3]!.id });
    const blocks = resolveCompactionBlocks([b1, b0], messages, always);
    expect(blocks.map((block) => block.record.id)).toEqual(["r0", "r1"]);
    expect(blocks.map((block) => [block.startIndex, block.cutIndex])).toEqual([[0, 3], [3, 6]]);
  });

  test("v1 记录 + 后续块共存:旧链覆盖 [0,cut),新块从该切点接上", () => {
    const messages = history(8);
    const legacy = record(messages[3]!.id, "旧链摘要");
    const modern = record(messages[6]!.id, "新块", { id: "r1", startMessageId: messages[3]!.id });
    const blocks = resolveCompactionBlocks([legacy, modern], messages, always);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.record).toBe(legacy);
    expect(blocks[0]!.startIndex).toBe(0);
    expect(blocks[1]!.startIndex).toBe(3);
  });

  test("空洞 → 在第一个断点处停下,后续块一律不收(原文重新可见,不丢信息)", () => {
    const messages = history(10);
    const b0 = record(messages[3]!.id, "块0", { id: "r0", startMessageId: messages[0]!.id });
    // 起点 5 ≠ 前块切点 3:中间 [3,5) 没有摘要覆盖。
    const b1 = record(messages[8]!.id, "块1", { id: "r1", startMessageId: messages[5]!.id });
    const blocks = resolveCompactionBlocks([b0, b1], messages, always);
    expect(blocks.map((block) => block.record.id)).toEqual(["r0"]);
    expect(findEffectiveCompaction([b0, b1], messages, always)).toBe(b0);
  });

  test("中间块被停用(active=false)同样造成断点 → 只保留前缀", () => {
    const messages = history(10);
    const b0 = record(messages[3]!.id, "块0", { id: "r0", startMessageId: messages[0]!.id });
    const b1 = record(messages[6]!.id, "块1", { id: "r1", startMessageId: messages[3]!.id, active: false });
    const b2 = record(messages[9]!.id, "块2", { id: "r2", startMessageId: messages[6]!.id });
    expect(resolveCompactionBlocks([b0, b1, b2], messages, always).map((b) => b.record.id)).toEqual(["r0"]);
  });

  test("起点/切点消息被删 → 该块丢弃;起点不在切点之前 → 丢弃", () => {
    const messages = history(6);
    const goneStart = record(messages[4]!.id, "x", { id: "a", startMessageId: "gone" });
    const goneCut = record("gone", "y", { id: "b", startMessageId: messages[0]!.id });
    const reversed = record(messages[1]!.id, "z", { id: "c", startMessageId: messages[4]!.id });
    expect(resolveCompactionBlocks([goneStart, goneCut, reversed], messages, always)).toEqual([]);
  });

  test("多块扁平视图(pi/估算/自动压缩共用):cut=末块,summary=按序拼接,tokensBefore=求和", () => {
    const messages = history(9);
    const b0 = record(messages[3]!.id, "块0摘要", { id: "r0", startMessageId: messages[0]!.id, tokensBefore: 11 });
    const b1 = record(messages[6]!.id, "块1摘要", { id: "r1", startMessageId: messages[3]!.id, tokensBefore: 22, createdAt: "2026-02-02" });
    const flat = findEffectiveCompaction([b0, b1], messages, always)!;
    expect(flat.cutMessageId).toBe(messages[6]!.id);
    expect(flat.summary).toBe("块0摘要\n\n块1摘要");
    expect(flat.tokensBefore).toBe(33);
    expect(flat.createdAt).toBe("2026-02-02");
    // 扁平视图是合成对象,不冒充任何一块的身份。
    expect(flat).not.toBe(b0);
    expect(flat).not.toBe(b1);
    expect(flat.id).toBeUndefined();
  });
});

describe("S5 钉住消息按块归属", () => {
  test("pinnedMessagesInRange 只取本块区间内的钉住消息", () => {
    const messages = history(6);
    messages[1]!.annotations = [{ type: "pinned" }];
    messages[4]!.annotations = [{ type: "pinned" }];
    // 块 [0,3):只含 index 1;块 [3,6):只含 index 4。
    expect(pinnedMessagesInRange(messages, 0, 3).map((msg) => msg.id)).toEqual([messages[1]!.id]);
    expect(pinnedMessagesInRange(messages, 3, 6).map((msg) => msg.id)).toEqual([messages[4]!.id]);
    // 空区间/逆序区间 → 空集,绝不抛。
    expect(pinnedMessagesInRange(messages, 3, 3)).toEqual([]);
    expect(pinnedMessagesInRange(messages, 5, 2)).toEqual([]);
    expect(pinnedMessagesInRange(messages, -4, 2).map((msg) => msg.id)).toEqual([messages[1]!.id]);
  });
});

describe("S6 分层蒸馏计划", () => {
  function blocks(specs: Array<{ start: number; cut: number; summary: string; tier?: number; id: string }>, messages: Message[]): CompactionBlock[] {
    return specs.map((spec) => ({
      record: record(messages[spec.cut]!.id, spec.summary, {
        id: spec.id,
        startMessageId: messages[spec.start]!.id,
        tier: spec.tier ?? 1,
        tokensBefore: 1000,
      }),
      startIndex: spec.start,
      cutIndex: spec.cut,
      tier: spec.tier ?? 1,
    }));
  }

  test("总量未超预算 → 不蒸馏", () => {
    const messages = history(9);
    const list = blocks([
      { start: 0, cut: 3, summary: "短摘要一", id: "r0" },
      { start: 3, cut: 6, summary: "短摘要二", id: "r1" },
    ], messages);
    expect(planCompactionDistillation(list, 10_000)).toBeNull();
  });

  test("只有一块(即使超预算)→ 不蒸馏:1 块换 1 块只是白烧一轮模型", () => {
    const messages = history(6);
    const list = blocks([{ start: 0, cut: 3, summary: "长".repeat(5000), id: "r0" }], messages);
    expect(planCompactionDistillation(list, 1024)).toBeNull();
  });

  test("两块超预算 → 吸收两块合成 tier-2,输入是块摘要拼接(不掺原文)", () => {
    const messages = history(9);
    const long = "很长的摘要。".repeat(400);
    const list = blocks([
      { start: 0, cut: 3, summary: long, id: "r0" },
      { start: 3, cut: 6, summary: long, id: "r1" },
    ], messages);
    const plan = planCompactionDistillation(list, 1024)!;
    expect(plan.consumed.map((block) => block.record.id)).toEqual(["r0", "r1"]);
    expect(plan.tier).toBe(2);
    expect(plan.startIndex).toBe(0);
    expect(plan.cutIndex).toBe(6);
    expect(plan.cutMessageId).toBe(messages[6]!.id);
    expect(plan.tokensBefore).toBe(2000);
    expect(plan.inputSummary).toBe(`${long}\n\n${long}`);
    expect(plan.inputTokens).toBe(estimateTokens(plan.inputSummary));
    expect(plan.inputSummary).not.toContain("第0条");
  });

  test("贪心在'吸收量够预算且至少两块'处停下,不吞掉后面的新块", () => {
    const messages = history(12);
    const long = "长".repeat(2000);
    const list = blocks([
      { start: 0, cut: 3, summary: long, id: "r0" },
      { start: 3, cut: 6, summary: long, id: "r1" },
      { start: 6, cut: 9, summary: long, id: "r2" },
    ], messages);
    const plan = planCompactionDistillation(list, 1024)!;
    expect(plan.consumed.map((block) => block.record.id)).toEqual(["r0", "r1"]);
    expect(plan.cutIndex).toBe(6);
  });

  test("层级上限:已到顶的块不参与;混合层级取 min+1 并夹到上限", () => {
    const messages = history(12);
    const long = "长".repeat(2000);
    const capped = blocks([
      { start: 0, cut: 3, summary: long, id: "r0", tier: COMPACTION_TIER_MAX },
      { start: 3, cut: 6, summary: long, id: "r1", tier: COMPACTION_TIER_MAX },
    ], messages);
    expect(planCompactionDistillation(capped, 1024)).toBeNull();

    const mixed = blocks([
      { start: 0, cut: 3, summary: long, id: "r0", tier: 2 },
      { start: 3, cut: 6, summary: long, id: "r1", tier: 1 },
      { start: 6, cut: 9, summary: long, id: "r2", tier: 1 },
    ], messages);
    const plan = planCompactionDistillation(mixed, 1024)!;
    expect(plan.tier).toBe(2); // min(2,1)+1
    expect(plan.consumed).toHaveLength(2);

    const nearCap = blocks([
      { start: 0, cut: 3, summary: long, id: "r0", tier: 2 },
      { start: 3, cut: 6, summary: long, id: "r1", tier: 2 },
    ], messages);
    expect(planCompactionDistillation(nearCap, 1024)!.tier).toBe(COMPACTION_TIER_MAX);
  });

  test("首块是 v1 形态(无 startMessageId)时,计划给下标而不是抄空字段", () => {
    const messages = history(9);
    const long = "长".repeat(2000);
    const legacy: CompactionBlock = {
      record: record(messages[3]!.id, long, { tokensBefore: 500 }),
      startIndex: 0,
      cutIndex: 3,
      tier: 1,
    };
    const modern: CompactionBlock = {
      record: record(messages[6]!.id, long, { id: "r1", startMessageId: messages[3]!.id, tokensBefore: 700 }),
      startIndex: 3,
      cutIndex: 6,
      tier: 1,
    };
    const plan = planCompactionDistillation([legacy, modern], 1024)!;
    expect(plan.startIndex).toBe(0);
    expect(plan.cutMessageId).toBe(messages[6]!.id);
    expect(plan.tokensBefore).toBe(1200);
  });
});

describe("S6 血统可恢复(蒸馏是可逆操作)", () => {
  // decompress 的语义就是这两步:上层块 active=false + consumedRecordIds 指到的子块 active=true。
  // 这里钉的是"做完这两步之后,生效块集恰好回到蒸馏前",而不是钉工具本身(工具在 S7)。
  test("停用上层块并重新启用子块 → 生效块集逐字段回到蒸馏前", () => {
    const messages = history(12);
    const childA = record(messages[3]!.id, "子摘要一", {
      id: "r0", startMessageId: messages[0]!.id, tokensBefore: 400, tier: 1, active: true,
    });
    const childB = record(messages[6]!.id, "子摘要二", {
      id: "r1", startMessageId: messages[3]!.id, tokensBefore: 500, tier: 1, active: true,
    });
    const tail = record(messages[9]!.id, "尾块摘要", {
      id: "r2", startMessageId: messages[6]!.id, tokensBefore: 600, tier: 1, active: true,
    });
    const before = resolveCompactionBlocks([childA, childB, tail], messages, always);
    expect(before.map((block) => block.record.id)).toEqual(["r0", "r1", "r2"]);

    // 蒸馏:r0+r1 被吸收成 tier-2,覆盖 [0,6),尾块不动。
    const upper = record(messages[6]!.id, "上层摘要", {
      id: "u0", startMessageId: messages[0]!.id, tokensBefore: 900, tier: 2,
      consumedRecordIds: ["r0", "r1"], active: true,
    });
    const distilled = [childA, childB, tail, upper].map((item) => ({ ...item }));
    distilled[0]!.active = false;
    distilled[1]!.active = false;
    const during = resolveCompactionBlocks(distilled, messages, always);
    expect(during.map((block) => block.record.id)).toEqual(["u0", "r2"]);
    expect(during[0]!.startIndex).toBe(0);
    expect(during[0]!.cutIndex).toBe(6);

    // 恢复:上层停用、子块重新启用。记录一条没删,原文索引也没动。
    const restored = distilled.map((item) => ({ ...item }));
    restored[3]!.active = false;
    for (const id of upper.consumedRecordIds ?? []) {
      const child = restored.find((item) => compactionRecordId(item) === id);
      if (child) child.active = true;
    }
    const after = resolveCompactionBlocks(restored, messages, always);
    expect(after.map((block) => block.record.id)).toEqual(["r0", "r1", "r2"]);
    expect(after.map((block) => [block.startIndex, block.cutIndex, block.tier]))
      .toEqual(before.map((block) => [block.startIndex, block.cutIndex, block.tier]));
    expect(after.map((block) => block.record.summary)).toEqual(before.map((block) => block.record.summary));
    // 原文仍在历史里逐字完好(停用只改 active,从不删消息行)。
    expect(messages).toHaveLength(12);
    expect(messages[0]!.parts[0]).toEqual({ type: "text", text: "第0条" });
  });

  test("只停用上层块而不复活子块 → 断点降级:该段原文重新逐字可见,不丢信息", () => {
    const messages = history(9);
    const child = record(messages[3]!.id, "子摘要", {
      id: "r0", startMessageId: messages[0]!.id, active: false,
    });
    const upper = record(messages[6]!.id, "上层摘要", {
      id: "u0", startMessageId: messages[0]!.id, tier: 2, consumedRecordIds: ["r0"], active: false,
    });
    const tail = record(messages[8]!.id, "尾块", {
      id: "r1", startMessageId: messages[6]!.id, active: true,
    });
    // 首块空缺 → covered 停在 0,尾块(起点 6)接不上,整条链退回全量原文。
    expect(resolveCompactionBlocks([child, upper, tail], messages, always)).toEqual([]);
    expect(findEffectiveCompaction([child, upper, tail], messages, always)).toBeNull();
  });
});