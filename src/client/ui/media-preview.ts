/**
 * ============================================================
 * ui/media-preview.ts — 图片 / 地图通用放大预览
 * ============================================================
 * 职责：提供不带 iframe 的媒体预览弹层，支持按钮、滚轮和键盘缩放，
 * 指针拖动平移，并保持焦点陷阱、Esc 关闭与触发元素焦点恢复。
 * 设计立场：只接收已经由业务层安全构造的 DOM，不拼 HTML，不替代业务渲染。
 */
import { h } from "./dom.js";
import { icon } from "./icon.js";

export type MediaPreviewKind = "image" | "map";

export interface MediaPreviewOptions {
  title: string;
  description?: string;
  kind: MediaPreviewKind;
  createContent: () => HTMLElement;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.25;
const PAN_STEP = 28;

interface PreviewElements {
  overlay: HTMLDivElement;
  dialog: HTMLDivElement;
  title: HTMLHeadingElement;
  description: HTMLParagraphElement;
  stage: HTMLDivElement;
  surface: HTMLDivElement;
  zoomValue: HTMLSpanElement;
  zoomOut: HTMLButtonElement;
  zoomIn: HTMLButtonElement;
  reset: HTMLButtonElement;
  close: HTMLButtonElement;
}

interface PreviewState {
  open: boolean;
  scale: number;
  x: number;
  y: number;
  pointerId: number | null;
  dragStartX: number;
  dragStartY: number;
  panStartX: number;
  panStartY: number;
  previousFocus: HTMLElement | null;
  previousOverflow: string;
  pageInert: boolean;
}

const state: PreviewState = {
  open: false,
  scale: 1,
  x: 0,
  y: 0,
  pointerId: null,
  dragStartX: 0,
  dragStartY: 0,
  panStartX: 0,
  panStartY: 0,
  previousFocus: null,
  previousOverflow: "",
  pageInert: false,
};

let elements: PreviewElements | null = null;

const FOCUSABLE = "button:not([disabled]), [tabindex='0']";

function setPageInert(value: boolean): void {
  const app = document.getElementById("app");
  if (!app) return;
  if (value) {
    state.pageInert = true;
    app.setAttribute("aria-hidden", "true");
    if ("inert" in HTMLElement.prototype) app.setAttribute("inert", "");
  } else if (state.pageInert) {
    state.pageInert = false;
    app.removeAttribute("inert");
    app.removeAttribute("aria-hidden");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function trapTab(event: KeyboardEvent): void {
  if (event.key !== "Tab" || !elements) return;
  const items = [...elements.dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((item) => !item.hidden && item.getAttribute("aria-hidden") !== "true");
  if (!items.length) {
    elements.dialog.focus();
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    last.focus();
    event.preventDefault();
  } else if (!event.shiftKey && document.activeElement === last) {
    first.focus();
    event.preventDefault();
  }
}

function renderTransform(): void {
  if (!elements) return;
  elements.surface.style.transform = `translate3d(${state.x}px, ${state.y}px, 0) scale(${state.scale})`;
}

function renderScale(): void {
  if (!elements) return;
  const percent = Math.round(state.scale * 100);
  elements.zoomValue.textContent = `${percent}%`;
  elements.zoomOut.disabled = state.scale <= MIN_SCALE;
  elements.zoomIn.disabled = state.scale >= MAX_SCALE;
  renderTransform();
}

function setScale(value: number): void {
  state.scale = clamp(Math.round(value * 100) / 100, MIN_SCALE, MAX_SCALE);
  renderScale();
}

function zoomBy(delta: number): void {
  setScale(state.scale + delta);
}

function panBy(deltaX: number, deltaY: number): void {
  state.x += deltaX;
  state.y += deltaY;
  renderTransform();
}

function resetView(): void {
  state.scale = 1;
  state.x = 0;
  state.y = 0;
  renderScale();
}

function closePreview(): void {
  if (!state.open || !elements) return;
  const previous = state.previousFocus;
  elements.overlay.classList.add("hidden");
  elements.surface.replaceChildren();
  elements.description.classList.add("hidden");
  state.open = false;
  state.pointerId = null;
  state.previousFocus = null;
  elements.stage.classList.remove("is-panning");
  document.body.style.overflow = state.previousOverflow;
  state.previousOverflow = "";
  setPageInert(false);
  if (previous?.isConnected) previous.focus();
}

function buildPreview(): PreviewElements {
  const title = h("h2", { id: "media-preview-title" }, "媒体预览");
  const description = h("p", { id: "media-preview-description", class: "media-preview-description hidden" });
  const zoomOut = h("button", {
    id: "media-preview-zoom-out",
    type: "button",
    class: "media-preview-control",
    title: "缩小",
    "aria-label": "缩小预览",
  }, "−");
  const zoomValue = h("span", { id: "media-preview-zoom-value", class: "media-preview-zoom-value", role: "status", "aria-live": "polite" }, "100%");
  const zoomIn = h("button", {
    id: "media-preview-zoom-in",
    type: "button",
    class: "media-preview-control",
    title: "放大",
    "aria-label": "放大预览",
  }, "+");
  const reset = h("button", {
    id: "media-preview-reset",
    type: "button",
    class: "media-preview-reset",
    title: "恢复 100% 并居中",
    "aria-label": "恢复 100% 并居中",
  }, "1:1");
  const close = h("button", {
    id: "media-preview-close",
    type: "button",
    class: "media-preview-close",
    title: "关闭预览（Esc）",
    "aria-label": "关闭预览",
  }, icon("X", { size: 18 }));

  const toolbar = h("div", { class: "media-preview-toolbar", role: "toolbar", "aria-label": "预览缩放控制" },
    zoomOut,
    zoomValue,
    zoomIn,
    reset,
  );
  const head = h("div", { class: "media-preview-head" },
    h("div", { class: "media-preview-heading" }, title, description, toolbar),
    close,
  );
  const stage = h("div", {
    id: "media-preview-stage",
    class: "media-preview-stage",
    tabindex: "0",
    role: "region",
    "aria-label": "可缩放预览区域，使用加减按钮、滚轮或键盘缩放，按住拖动平移",
  });
  const surface = h("div", { id: "media-preview-surface", class: "media-preview-surface" });
  stage.appendChild(surface);
  const hint = h("div", { id: "media-preview-hint", class: "media-preview-hint" },
    "点击 + / − 或滚动鼠标滚轮缩放",
    h("span", { "aria-hidden": "true" }, " · "),
    "按住拖动平移",
    h("span", { "aria-hidden": "true" }, " · "),
    "双击在 100% / 200% 间切换",
  );
  const dialog = h("div", {
    id: "media-preview",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "media-preview-title",
    "aria-describedby": "media-preview-hint",
    tabindex: "-1",
  }, head, stage, hint);
  const overlay = h("div", { id: "media-preview-mask", class: "hidden", role: "presentation" }, dialog);
  document.body.appendChild(overlay);

  close.addEventListener("click", closePreview);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) closePreview(); });
  zoomOut.addEventListener("click", () => zoomBy(-ZOOM_STEP));
  zoomIn.addEventListener("click", () => zoomBy(ZOOM_STEP));
  reset.addEventListener("click", resetView);
  overlay.addEventListener("keydown", (event) => {
    trapTab(event);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePreview();
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "+" || event.key === "=")) {
      event.preventDefault();
      zoomBy(ZOOM_STEP);
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "-" || event.key === "_")) {
      event.preventDefault();
      zoomBy(-ZOOM_STEP);
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "0") {
      event.preventDefault();
      resetView();
    }
  });
  stage.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      panBy(-PAN_STEP, 0);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      panBy(PAN_STEP, 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      panBy(0, -PAN_STEP);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      panBy(0, PAN_STEP);
    }
  });
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }, { passive: false });
  stage.addEventListener("dblclick", () => setScale(state.scale > 1 ? 1 : 2));
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    state.pointerId = event.pointerId;
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.panStartX = state.x;
    state.panStartY = state.y;
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-panning");
    event.preventDefault();
  });
  stage.addEventListener("pointermove", (event) => {
    if (state.pointerId !== event.pointerId) return;
    state.x = state.panStartX + event.clientX - state.dragStartX;
    state.y = state.panStartY + event.clientY - state.dragStartY;
    renderTransform();
  });
  const endDrag = (event: PointerEvent): void => {
    if (state.pointerId !== event.pointerId) return;
    state.pointerId = null;
    stage.classList.remove("is-panning");
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  const built: PreviewElements = {
    overlay, dialog, title, description, stage, surface, zoomValue, zoomOut, zoomIn, reset, close,
  };
  return built;
}

function ensurePreview(): PreviewElements {
  elements ??= buildPreview();
  return elements;
}

/** 打开预览；每次打开都重新创建内容，避免把上一套房源的地图或图片留在弹层里。 */
export function openMediaPreview(options: MediaPreviewOptions): void {
  const view = ensurePreview();
  const content = options.createContent();
  view.title.textContent = options.title;
  view.description.textContent = options.description || "";
  view.description.classList.toggle("hidden", !options.description);
  view.surface.dataset.kind = options.kind;
  view.surface.replaceChildren(content);
  state.open = true;
  state.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.previousOverflow = document.body.style.overflow;
  resetView();
  view.overlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  setPageInert(true);
  requestAnimationFrame(() => { if (state.open) view.close.focus(); });
}

export function closeMediaPreview(): void {
  closePreview();
}

export function isMediaPreviewOpen(): boolean {
  return state.open;
}
