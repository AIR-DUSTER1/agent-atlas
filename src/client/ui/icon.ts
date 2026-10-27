/**
 * ui/icon.ts — Lucide 图标占位与异步水合
 * ============================================================
 * 图标是可选增强：先输出稳定的 data-icon 占位，再按需加载 vendor/icons。
 * 加载失败只保留占位，不阻断页面初始化，也不会把第三方库塞进入口闭包。
 */
import { h } from "./h.js";

export type IconName = keyof typeof import("../vendor/icons.js");
export interface IconOptions {
  size?: number;
  strokeWidth?: number;
  label?: string;
  className?: string;
}

let iconModulePromise: Promise<typeof import("../vendor/icons.js")> | null = null;
let observerInstalled = false;

function loadIcons(): Promise<typeof import("../vendor/icons.js")> {
  iconModulePromise ??= import("../vendor/icons.js").catch((err) => {
    iconModulePromise = null;
    throw err;
  });
  return iconModulePromise;
}

type IconNode = ReadonlyArray<readonly [string, Readonly<Record<string, string | number>>]>;

function renderSvg(nodes: IconNode, options: IconOptions): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(options.size ?? 16));
  svg.setAttribute("height", String(options.size ?? 16));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(options.strokeWidth ?? 1.8));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of nodes) {
    const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attrs)) child.setAttribute(name, String(value));
    svg.appendChild(child);
  }
  return svg;
}

function installObserver(): void {
  if (observerInstalled || typeof MutationObserver === "undefined") return;
  observerInstalled = true;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) void hydrateIcons(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/** 安装全局新增节点监听，并水合页面里静态写好的 data-icon 占位。 */
export function initIconHydration(root: ParentNode = document): void {
  installObserver();
  void hydrateIcons(root);
}
/** 创建图标占位；实际 SVG 在空闲时异步水合。 */
export function icon(name: IconName, options: IconOptions = {}): HTMLSpanElement {
  const host = h("span", {
    class: ["ui-icon", options.className].filter(Boolean).join(" "),
    dataset: { icon: name },
    style: {
      "--icon-size": `${options.size ?? 16}px`,
      "--icon-stroke": String(options.strokeWidth ?? 1.8),
    },
    role: options.label ? "img" : undefined,
    "aria-label": options.label,
    "aria-hidden": options.label ? undefined : "true",
  });
  installObserver();
  void hydrateIcons(host);
  return host;
}

/** 将 root 内未水合的图标替换为 SVG；失败时不抛到调用方。 */
export async function hydrateIcons(root: ParentNode = document): Promise<void> {
  const hosts = root.querySelectorAll<HTMLElement>("[data-icon]:not([data-icon-ready])");
  if (!hosts.length) return;
  let mod: typeof import("../vendor/icons.js");
  try {
    mod = await loadIcons();
  } catch {
    for (const host of hosts) host.dataset.iconError = "1";
    return;
  }
  for (const host of hosts) {
    const name = host.dataset.icon as IconName;
    const nodes = mod[name] as unknown as IconNode | undefined;
    if (!Array.isArray(nodes)) {
      host.dataset.iconError = "1";
      continue;
    }
    host.replaceChildren(renderSvg(nodes, {
      size: Number.parseFloat(host.style.getPropertyValue("--icon-size")) || 16,
      strokeWidth: Number.parseFloat(host.style.getPropertyValue("--icon-stroke")) || 1.8,
    }));
    host.dataset.iconReady = "1";
  }
}
