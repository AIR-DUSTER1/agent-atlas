/**
 * render/code-enhance.ts — 代码块工具栏与按需语法高亮
 * ============================================================
 * 只在消息结束流式输出后运行，避免每个 token 都重排代码 DOM。highlight.js
 * 按需动态加载；加载失败仍保留原始转义代码和复制按钮。
 */
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";
import { toast } from "../ui/toast.js";

type HighlightModule = typeof import("../vendor/highlight.js");
let highlightPromise: Promise<HighlightModule | null> | null = null;

function loadHighlight(): Promise<HighlightModule | null> {
  highlightPromise ??= import("../vendor/highlight.js")
    .then((mod) => {
      mod.default.configure({ ignoreUnescapedHTML: true });
      return mod;
    })
    .catch(() => null);
  return highlightPromise;
}

function languageOf(code: HTMLElement): string {
  const match = [...code.classList].map((name) => /^language-([\w-]+)$/.exec(name)?.[1]).find(Boolean);
  return match || "code";
}

async function copyCode(code: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(code.textContent || "");
    toast("代码已复制", "success", { durationMs: 2200 });
  } catch {
    toast("复制失败，请手动选择代码", "error");
  }
}

/** 给 root 内的 pre>code 添加工具栏、语言标签和可选高亮；同一代码块只处理一次。 */
export async function enhanceCodeBlocks(root: ParentNode): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code")]
    .filter((code) => !code.closest(".code-block"))
    .map((code) => code.parentElement)
    .filter((pre): pre is HTMLPreElement => pre instanceof HTMLPreElement);
  if (!blocks.length) return;

  const wrappers: Array<{ code: HTMLElement; language: string }> = [];
  for (const pre of blocks) {
    const code = pre.querySelector<HTMLElement>(":scope > code");
    if (!code) continue;
    const language = languageOf(code);
    const copyButton = h("button", {
      type: "button",
      class: "code-copy-btn",
      title: "复制代码",
      "aria-label": `复制 ${language} 代码`,
      onclick: () => void copyCode(code),
    }, icon("Copy", { size: 12 }), h("span", null, "复制"));
    const wrapper = h("div", { class: "code-block" },
      h("div", { class: "code-block-head" },
        h("span", { class: "code-language" }, language),
        copyButton,
      ),
    );
    pre.replaceWith(wrapper);
    wrapper.appendChild(pre);
    wrappers.push({ code, language });
  }

  const mod = await loadHighlight();
  if (!mod) return;
  for (const item of wrappers) {
    try {
      item.code.classList.add(`language-${item.language}`);
      mod.default.highlightElement(item.code);
    } catch {
      // 未注册语言/异常输入保持原始代码
    }
  }
}
