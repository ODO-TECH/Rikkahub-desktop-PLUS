// backup/memory-file-format.test.ts — 上游 Markdown 记忆(memory_file)双向格式契约
//
// 锁定:PC→安卓写 /profile.md 的格式(frontmatter + `- [stated] …`)能被读端还原成同样的
// 逐条记忆;frontmatter 不进入记忆正文;无 bullet 的文档整篇作为一条。

import { describe, expect, test } from "bun:test";
import { memoryProfileMarkdown } from "./export";
import { parseMemoryProfileMarkdown } from "./import";

describe("Markdown 记忆格式(Room 28+ memory_file)", () => {
  test("导出 → 解析 往返得到同一组条目(换行折叠、顺序保持)", () => {
    const contents = ["用户喜欢吃辣", "住在杭州\n周末常去西湖", "正在准备考试"];
    const markdown = memoryProfileMarkdown(contents);
    expect(markdown).toContain("---\nname: profile\ndescription: Who the user is\n---");
    expect(markdown).toContain("- [stated] 用户喜欢吃辣");
    expect(markdown).toContain("- [stated] 住在杭州 周末常去西湖");
    expect(parseMemoryProfileMarkdown(markdown)).toEqual([
      "用户喜欢吃辣",
      "住在杭州 周末常去西湖",
      "正在准备考试",
    ]);
  });

  test("空条目被跳过;空列表只产出 frontmatter", () => {
    const markdown = memoryProfileMarkdown(["", "  ", "有效"]);
    expect(parseMemoryProfileMarkdown(markdown)).toEqual(["有效"]);
    expect(parseMemoryProfileMarkdown(memoryProfileMarkdown([]))).toEqual([]);
  });

  test("兼容无 frontmatter / 无 tag 的手写文档", () => {
    expect(parseMemoryProfileMarkdown("- 第一条\n- 第二条")).toEqual(["第一条", "第二条"]);
    expect(parseMemoryProfileMarkdown("一篇没有列表的记忆正文")).toEqual(["一篇没有列表的记忆正文"]);
  });
});
