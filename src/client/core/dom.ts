/**
 * ============================================================
 * core/dom.ts — DOM 快捷访问与主题 / 侧栏开关
 * ============================================================
 * 职责：把「按 id 取元素」和几个最基础的界面开关收在一处，供各渲染模块复用。
 * 设计立场：
 *  - $ 返回 HTMLElement | null，调用方必须自己判空（静态骨架变了要显式降级，
 *    不能靠 as 硬转掩耳盗铃）；
 *  - 高频元素（输入框 / 消息流）在这里一次性取好，避免每次渲染重复查询；
 *  - 主题与侧栏属于「全局开关」，不属于任何业务视图，单独放这一层。
 */

import { LS_THEME, state } from "./state.js";
import type { DesktopBridge } from "../modules/types.js";
import { icon } from "../ui/icon.js";

export const $ = (id: string): HTMLElement | null => document.getElementById(id);

/** 高频元素：init 之后一定存在（index.html 是静态骨架） */
export const chatScroll = $("chat-scroll") as HTMLElement;
export const messagesEl = $("messages") as HTMLElement;
export const welcomeEl = $("welcome") as HTMLElement;
export const inputEl = $("input") as HTMLTextAreaElement;
export const sendBtn = $("send-btn") as HTMLButtonElement;
export const stopBtn = $("stop-btn") as HTMLButtonElement;

/** Electron 桌面端桥（浏览器里为 undefined） */
export function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { desktop?: DesktopBridge }).desktop;
}

/* ---------------------------------------------------------------------------
 * 主题切换：深色（默认）/ 浅色。html[data-theme] 驱动 CSS 变量整体换肤；
 * localStorage 持久化，<head> 里的内联脚本在样式应用前恢复，避免闪白/闪黑。
 * ------------------------------------------------------------------------- */
export function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function updateThemeBtn(): void {
  const btn = $("theme-btn");
  if (!btn) return;
  const light = currentTheme() === "light";
  btn.replaceChildren(icon(light ? "Moon" : "Sun", { size: 16 }));
  btn.setAttribute("aria-label", light ? "切换到深色主题" : "切换到浅色主题");
  btn.title = light ? "切换到深色主题" : "切换到浅色主题";
  // Electron 桌面端：窗口控制键（右上角原生三按钮）颜色跟随应用主题；
  // 浏览器环境没有 window.desktop，静默跳过
  desktopBridge()?.setOverlayTheme?.(!light);
}

export function toggleTheme(): void {
  const next = currentTheme() === "light" ? "dark" : "light";
  if (next === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(LS_THEME, next); } catch { /* 隐私模式等 */ }
  updateThemeBtn();
  window.dispatchEvent(new CustomEvent("themechange", { detail: { theme: next } }));
}

/* ---------------------------------------------------------------------------
 * 窄屏抽屉式侧栏：☰ 开关 + 遮罩点击关闭；选中会话/项目后自动收起。
 * 桌面宽屏下侧栏常驻，open 类只在 ≤860px 媒体查询里有样式效果。
 * ------------------------------------------------------------------------- */
export function setSidebarOpen(open: boolean): void {
  const sb = $("sidebar");
  if (!sb) return;
  sb.classList.toggle("open", open);
  const scrim = $("sidebar-scrim");
  if (scrim) scrim.classList.toggle("hidden", !open);
}

/** 输入框自动增高（上限 160px）；发送按钮随内容点亮 */
export function autoGrowImpl(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  sendBtn.classList.toggle("is-ready", inputEl.value.trim().length > 0);
}

/** 滚动：只有当用户本来就在底部附近时才跟随新内容（避免打断向上翻历史） */
export function nearBottom(): boolean {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 110;
}

export function scrollBottom(force = false): void {
  if (force || nearBottom()) chatScroll.scrollTop = chatScroll.scrollHeight;
}

/** 当前会话是否有 pending 附件等只读判定用 */
export function hasCurrentSession(): boolean {
  return Boolean(state.currentId);
}
