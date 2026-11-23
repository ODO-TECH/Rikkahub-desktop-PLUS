import { Archive, ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import type { CompactionAnchorInfo } from "~/lib/compaction";

/** 时间线上的压缩结果卡(替代只有一行字的分割线)。
 *  默认折叠切点之前的原文,把"模型现在实际拿到的摘要"直接摊在时间线上——
 *  用户不用点开弹窗才能看到压缩成果。展开原文不丢数据:原文仍在本会话与搜索索引里。
 *
 *  S5 块化:折叠区可能覆盖**多个并列生效块**(每块只摘要自己那段原文)。这时必须把
 *  所有块都摊出来——只显示末块会让用户以为早期摘要丢了,而模型其实全都拿着。
 *  单块(含全部 v1 老会话)走原渲染,DOM 逐字节不变。 */
export function CompactionSummaryCard({
  info,
  collapsed,
  hiddenCount,
  candidateCount = 0,
  blocks,
  onToggle,
  onOpen,
  onOpenBlock,
  onOpenCandidates,
}: {
  info: CompactionAnchorInfo;
  collapsed: boolean;
  hiddenCount: number;
  /** 实验开启时由调用方查询:本次压缩落进「待确认」的记忆候选数。0 不占位。 */
  candidateCount?: number;
  /** 折叠区覆盖的全部生效块(按锚点顺序)。缺省或只有 1 块 → 单块渲染。 */
  blocks?: Array<{ anchorId: string; info: CompactionAnchorInfo }>;
  onToggle: () => void;
  onOpen: () => void;
  /** 多块模式下逐块打开详情;未提供时回落到 onOpen。 */
  onOpenBlock?: (anchorId: string) => void;
  onOpenCandidates?: () => void;
}) {
  const { t } = useTranslation("page");
  const multi = blocks != null && blocks.length > 1;
  const shown = multi ? blocks! : [{ anchorId: "", info }];
  const beforeTokens = shown.reduce((sum, entry) => sum + entry.info.record.tokensBefore, 0);
  const afterTokens = shown.reduce((sum, entry) => sum + entry.info.summaryTokens, 0);
  return (
    <div className="my-1 rounded-xl border border-border/60 bg-[var(--ds-surface-100)] px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground/85">
          <Archive aria-hidden="true" className="size-3.5 text-muted-foreground" />
          {t("conversations.compaction_card.title", { count: hiddenCount })}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground tabular-nums">
          {t("conversations.compaction_card.size", {
            before: compactTokens(beforeTokens),
            after: compactTokens(afterTokens),
          })}
        </span>
        {candidateCount > 0 && onOpenCandidates ? (
          <button
            type="button"
            className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-micro text-primary transition-colors hover:bg-primary/15"
            onClick={onOpenCandidates}
          >
            {t("conversations.compaction_card.candidates", { count: candidateCount })}
          </button>
        ) : null}
        <span className="flex-1" />
        <Button
          aria-expanded={!collapsed}
          className="h-7 gap-1 px-2 text-xs"
          onClick={onToggle}
          size="sm"
          type="button"
          variant="ghost"
        >
          {collapsed ? (
            <ChevronDown aria-hidden="true" className="size-3.5" />
          ) : (
            <ChevronUp aria-hidden="true" className="size-3.5" />
          )}
          {t(
            collapsed
              ? "conversations.compaction_card.expand"
              : "conversations.compaction_card.collapse",
          )}
        </Button>
      </div>

      {multi ? (
        <div className="mt-2 flex flex-col gap-2.5">
          {shown.map((entry) => (
            <div
              className="border-l-2 border-border/70 pl-2.5"
              key={entry.info.record.id ?? entry.info.record.cutMessageId}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-micro font-medium text-muted-foreground tabular-nums">
                  {t("conversations.compaction_card.segment", {
                    index: entry.info.blockOrdinal,
                    total: entry.info.blockTotal,
                  })}
                </span>
                {entry.info.tier > 1 ? (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
                    {t("conversations.compaction_card.tier", { tier: entry.info.tier })}
                  </span>
                ) : null}
                <span className="text-micro text-muted-foreground tabular-nums">
                  {t("conversations.compaction_card.size", {
                    before: compactTokens(entry.info.record.tokensBefore),
                    after: compactTokens(entry.info.summaryTokens),
                  })}
                </span>
                <span className="flex-1" />
                <Button
                  className="h-auto p-0 text-xs"
                  onClick={() => (onOpenBlock ? onOpenBlock(entry.anchorId) : onOpen())}
                  size="sm"
                  type="button"
                  variant="link"
                >
                  {t("conversations.compaction_card.detail")}
                </Button>
              </div>
              <p className="mt-1 line-clamp-4 text-sm leading-6 whitespace-pre-wrap break-words text-foreground/85">
                {entry.info.record.summary}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 line-clamp-4 text-sm leading-6 whitespace-pre-wrap break-words text-foreground/85">
          {info.record.summary}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-micro text-muted-foreground">
          {t("conversations.compaction_card.note")}
        </span>
        {multi ? null : (
          <Button
            className="h-auto p-0 text-xs"
            onClick={onOpen}
            size="sm"
            type="button"
            variant="link"
          >
            {t("conversations.compaction_card.detail")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** token 简写,与聊天消息悬停卡、压缩详情卡同一口径。 */
function compactTokens(value: number): string {
  const trim = (text: string) => text.replace(/\.0$/, "");
  if (value >= 1_000_000) return `${trim((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1000) return `${trim((value / 1000).toFixed(1))}k`;
  return String(value);
}