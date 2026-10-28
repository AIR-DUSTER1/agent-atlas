/**
 * ============================================================
 * render/messages.ts — 一轮对话的「块」挂载与整体重放
 * ============================================================
 * 用户正文、附件名、错误和服务端文案全部作为 textContent 子节点写入；
 * 只有受控 Markdown 边界允许生成 HTML。重放时清理所有旧 DOM 引用，防止
 * 增量更新写到已移除节点。
 */
import { blockBodies, partEls, state, transcript, usageEls } from "../core/state.js";
import { messagesEl, scrollBottom } from "../core/dom.js";
import { mountPart, mountTyping } from "./parts.js";
import { markNewMessage, resetNewMessageCount } from "../ui/scroll-to-bottom.js";
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";
import type { AssistantBlock, ChatBlock, NoticeBlock } from "../modules/types.js";

/** 用量小字：↑ 输入 · ↓ 输出 · 缓存 N% */
export function updateTurnCaption(ablock: AssistantBlock): void {
  const usage = ablock._usage;
  if (!usage) return;
  const body = blockBodies.get(ablock);
  if (!body) return;
  let el = usageEls.get(ablock);
  if (!el || !el.isConnected) {
    el = h("div", { class: "usage-caption" });
    body.appendChild(el);
    usageEls.set(ablock, el);
  }
  const cache = usage.lastCache > 0 && usage.lastInput > 0
    ? ` · 缓存 ${Math.round((usage.lastCache / usage.lastInput) * 100)}%`
    : "";
  el.textContent = `↑ ${usage.lastInput.toLocaleString("zh-CN")} · ↓ ${usage.lastOutput.toLocaleString("zh-CN")}${cache}`;
}

function syncEmptySession(): void {
  const empty = document.getElementById("empty-session");
  if (!empty) return;
  empty.classList.toggle("hidden", Boolean(state.currentId && transcript(state.currentId).length));
}

/** 把一个 block 挂到消息流末尾。live=false 用于整段历史重放，不累计“新消息”。 */
export function mountBlock(block: ChatBlock, live = true): void {
  if (live) markNewMessage();
  document.getElementById("empty-session")?.classList.add("hidden");

  if (block.t === "user") {
    const bubble = h("div", { class: "bubble" });
    if (block.files?.length) {
      const chips = h("div", { class: "f-chips" });
      for (const file of block.files) {
        chips.appendChild(h("span", { class: "f-chip" },
          icon(file.image ? "Image" : "Paperclip", { size: 12 }),
          h("span", { class: "fname" }, file.name),
          h("span", { class: "fsrc" }, file.source),
        ));
      }
      bubble.appendChild(chips);
    }
    bubble.appendChild(h("div", null, block.text));
    const wrap = h("div", { class: "msg-user" }, bubble);
    messagesEl.appendChild(wrap);
    block._el = wrap;
    return;
  }

  if (block.t === "notice") {
    const el = h("div", { class: "notice-block" + (block.loading ? " loading" : "") });
    messagesEl.appendChild(el);
    block._el = el;
    renderNoticeBlock(block);
    return;
  }

  if (block.t === "error") {
    const el = h("div", { class: "error-block" }, icon("TriangleAlert", { size: 14 }), h("span", null, block.text));
    messagesEl.appendChild(el);
    block._el = el;
    return;
  }

  // 切走后旧 typing 节点已脱离 DOM；切回来必须允许挂载新的指示器。
  if (block._typing && !block._typing.isConnected) block._typing = null;
  const avatar = h("div", { class: "avatar", "aria-hidden": "true" }, icon("Zap", { size: 15 }));
  const body = h("div", { class: "assistant-body" });
  const wrap = h("div", { class: "msg-assistant" }, avatar, body);
  messagesEl.appendChild(wrap);
  block._el = wrap;
  blockBodies.set(block, body);

  for (const part of block.parts) mountPart(block, part);
  if (!block.parts.length) mountTyping(block);
  if (block._usage) updateTurnCaption(block);
}

export function renderNoticeBlock(block: NoticeBlock): void {
  const el = block._el;
  if (!el) return;
  el.classList.toggle("loading", Boolean(block.loading));
  const children: Node[] = [
    h("div", { class: "notice-title" }, block.title || "提示"),
    h("div", { class: "notice-text" }, block.text || ""),
  ];
  if (block.summary) {
    children.push(h("details", { class: "notice-details" },
      h("summary", null, "查看压缩摘要"),
      h("pre", null, block.summary),
    ));
  }
  el.replaceChildren(...children);
}

/** 全量重绘当前会话（切换会话 / 回放补数据后） */
export function renderAll(): void {
  resetNewMessageCount();
  messagesEl.replaceChildren();
  partEls.clear();
  blockBodies.clear();
  usageEls.clear();
  const sid = state.currentId;
  if (!sid) return;
  for (const block of transcript(sid)) mountBlock(block, false);
  scrollBottom(true);
  syncEmptySession();
}
