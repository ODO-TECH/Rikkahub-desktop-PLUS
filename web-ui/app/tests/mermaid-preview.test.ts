// mermaid 预览文档契约:先走同源经典脚本,本地缺失才回退 CDN;图源按 URI 编码进 srcdoc。
// 背景:离线/内网下 esm.sh 拉不到时,代码块不能只剩源码(PR #2 现场问题)。
import { describe, expect, test } from "bun:test";

import { buildMermaidPreviewDocument } from "~/components/markdown/mermaid-preview";

describe("buildMermaidPreviewDocument", () => {
  test("先加载同源经典脚本,不再以 esm.sh 模块导入开场", () => {
    const doc = buildMermaidPreviewDocument("graph TD;A-->B");
    // Bun 测试环境没有 window,本地地址退化成站点根相对路径。
    expect(doc).toContain('<script src="/mermaid/mermaid.min.js"></script>');
    expect(doc).not.toContain('<script type="module">');
    // 同源脚本必须先于 CDN 回退出现,否则 window.mermaid 还来不及挂上。
    expect(doc.indexOf("mermaid.min.js")).toBeLessThan(
      doc.indexOf('import("https://esm.sh/mermaid@11")'),
    );
  });

  test("本地没挂上 window.mermaid 才回退 CDN,双失败给出可操作提示", () => {
    const doc = buildMermaidPreviewDocument("graph TD;A-->B");
    expect(doc).toContain("if (window.mermaid)");
    expect(doc).toContain('import("https://esm.sh/mermaid@11")');
    expect(doc).toContain("本地 /mermaid/mermaid.min.js 与 CDN 都没取到");
  });

  test("图源按 URI 编码写入 srcdoc,引号/中文/换行不破坏文档", () => {
    const source = 'graph TD\nA["甲"]-->B';
    const doc = buildMermaidPreviewDocument(source);
    expect(doc).toContain(encodeURIComponent(source));
    expect(doc).toContain('decodeURIComponent("');
  });
});
