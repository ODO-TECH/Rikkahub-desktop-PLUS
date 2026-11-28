/** 由 vendor-mermaid.ts 从 node_modules 搬进 public/mermaid,构建后由后端同源提供。 */
const MERMAID_LOCAL_PATH = "/mermaid/mermaid.min.js";

function mermaidLocalSrc(): string {
  // srcdoc iframe 是不透明源且没有 base URL,相对路径解析不出来,只能给绝对地址。
  // 拿不到 origin(非浏览器环境)时退化成相对路径,加载失败自然走 CDN 回退。
  if (typeof window === "undefined") return MERMAID_LOCAL_PATH;
  try {
    return new URL(MERMAID_LOCAL_PATH, window.location.href).href;
  } catch {
    return MERMAID_LOCAL_PATH;
  }
}

export function buildMermaidPreviewDocument(code: string): string {
  const encodedCode = encodeURIComponent(code);
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      html, body { margin: 0; padding: 0; background: #ffffff; color: #1f2937; font-family: ui-sans-serif, system-ui, sans-serif; }
      #container { min-height: 100vh; box-sizing: border-box; padding: 16px; display: flex; justify-content: center; }
      #diagram { width: 100%; }
      #error { display: none; width: 100%; white-space: pre-wrap; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; font-size: 12px; }
    </style>
  </head>
  <body>
    <div id="container">
      <div id="diagram"></div>
      <pre id="error"></pre>
    </div>
    <script src="${mermaidLocalSrc()}"></script>
    <script>
      (() => {
        const source = decodeURIComponent("${encodedCode}");
        const diagram = document.getElementById("diagram");
        const errorEl = document.getElementById("error");

        const show = (message) => {
          if (!errorEl) return;
          errorEl.style.display = "block";
          errorEl.textContent = message instanceof Error ? message.message : String(message);
        };

        const render = (mermaid) => {
          mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
          return mermaid
            .render("mermaid-" + Math.random().toString(36).slice(2), source.trim())
            .then((result) => {
              if (diagram) diagram.innerHTML = result.svg;
            });
        };

        // 经典脚本按文档顺序执行,所以本地这份在上面的内联脚本之前已经挂好 globalThis.mermaid。
        if (window.mermaid) {
          render(window.mermaid).catch(show);
          return;
        }
        // 本地资源没到位(旧便携目录只换了前端、没带 mermaid)时才回退公网 CDN。
        import("https://esm.sh/mermaid@11")
          .then((module) => render(module.default))
          .catch(() => show("没找到 mermaid:本地 ${MERMAID_LOCAL_PATH} 与 CDN 都没取到。重新执行 web-ui 的 bun run build 并完整部署前端产物。"));
      })();
    </script>
  </body>
</html>`;
}
