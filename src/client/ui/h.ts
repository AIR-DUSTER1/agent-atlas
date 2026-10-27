/**
 * ui/h.ts — 原生 DOM hyperscript
 * ============================================================
 * 用 textContent 语义生成节点，彻底拒绝 html/innerHTML 字符串。事件只接受函数，
 * URL 属性统一过 safe-url；这是新 UI 代码的默认构建方式。
 */
import { safeHref, safeImageSrc } from "./safe-url.js";

export type Child = Node | string | number | null | undefined | false;
export type StyleValue = string | number | null | undefined;
export interface Props {
  class?: string;
  className?: string;
  dataset?: Record<string, string | number | boolean | null | undefined>;
  style?: Record<string, StyleValue>;
  [key: string]: unknown;
}

const FORBIDDEN_PROPS = new Set(["innerHTML", "outerHTML", "dangerouslySetInnerHTML"]);
const URL_ATTRS = new Set(["href", "src", "xlink:href"]);

function appendChild(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (typeof child === "string" || typeof child === "number") {
    parent.appendChild(document.createTextNode(String(child)));
    return;
  }
  parent.appendChild(child);
}

function applyProps(el: HTMLElement | SVGElement, props: Props): void {
  for (const [key, raw] of Object.entries(props)) {
    if (raw === null || raw === undefined || raw === false) continue;
    if (FORBIDDEN_PROPS.has(key)) throw new Error(`h() 禁止使用 ${key}，请用文本或受控 Markdown 边界`);
    if (key === "class" || key === "className") {
      el.setAttribute("class", String(raw));
      continue;
    }
    if (key === "dataset") {
      for (const [name, value] of Object.entries(raw as NonNullable<Props["dataset"]>)) {
        if (value === null || value === undefined) continue;
        el.dataset[name] = String(value);
      }
      continue;
    }
    if (key === "style") {
      for (const [name, value] of Object.entries(raw as NonNullable<Props["style"]>)) {
        if (value === null || value === undefined) continue;
        if (el instanceof HTMLElement) {
          const cssName = name.startsWith("--") ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
          el.style.setProperty(cssName, String(value));
        }
      }
      continue;
    }
    if (/^on[a-z]/i.test(key)) {
      if (typeof raw !== "function") throw new Error(`事件 ${key} 必须绑定函数，禁止字符串处理器`);
      el.addEventListener(key.slice(2).toLowerCase(), raw as EventListener);
      continue;
    }
    if (URL_ATTRS.has(key)) {
      const safe = key === "src" || (key === "href" && el instanceof HTMLImageElement)
        ? safeImageSrc(String(raw))
        : safeHref(String(raw));
      if (safe) el.setAttribute(key, safe);
      else el.setAttribute("data-invalid-url", key);
      continue;
    }
    if (raw === true) {
      el.setAttribute(key, "");
      continue;
    }
    el.setAttribute(key, String(raw));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  for (const child of children) appendChild(el, child);
  return el;
}

/** SVG 专用入口：标签名来自固定图标节点，不接受用户输入。 */
export function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: Node[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  for (const child of children) el.appendChild(child);
  return el;
}
