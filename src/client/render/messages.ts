/**
 * ============================================================
 * render/messages.ts — 消息流编排：块骨架由 Vue 渲染，parts 仍命令式（M4 4.6）
 * ============================================================
 * 分层：
 *  - **块骨架**（user / notice / error / assistant 外壳、footer、复制按钮、用量）
 *    由 message-list-vue.vue 声明式渲染，本文件不再 createElement 这些结构；
 *  - **part 渲染**（text / thinking / tool / approval / clarification / route）
 *    仍走 render/parts.ts 的增量路径：它们需要 partEls 引用表 + 55ms 节流，
 *    改 v-for 会在 token 级别变贵。
 *
 * 本文件保留的职责：
 *  1. mountBlock：向 core state 追加块 → 让 Vue 渲染骨架 → 等 DOM 就绪后把
 *     已有 parts 逐个 mountPart 进去（历史回放与「先有 parts 再挂块」两种情形）；
 *  2. updateTurnCaption / refreshAssistantCopy：把用量与「可复制总结」写回
 *     store 视图（Vue 负责显示）；
 *  3. renderAll：整体重放。
 */
import {
  blockBodies, partEls, state, transcript, usageEls,
} from "../core/state.js";
import { messagesEl, scrollBottom } from "../core/dom.js";
import { mountPart, mountTyping } from "./parts.js";
import { markNewMessage, resetNewMessageCount } from "../ui/scroll-to-bottom.js";
import { isClarifyNodeName, normalizeApprovalOrder } from "../modules/chat-flow.js";
import { messageBlockKey, useMessagesStore } from "../stores/messages.js";
import type { AssistantBlock, ChatBlock } from "../modules/types.js";

/* ---------------------------------------------------------------------------
 * 块骨架挂载（Vue 渲染）→ parts 挂入
 * ------------------------------------------------------------------------- */

/** 等 Vue 把 store 变更 patch 到 DOM（两帧：一次排期，一次落地）。 */
async function nextDomFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/**
 * 等某个块的容器出现在注册表里（最多 ~20 帧）。
 * 单靠固定帧数在慢机器/大列表下会偶发拿不到；轮询让「Vue 渲染完成」成为
 * 可等待的事实而不是猜测。
 */
async function waitForWrap(block: ChatBlock): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const wrap = wrapOf(block);
    if (wrap) return wrap;
    await nextDomFrame();
  }
  return wrapOf(block);
}

/** 按块在 transcript 里的序号取 Vue 注册的容器。 */
function wrapOf(block: ChatBlock): HTMLElement | null {
  const sid = state.currentId;
  if (!sid) return null;
  const index = transcript(sid).indexOf(block);
  if (index < 0) return null;
  return window.__agentatlasBlockBodyRegistry?.wrap?.(messageBlockKey(sid, block.t, index)) ?? null;
}

/** 接管一个助手块：把已有 parts 挂进它的 .assistant-body。 */
function hydrateAssistant(block: AssistantBlock, wrap: HTMLElement | null): void {
  normalizeApprovalOrder(block);
  block._el = wrap ?? undefined;
  const body = wrap?.querySelector<HTMLElement>(".assistant-body");
  if (!body) return;
  // 旧版本会把 clarify 节点徽章和澄清卡同时写入 transcript；渲染时自动迁移清理。
  if (block.parts.some((part) => part.p === "clarification")) {
    for (let index = block.parts.length - 1; index >= 0; index -= 1) {
      const part = block.parts[index];
      if (part?.p !== "node" || !isClarifyNodeName(part.name)) continue;
      partEls.delete(part);
      block.parts.splice(index, 1);
    }
  }
  // 重建前先撤销旧 part 引用，避免增量更新继续写入已脱离 DOM 的节点。
  for (const part of block.parts) partEls.delete(part);
  body.replaceChildren();
  block._typing = null;
  blockBodies.set(block, body);
  for (const part of block.parts) mountPart(block, part);
  if (!block.parts.length) mountTyping(block);
  if (block._usage) updateTurnCaption(block);
  refreshAssistantCopy(block);
}

/**
 * 续跑前强制把助手块重新绑定到当前 DOM。
 *
 * 真实事故：审批续跑的 token 与 usage 都已到达，localStorage 也有最终回答，
 * 但 Vue 重渲染后 partEls/blockBodies 仍指向旧节点，界面只更新用量不显示回答。
 * 这里以 transcript 中的 part 数据为唯一事实源重建一次，保证后续增量命中新 DOM。
 */
export async function remountAssistantParts(block: AssistantBlock): Promise<void> {
  const wrap = await waitForWrap(block);
  hydrateAssistant(block, wrap);
}

/**
 * 把块加入消息流：让 Vue 渲染骨架，助手块再挂 parts。
 * live=false 用于整段历史重放（不累计「新消息」角标）。
 */
export function mountBlock(block: ChatBlock, live = true): void {
  if (live) markNewMessage();
  document.getElementById("empty-session")?.classList.add("hidden");
  const store = useMessagesStore();
  store.refresh();
  if (block.t !== "assistant") return;
  // 助手块需要等 Vue 渲染出 .assistant-body 后再挂 parts
  void (async () => {
    await nextDomFrame();
    hydrateAssistant(block, await waitForWrap(block));
    scrollBottom();
  })();
}

/* ---------------------------------------------------------------------------
 * 用量小字与复制按钮：只更新视图，DOM 由 Vue 负责
 * ------------------------------------------------------------------------- */

/** 用量小字（↑ 输入 · ↓ 输出 · 缓存 N%）。 */
export function updateTurnCaption(ablock: AssistantBlock): void {
  if (!ablock._usage) return;
  useMessagesStore().refresh();
}

/** 助手正文流结束后刷新「复制总结」显隐（历史回放时也会走到这里）。 */
export function refreshAssistantCopy(ablock: AssistantBlock): void {
  void ablock;
  useMessagesStore().refresh();
}

/** 提示块内容更新（压缩摘要等）：视图刷新即可，DOM 由 Vue 渲染。 */
export function renderNoticeBlock(block: ChatBlock): void {
  void block;
  useMessagesStore().refresh();
}

/* ---------------------------------------------------------------------------
 * 整体重放
 * ------------------------------------------------------------------------- */

/**
 * 全量重绘当前会话（切换会话 / 回放补数据后）。
 * 关键：清空 DOM 引用表，避免增量更新写到已移除节点。
 */
export function renderAll(): void {
  resetNewMessageCount();
  // ⚠ #messages 是 message-list-vue 的挂载容器：外部绝不能 replaceChildren /
  // innerHTML="" —— 那会把 Vue 的根 vnode 从 DOM 里摘掉，之后任何 patch 都会
  // 在已分离节点上 insertBefore 并抛异常。清列表一律走 store.clear()。
  void messagesEl;
  partEls.clear();
  blockBodies.clear();
  usageEls.clear();
  const sid = state.currentId;
  const store = useMessagesStore();
  store.clear();
  if (!sid) return;
  // 一次性编译全部块（Vue 一把渲染），再逐个助手块挂 parts
  store.refresh();
  void (async () => {
    await nextDomFrame();
    for (const block of transcript(sid)) {
      if (block.t !== "assistant") continue;
      hydrateAssistant(block, await waitForWrap(block));
    }
    scrollBottom(true);
    syncEmptySession();
  })();
}

function syncEmptySession(): void {
  const empty = document.getElementById("empty-session");
  if (!empty) return;
  empty.classList.toggle("hidden", Boolean(state.currentId && transcript(state.currentId).length));
}
