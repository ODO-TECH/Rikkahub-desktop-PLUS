// media/yukkuri/readable.ts — 从助手回复里挑出「能念的」自然语言
// 移植自 reference/dsh-yukkuli 的 text/extract.js(那边还要处理 content blocks 数组,
// RDP 的 TTS 入口进来的已经是纯文本,所以只保留 Markdown 清理这一半)。
// 纪律:代码块、表格、链接、路径念出来全是噪音 —— 宁可少念,不要念一串「反引号 斜杠 冒号」。
// 但句号、逗号必须留下:分段就是按它们切的,把它们当装饰符号删掉会把整轮朗读捏成一段。

function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

function stripInlineCode(text: string): string {
  // `code` → code:短片段去掉反引号,内容留着,念出来还听得懂
  return text.replace(/`([^`]*)`/g, "$1");
}

function stripTables(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^\|.*\|$/.test(t)) return false;
      if (/^\s*[-:|\s]+$/.test(t) && t.includes("|")) return false;
      return true;
    })
    .join("\n");
}

function stripLinks(text: string): string {
  return text.replace(/\[([^\]]*)]\([^)]*\)/g, "$1");
}

function stripBareUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "");
}

function stripPaths(text: string): string {
  // Windows 盘符、UNC、类 Unix 绝对路径(至少两级,避免误伤 a/b 这种)
  return text
    .replace(/[A-Za-z]:\\[^\s，。、]+/g, "")
    .replace(/\\\\[\w.$-]+\\[^\s，。、]+/g, "")
    .replace(/(?:^|\s)\/[\w.-]+\/[^\s，。、]*/g, " ");
}

function stripMarkup(text: string): string {
  return text
    .replace(/^ {0,3}#{1,6}\s+/gm, "") // 标题
    .replace(/^ {0,3}> ?/gm, "") // 引用
    .replace(/^ {0,3}(?:[-*+]|\d+\.)\s+/gm, "") // 列表符号
    .replace(/^ {0,3}(?:[-*_] *){3,}$/gm, "") // 分隔线
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1");
}

/**
 * 删掉「符号画的东西」:箭头、制表符风格的方块、带圈数字、装饰图形、emoji。
 *
 * 范围刻意不碰 U+3000–U+303F(CJK 标点):。、!? 这些是分段依据,删了就等于把一整轮
 * 朗读捏成一段超长文本,引擎随即回 ERR 120/122 —— 这个坑是移植时实测出来的。
 */
function stripEmoji(text: string): string {
  return text
    .replace(/[←-⇿⌀-⏿①-⓿■-➿]/g, "")
    .replace(/[️⃣]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/[\u{1F000}-\u{1F2FF}]/gu, "");
}

function tidy(text: string): string {
  return text
    .replace(/　/g, " ") // 全角空格转半角
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** 没有可念的内容时返回空串(调用方据此什么都不播,而不是播一段静音)。 */
export function extractReadableText(input: string | null | undefined): string {
  if (!input) return "";
  const raw = typeof input === "string" ? input : String(input);
  if (!raw.trim()) return "";

  let text = raw;
  text = stripCodeFences(text);
  text = stripTables(text);
  text = stripInlineCode(text);
  text = stripLinks(text);
  text = stripBareUrls(text);
  text = stripPaths(text);
  text = stripMarkup(text);
  text = stripEmoji(text);
  return tidy(text);
}
