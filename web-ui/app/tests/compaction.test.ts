// 压缩边界展示面判定(lib/compaction.ts)——分割线锚点的数据契约。
import { describe, expect, it } from "bun:test";

import {
  buildCompactionAnchors,
  COMPRESS_RATIO_DEFAULT,
  COMPRESS_RATIO_MAX,
  COMPRESS_RATIO_MIN,
  COMPRESS_RATIO_WARN,
  compressRatioToTargetTokens,
  CONTEXT_WARNING_RESERVE_TOKENS,
  contextWarningReserveFallback,
  compactionAfterMessage,
  compactionAnchorEntries,
  compactionDividerBelow,
  contextWarningPercent,
  estimateCompactionTokens,
  isCompactionBoundaryMessage,
  isCompactionCutMessage,
  latestCompactionPlacement,
  normalizeCompressKeepRecent,
  normalizeCompressRatio,
  parseCompactionRecords,
  type CompactionTimelineNode,
} from "~/lib/compaction";
import type { UIMessage } from "~/types";

describe("isCompactionBoundaryMessage(旧破坏式压缩发生点)", () => {
  it("按注解判别,缺 annotations 容忍", () => {
    expect(isCompactionBoundaryMessage({ annotations: [{ type: "compaction_boundary" }] })).toBe(
      true,
    );
    expect(
      isCompactionBoundaryMessage({ annotations: [{ type: "model_call_error", message: "x" }] }),
    ).toBe(false);
    expect(isCompactionBoundaryMessage({ annotations: [] })).toBe(false);
    expect(isCompactionBoundaryMessage({ annotations: undefined as unknown as [] })).toBe(false);
  });
});

describe("isCompactionCutMessage(非破坏式压缩的记忆边界)", () => {
  it("按注解判别,与 boundary 互不误判", () => {
    expect(isCompactionCutMessage({ annotations: [{ type: "compaction_cut" }] })).toBe(true);
    expect(isCompactionCutMessage({ annotations: [{ type: "compaction_boundary" }] })).toBe(false);
    expect(isCompactionCutMessage({ annotations: [] })).toBe(false);
    expect(isCompactionCutMessage({ annotations: undefined as unknown as [] })).toBe(false);
  });
});

describe("compactionDividerBelow", () => {
  it("两代注解各自出线,cut 优先", () => {
    expect(compactionDividerBelow({ annotations: [{ type: "compaction_cut" }] })).toBe("cut");
    expect(compactionDividerBelow({ annotations: [{ type: "compaction_boundary" }] })).toBe(
      "boundary",
    );
    expect(
      compactionDividerBelow({
        annotations: [{ type: "compaction_boundary" }, { type: "compaction_cut" }],
      }),
    ).toBe("cut");
    expect(compactionDividerBelow({ annotations: [] })).toBeNull();
    expect(compactionDividerBelow({ annotations: undefined as unknown as [] })).toBeNull();
  });
});

describe("contextWarningPercent(上下文即将用完提示)", () => {
  const limit = 100_000;
  const nearLimit = limit - CONTEXT_WARNING_RESERVE_TOKENS / 2;

  it("越过 threshold = limit - reserve 才提示", () => {
    expect(
      contextWarningPercent({ promptTokens: 1000, completionTokens: 500, contextLimit: limit }),
    ).toBeNull();
    expect(
      contextWarningPercent({
        promptTokens: limit - CONTEXT_WARNING_RESERVE_TOKENS - 100,
        completionTokens: 100,
        contextLimit: limit,
      }),
    ).toBeNull();
    expect(
      contextWarningPercent({ promptTokens: nearLimit, completionTokens: 0, contextLimit: limit }),
    ).toBe(Math.round((nearLimit / limit) * 100));
    // 上限 100%:估算越界也不显示 101%。
    expect(
      contextWarningPercent({ promptTokens: limit * 2, completionTokens: 0, contextLimit: limit }),
    ).toBe(100);
  });

  it("分母:live 优先,回退消息快照;都没有则不算", () => {
    const usage = { promptTokens: nearLimit, completionTokens: 0 };
    // 快照 200k 本不告警,live 100k 生效 → 告警(live 优先)。
    expect(contextWarningPercent({ ...usage, contextLimit: 200_000 }, limit)).toBe(
      Math.round((nearLimit / limit) * 100),
    );
    // 无 live 时回退快照:50k 窗口下已越界 → 100%。
    expect(contextWarningPercent({ ...usage, contextLimit: 50_000 })).toBe(100);
    // live 200k 本不告警(快照 100k 会告警)→ 证明 live 真的优先。
    expect(contextWarningPercent({ ...usage, contextLimit: limit }, 200_000)).toBeNull();
    // 两侧都没有 → 不算百分比。
    expect(contextWarningPercent({ ...usage, contextLimit: null })).toBeNull();
  });

  it("窗口本身小于保留量:阈值失效,不提示", () => {
    expect(
      contextWarningPercent({ promptTokens: 10_000, completionTokens: 0, contextLimit: 16_000 }),
    ).toBeNull();
  });

  it("S3:服务端下发的预留优先,与后端自动压缩触发线同一个数", () => {
    // 8k 窗口 + 2048 预留 → 阈值 6144。旧口径写死 16384 时这里阈值 ≤0,永不提示。
    expect(contextWarningPercent({ promptTokens: 6_000, completionTokens: 0, contextLimit: 8_192 }, null, 2_048)).toBeNull();
    expect(contextWarningPercent({ promptTokens: 6_145, completionTokens: 0, contextLimit: 8_192 }, null, 2_048)).toBe(
      Math.round((6_145 / 8_192) * 100),
    );
    // 大窗口:服务端预留 32768 比回退值 16384 大 → 更早提示(与后端 83.6% 触发线一致)。
    const usage = { promptTokens: 170_000, completionTokens: 0, contextLimit: 200_000 };
    expect(contextWarningPercent(usage)).toBeNull(); // 回退预留 16384 → 阈值 183624,未越线
    expect(contextWarningPercent(usage, null, 32_768)).toBe(85);
    // 非法/缺省预留回退到按窗口比例,而不是当成 0。
    expect(contextWarningPercent(usage, null, 0)).toBeNull();
    expect(contextWarningPercent(usage, null, null)).toBeNull();
  });

  it("S3:无服务端值时的回退 = max(2048, min(16384, 窗口 1/4))", () => {
    expect(contextWarningReserveFallback(8_192)).toBe(2_048);
    expect(contextWarningReserveFallback(32_768)).toBe(8_192);
    expect(contextWarningReserveFallback(200_000)).toBe(CONTEXT_WARNING_RESERVE_TOKENS);
    // 小窗口模型从此**有**提示(旧口径 16k 预留让 8k 窗口永不提示)。
    expect(contextWarningPercent({ promptTokens: 7_000, completionTokens: 0, contextLimit: 8_192 })).toBe(
      Math.round((7_000 / 8_192) * 100),
    );
  });
});

describe("压缩记录解析与锚点映射(详情卡数据面)", () => {
  const message = (id: string) => ({ id }) as UIMessage;
  const node = (selectedId: string, ...otherIds: string[]): CompactionTimelineNode => ({
    messages: [selectedId, ...otherIds].map(message),
    selectedId,
  });
  const record = (
    cutMessageId: string,
    summary = "旧摘要",
    tokensBefore = 100,
    createdAt?: string,
  ) => ({
    cutMessageId,
    summary,
    tokensBefore,
    ...(createdAt ? { createdAt } : {}),
  });

  it("宽容解析:坏条目丢弃,tokensBefore 非法回 0", () => {
    expect(
      parseCompactionRecords([
        record("m2"),
        null,
        "junk",
        { cutMessageId: 1, summary: "x" },
        { cutMessageId: "m3", summary: 2 },
        { cutMessageId: "m4", summary: "ok", tokensBefore: -5 },
      ]),
    ).toEqual([
      { cutMessageId: "m2", summary: "旧摘要", tokensBefore: 100 },
      { cutMessageId: "m4", summary: "ok", tokensBefore: 0 },
    ]);
    expect(parseCompactionRecords(null)).toEqual([]);
    expect(parseCompactionRecords({})).toEqual([]);
  });

  it("切点 → 前一节点选中消息;非选中候选也能定位切点", () => {
    const nodes = [node("m1"), node("m2", "m2-other"), node("m3")];
    const anchors = buildCompactionAnchors([record("m2-other")], nodes);
    expect(anchors.get("m1")?.record.cutMessageId).toBe("m2-other");
    expect(anchors.get("m1")?.cutMessage.id).toBe("m2-other");
    expect(anchors.has("m2")).toBe(false);
  });

  it("同一锚点多条记录:最新一条覆盖,摘要增量按上一版计算", () => {
    const nodes = [node("m1"), node("m2"), node("m3")];
    const anchors = buildCompactionAnchors(
      [record("m2", "AAAA"), record("m2", "AAAA\n\nBBBBBBBB")],
      nodes,
    );
    const info = anchors.get("m1")!;
    expect(info.record.summary).toBe("AAAA\n\nBBBBBBBB");
    expect(info.summaryTokens).toBe(estimateCompactionTokens("AAAA\n\nBBBBBBBB"));
    expect(info.previousSummaryTokens).toBe(estimateCompactionTokens("AAAA"));
  });

  it("切点在首条/切点已被删除/锚点未选中:不产生入口", () => {
    expect(buildCompactionAnchors([record("m1")], [node("m1"), node("m2")]).size).toBe(0);
    expect(buildCompactionAnchors([record("gone")], [node("m1"), node("m2")]).size).toBe(0);
    expect(buildCompactionAnchors([record("m2")], [node(""), node("m2")]).size).toBe(0);
  });

  it("latestCompactionPlacement:取最后一条有效记录及其折叠范围", () => {
    const nodes = [node("m1"), node("m2"), node("m3"), node("m4")];
    const placement = latestCompactionPlacement(
      [record("m2", "一"), record("m4", "二")],
      nodes,
    )!;
    expect(placement.record.cutMessageId).toBe("m4");
    expect(placement.anchorId).toBe("m3");
    expect(placement.anchorNodeIndex).toBe(2);
    expect(placement.cutNodeIndex).toBe(3);
  });

  it("latestCompactionPlacement:最新记录失效时回落到更早的有效记录", () => {
    const nodes = [node("m1"), node("m2"), node("m3")];
    // 最后一条的切点已被删除 → 回落到记录一。
    const placement = latestCompactionPlacement([record("m2", "一"), record("gone", "二")], nodes)!;
    expect(placement.record.cutMessageId).toBe("m2");
    expect(placement.anchorId).toBe("m1");
    expect(placement.anchorNodeIndex).toBe(0);
    // 全部无效 / 空数据 → 不折叠。
    expect(latestCompactionPlacement([record("gone")], nodes)).toBeNull();
    expect(latestCompactionPlacement([], nodes)).toBeNull();
    expect(latestCompactionPlacement(null, nodes)).toBeNull();
  });

  it("估算口径与后端 estimateTokens 一致(CJK 1/字 / 其他 1/4,至少 1)", () => {
    expect(estimateCompactionTokens("")).toBe(1);
    expect(estimateCompactionTokens("abcd")).toBe(1);
    expect(estimateCompactionTokens("你好")).toBe(2);
    expect(estimateCompactionTokens("你好abcd")).toBe(3);
    // 假名/谚文/CJK 标点必须与后端同口径,否则详情卡与压缩判定打架。
    expect(estimateCompactionTokens("こんにちは")).toBe(5);
    expect(estimateCompactionTokens("안녕하세요")).toBe(5);
    expect(estimateCompactionTokens("。、《》")).toBe(4);
  });
});

describe("compactionAfterMessage(压缩后旧 usage 不再提示)", () => {
  const record = (createdAt?: string) =>
    createdAt
      ? [{ cutMessageId: "m2", summary: "s", tokensBefore: 1, createdAt }]
      : [{ cutMessageId: "m2", summary: "s", tokensBefore: 1 }];

  it("消息早于最近一次压缩 → true(usage 已过期)", () => {
    expect(
      compactionAfterMessage(record("2026-10-25T10:00:00.000Z"), "2026-10-25T09:59:00.000Z"),
    ).toBe(true);
    // 多条记录取最新时间。
    expect(
      compactionAfterMessage(
        [...record("2026-10-25T08:00:00.000Z"), ...record("2026-10-25T10:00:00.000Z")],
        "2026-10-25T09:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("消息晚于压缩 / 无压缩 / 脏数据 → false(按新 usage 判断)", () => {
    expect(
      compactionAfterMessage(record("2026-10-25T10:00:00.000Z"), "2026-10-25T10:01:00.000Z"),
    ).toBe(false);
    expect(compactionAfterMessage(null, "2026-10-25T10:01:00.000Z")).toBe(false);
    expect(compactionAfterMessage([], "2026-10-25T10:01:00.000Z")).toBe(false);
    // 旧记录无 createdAt(pi 存量):无法比时间,不据此抑制提示。
    expect(compactionAfterMessage(record(), "2026-10-25T10:01:00.000Z")).toBe(false);
    expect(compactionAfterMessage(record("2026-10-25T10:00:00.000Z"), undefined)).toBe(false);
  });
});

describe("手动压缩参数归一化(对话框输入)", () => {
  it("保留条数:任意非负整数,0 合法,负数归零,空串回退", () => {
    expect(normalizeCompressKeepRecent("")).toBe(32);
    expect(normalizeCompressKeepRecent("x")).toBe(32);
    expect(normalizeCompressKeepRecent("0")).toBe(0);
    expect(normalizeCompressKeepRecent("8")).toBe(8);
    expect(normalizeCompressKeepRecent("100")).toBe(100);
    expect(normalizeCompressKeepRecent("-5")).toBe(0);
    expect(normalizeCompressKeepRecent("16.8")).toBe(16);
    expect(normalizeCompressKeepRecent(12)).toBe(12);
    expect(normalizeCompressKeepRecent("", 8)).toBe(8);
  });
});

describe("压缩比例(滑杆取值)", () => {
  it("常量:20 起步 / 40 默认 / 65 告警线 / 100 上限", () => {
    expect(COMPRESS_RATIO_MIN).toBe(20);
    expect(COMPRESS_RATIO_DEFAULT).toBe(40);
    expect(COMPRESS_RATIO_WARN).toBe(65);
    expect(COMPRESS_RATIO_MAX).toBe(100);
  });

  it("归一化:非法输入回退默认 40,越界值夹到 [20, 100],小数取整", () => {
    expect(normalizeCompressRatio("")).toBe(40);
    expect(normalizeCompressRatio("abc")).toBe(40);
    expect(normalizeCompressRatio("19")).toBe(20);
    expect(normalizeCompressRatio("-5")).toBe(20);
    expect(normalizeCompressRatio("20")).toBe(20);
    expect(normalizeCompressRatio("40")).toBe(40);
    expect(normalizeCompressRatio("65")).toBe(65);
    expect(normalizeCompressRatio("100")).toBe(100);
    expect(normalizeCompressRatio("120")).toBe(100);
    expect(normalizeCompressRatio("64.9")).toBe(64);
    expect(normalizeCompressRatio(72)).toBe(72);
    expect(normalizeCompressRatio("", 55)).toBe(55);
  });

  it("比例 → targetTokens:摘要 = 上下文 × (1 − 比例),四舍五入", () => {
    expect(compressRatioToTargetTokens(20, 100_000)).toBe(80_000);
    expect(compressRatioToTargetTokens(40, 100_000)).toBe(60_000);
    expect(compressRatioToTargetTokens(65, 100_000)).toBe(35_000);
    expect(compressRatioToTargetTokens(100, 100_000)).toBe(256);
    expect(compressRatioToTargetTokens(40, 1001)).toBe(601);
    // 越界比例先归一化再换算:10 → 20%,120 → 100%。
    expect(compressRatioToTargetTokens(10, 100_000)).toBe(80_000);
    expect(compressRatioToTargetTokens(120, 100_000)).toBe(256);
    // 小上下文换算低于后端下限 → 抬到 256。
    expect(compressRatioToTargetTokens(20, 300)).toBe(256);
  });

  it("上下文未知 → null(调用方省略 targetTokens 走服务端默认)", () => {
    expect(compressRatioToTargetTokens(40, null)).toBeNull();
    expect(compressRatioToTargetTokens(40, undefined)).toBeNull();
    expect(compressRatioToTargetTokens(40, 0)).toBeNull();
    expect(compressRatioToTargetTokens(40, -100)).toBeNull();
    expect(compressRatioToTargetTokens(40, Number.NaN)).toBeNull();
  });
});

describe("S5/S6 块化记录的展示面(并列块 + 被吸收块不再画线)", () => {
  const message = (id: string) => ({ id }) as UIMessage;
  const node = (selectedId: string, ...otherIds: string[]): CompactionTimelineNode => ({
    messages: [selectedId, ...otherIds].map(message),
    selectedId,
  });
  const block = (
    cutMessageId: string,
    startMessageId: string,
    summary: string,
    extra: Record<string, unknown> = {},
  ) => ({ cutMessageId, startMessageId, summary, tokensBefore: 100, ...extra });

  it("解析新字段;active=false 的块直接过滤(记录仍在库里,只是不再是记忆边界)", () => {
    const parsed = parseCompactionRecords([
      block("m3", "m1", "块0", { id: "r0", tier: 1, active: true }),
      block("m6", "m3", "块1", { id: "r1", tier: 2, consumedRecordIds: ["r0", 7, ""] }),
      block("m9", "m6", "被吸收", { id: "r2", active: false }),
      block("m9", "m6", "坏字段", { tier: "2", id: "", startMessageId: "" }),
    ]);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({
      cutMessageId: "m3", startMessageId: "m1", summary: "块0", tokensBefore: 100, id: "r0", tier: 1,
    });
    expect(parsed[1]!.tier).toBe(2);
    expect(parsed[1]!.consumedRecordIds).toEqual(["r0"]);
    expect(parsed[2]!.tier).toBeUndefined();
    expect(parsed[2]!.id).toBeUndefined();
    expect(parsed[2]!.startMessageId).toBeUndefined();
  });

  it("并列块:按锚点顺序编号,层级/总数下发给折叠卡", () => {
    const nodes = [node("m1"), node("m2"), node("m3"), node("m4"), node("m5"), node("m6"), node("m7")];
    const raw = [
      block("m3", "m1", "块0摘要", { id: "r0" }),
      block("m6", "m3", "块1摘要", { id: "r1", tier: 2 }),
    ];
    const entries = compactionAnchorEntries(raw, nodes);
    expect(entries.map((entry) => entry.anchorId)).toEqual(["m2", "m5"]);
    expect(entries.map((entry) => entry.info.blockOrdinal)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.info.blockTotal)).toEqual([2, 2]);
    expect(entries.map((entry) => entry.info.tier)).toEqual([1, 2]);
    // Map 出口与数组出口同源:逐块详情弹窗按 anchorId 取到的就是同一份 info。
    const anchors = buildCompactionAnchors(raw, nodes);
    expect(anchors.get("m2")).toEqual(entries[0]!.info);
    expect(anchors.get("m5")).toEqual(entries[1]!.info);
    // 折叠范围仍取最后一块的切点(它之前的原文全部已被摘要覆盖)。
    const placement = latestCompactionPlacement(raw, nodes)!;
    expect(placement.anchorId).toBe("m5");
    expect(placement.cutNodeIndex).toBe(5);
  });

  it("S6 蒸馏后:被吸收块不画线不出卡,折叠范围与详情都落到上层块", () => {
    const nodes = [node("m1"), node("m2"), node("m3"), node("m4"), node("m5"), node("m6"), node("m7")];
    const raw = [
      block("m3", "m1", "块0", { id: "r0", active: false }),
      block("m6", "m3", "块1", { id: "r1", active: false }),
      block("m6", "m1", "上层摘要", { id: "r2", tier: 2, consumedRecordIds: ["r0", "r1"] }),
    ];
    const entries = compactionAnchorEntries(raw, nodes);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.anchorId).toBe("m5");
    expect(entries[0]!.info.record.summary).toBe("上层摘要");
    expect(entries[0]!.info.blockTotal).toBe(1);
    expect(buildCompactionAnchors(raw, nodes).has("m2")).toBe(false);
    expect(latestCompactionPlacement(raw, nodes)!.record.cutMessageId).toBe("m6");
  });

  it("v1 老记录:层级按 1、单块编号,展示面与引入前一致", () => {
    const nodes = [node("m1"), node("m2"), node("m3")];
    const entries = compactionAnchorEntries([{ cutMessageId: "m2", summary: "旧摘要", tokensBefore: 100 }], nodes);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.info.tier).toBe(1);
    expect(entries[0]!.info.blockOrdinal).toBe(1);
    expect(entries[0]!.info.blockTotal).toBe(1);
    expect(entries[0]!.info.previousSummaryTokens).toBe(0);
  });
});
