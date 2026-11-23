/**
 * ui/scroll-to-bottom.ts — 消息流回到底部与未读提示
 * ============================================================
 * 用户向上阅读历史时不强行抢滚动位置；新块到达只累计提示。点击按钮平滑回到底部，
 * 已在底部则提示自动清零。
 *
 * 为什么需要 cancelling 机制：平滑滚动是一次正在进行的动画，用户中途滚轮
 * 会被它覆盖 —— 松手后视图继续朝底部跑，看起来像「滚轮失灵 / 位置被拽回」。
 * 这里在用户一旦产生滚轮或触摸意图时立刻中止动画（instant 落点 = 当前可见位置），
 * 让用户的手永远赢。
 */
import { chatScroll } from "../core/dom.js";
import { h } from "./dom.js";
import { icon } from "./icon.js";

const NEAR_BOTTOM_PX = 120;
const SHOW_DISTANCE_PX = 220;
let button: HTMLButtonElement | null = null;
let count = 0;
/** 平滑滚动进行中：用于判断用户的滚轮是否在动画期间发生。 */
let animating = false;
let animationEnd = 0;

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

/**
 * 中止正在进行的平滑滚动：把 scrollTop 停在当前位置。
 * 必须在**同步**的 wheel/touchstart 里调用，才能赶在动画推进前落定坐标。
 */
function cancelScrollAnimation(): void {
  if (!animating) return;
  animating = false;
  animationEnd = 0;
  // behavior: "instant" 覆盖 CSS；即便将来有人重新加上 scroll-behavior: smooth
  // 也能立即落定，不会又启动一次动画。
  chatScroll.scrollTo({ top: chatScroll.scrollTop, behavior: "instant" });
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
      count = 0;
      render();
      if (reduce) {
        chatScroll.scrollTop = chatScroll.scrollHeight;
        return;
      }
      animating = true;
      // 动画时长只用于「超时自愈」，不参与位置计算：到点后无条件复位状态，
      // 避免异常中断（如内容高度骤变）让 animating 永久卡在 true。
      animationEnd = Date.now() + 800;
      window.setTimeout(() => { animating = false; }, 800);
      chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: "smooth" });
    },
  }, icon("ArrowDown", { size: 14 }), h("span", { class: "scroll-bottom-label", "aria-live": "polite" }, "回到底部"));
  main.appendChild(button);

  // 用户意图优先：滚轮 / 触摸 / 键盘滚动一律立刻中止平滑动画。
  // passive: true 不阻塞滚动，cancel 只是把当前坐标钉住。
  const interrupt = (): void => { cancelScrollAnimation(); };
  chatScroll.addEventListener("wheel", interrupt, { passive: true });
  chatScroll.addEventListener("touchstart", interrupt, { passive: true });
  chatScroll.addEventListener("keydown", interrupt);
  // 兜底：动画结束后若还残留 animating（例如浏览器取消动画不打 scroll 事件）
  window.setInterval(() => {
    if (animating && animationEnd && Date.now() > animationEnd) animating = false;
  }, 500);

  chatScroll.addEventListener("scroll", () => {
    if (distanceFromBottom() <= NEAR_BOTTOM_PX) count = 0;
    // 滚到底部说明动画自然结束
    if (distanceFromBottom() <= 1) animating = false;
    render();
  }, { passive: true });
  render();
}
