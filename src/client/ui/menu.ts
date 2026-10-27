/**
 * ui/menu.ts — 浮动菜单定位、键盘导航与焦点恢复
 * ============================================================
 * 统一替代各业务自己实现的「absolute + 点外面关闭」。菜单打开后挂到 body 做
 * fixed 定位，避免被 overflow:hidden 裁切；只允许一个活动菜单。
 */
import { h, type Child } from "./h.js";

export interface OpenMenuOptions {
  anchor: HTMLElement;
  menu: HTMLElement;
  align?: "start" | "end";
  offset?: number;
  onClose?: () => void;
  focusFirst?: boolean;
  matchAnchorWidth?: boolean;
}

export interface MenuController {
  close: (returnFocus?: boolean) => void;
  reposition: () => void;
  readonly isOpen: boolean;
}

let active: { controller: MenuController; anchor: HTMLElement; menu: HTMLElement; parent: Node | null; next: Node | null } | null = null;

function items(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled]), button:not([disabled])")]
    .filter((el) => !el.hidden);
}

function place(anchor: HTMLElement, menu: HTMLElement, align: "start" | "end", offset: number, matchAnchorWidth = false): void {
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = align === "end" ? rect.right - width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.bottom + offset;
  if (top + height > window.innerHeight - 8 && rect.top - height - offset >= 8) {
    top = rect.top - height - offset;
  }
  if (matchAnchorWidth) menu.style.minWidth = `${Math.round(rect.width)}px`;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(8, top))}px`;
}

export function openFloatingMenu(options: OpenMenuOptions): MenuController {
  active?.controller.close(false);
  const { anchor, menu } = options;
  const parent = menu.parentNode;
  const next = menu.nextSibling;
  const close = (returnFocus = false): void => controller.close(returnFocus);
  const onDocumentPointer = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (!target || menu.contains(target) || anchor.contains(target)) return;
    close(false);
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const list = items(menu);
    if (!list.length) return;
    event.preventDefault();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? list.length - 1
      : event.key === "ArrowUp" ? (index <= 0 ? list.length - 1 : index - 1)
      : (index + 1) % list.length;
    list[nextIndex]?.focus();
  };
  const onViewport = (): void => place(anchor, menu, options.align ?? "start", options.offset ?? 4, options.matchAnchorWidth);

  const controller: MenuController = {
    close(returnFocus = true): void {
      if (active?.controller !== controller) return;
      menu.classList.add("hidden");
      menu.removeAttribute("data-open");
      if (parent) parent.insertBefore(menu, next);
      active = null;
      document.removeEventListener("pointerdown", onDocumentPointer, true);
      document.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
      options.onClose?.();
      if (returnFocus) anchor.focus();
    },
    reposition(): void { place(anchor, menu, options.align ?? "start", options.offset ?? 4, options.matchAnchorWidth); },
    get isOpen(): boolean { return active?.controller === controller; },
  };

  active = { controller, anchor, menu, parent, next };
  document.body.appendChild(menu);
  menu.classList.remove("hidden");
  menu.dataset.open = "true";
  menu.style.position = "fixed";
  menu.style.zIndex = "9000";
  menu.style.right = "auto";
  menu.style.bottom = "auto";
  place(anchor, menu, options.align ?? "start", options.offset ?? 4, options.matchAnchorWidth);
  document.addEventListener("pointerdown", onDocumentPointer, true);
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onViewport, true);
  if (options.focusFirst !== false) requestAnimationFrame(() => items(menu)[0]?.focus());
  return controller;
}

export function closeFloatingMenu(returnFocus = false): void {
  active?.controller.close(returnFocus);
}

export function menuItem(label: string, onClick: () => void, options: { disabled?: boolean; className?: string } = {}): HTMLButtonElement {
  return h("button", {
    type: "button",
    role: "menuitem",
    class: ["ui-menu-item", options.className].filter(Boolean).join(" "),
    disabled: options.disabled,
    onclick: onClick,
  }, label);
}

export function menuSeparator(): HTMLElement {
  return h("div", { class: "ui-menu-separator", role: "separator" });
}

export function createMenu(children: Child[], label = "菜单"): HTMLElement {
  return h("div", {
    class: "ui-menu hidden",
    role: "menu",
    "aria-label": label,
  }, ...children);
}
