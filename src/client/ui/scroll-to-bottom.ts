/**
 * ui/scroll-to-bottom.ts — 消息流回到底部与未读提示
 * ============================================================
 * 用户向上阅读历史时不强行抢滚动位置；新块到达只累计提示。点击按钮平滑回到底部，
 * 已在底部则提示自动清零。
 */
import { chatScroll } from "../core/dom.js";
import { h } from "./h.js";
import { icon } from "./icon.js";

const NEAR_BOTTOM_PX = 120;
const SHOW_DISTANCE_PX = 220;
let button: HTMLButtonElement | null = null;
let count = 0;

function distanceFromBottom(): number {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight;
}

function render(): void {
  if (!button) return;
  const show = count > 0 || distanceFromBottom() > SHOW_DISTANCE_PX;
  button.classList.toggle("hidden", !show);
  button.dataset.unread = String(count);
  const label = button.querySelector<HTMLElement>(".scroll-bottom-label");
  if (label) label.textContent = count > 0 ? `${count} 条新消息` : "回到底部";
}

export function markNewMessage(): void {
  if (!button || distanceFromBottom() <= NEAR_BOTTOM_PX) {
    count = 0;
  } else {
    count += 1;
  }
  render();
}

export function resetNewMessageCount(): void {
  count = 0;
  render();
}
export function bindScrollToBottom(): void {
  if (button) return;
  const main = document.getElementById("main");
  if (!main) return;
  button = h("button", {
    type: "button",
    class: "scroll-bottom-btn hidden",
    title: "回到最新消息",
    "aria-label": "回到最新消息",
    onclick: () => {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: reduce ? "auto" : "smooth" });
      count = 0;
      render();
    },
  }, icon("ArrowDown", { size: 14 }), h("span", { class: "scroll-bottom-label", "aria-live": "polite" }, "回到底部"));
  main.appendChild(button);
  chatScroll.addEventListener("scroll", () => {
    if (distanceFromBottom() <= NEAR_BOTTOM_PX) count = 0;
    render();
  }, { passive: true });
  render();
}
