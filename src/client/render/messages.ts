/**
 * ============================================================
 * render/messages.ts — 一轮对话的「块」挂载与整体重放
 * ============================================================
 * 职责：user / assistant / notice / error 四种块的 DOM 骨架，以及整段
 * 历史的一次性重建（renderAll）。
 * 设计立场：
 *  - 块级只搭骨架与静态内容，助手块内部部件交给 parts.ts —— 两者职责分明；
 *  - 重放必须清空 partEls/blockBodies，否则旧 DOM 引用会指到已移除节点，
 *    导致增量更新写进空气；
 *  - 用户块与 notice 全部 textContent 填充，模型/服务端文案不可信。
 */

import { blockBodies, partEls, state, transcript, usageEls } from "../core/state.js";
import { messagesEl, scrollBottom } from "../core/dom.js";
import { mountPart, mountTyping } from "./parts.js";
import type { AssistantBlock, ChatBlock, NoticeBlock } from "../modules/types.js";

/** 用量小字：↑ 输入 · ↓ 输出 · 缓存 N% */
export function updateTurnCaption(ablock: AssistantBlock): void {
  const u = ablock._usage;
  if (!u) return;
  const body = blockBodies.get(ablock);
  if (!body) return;
  let el = usageEls.get(ablock);
  if (!el || !el.isConnected) {
    el = document.createElement("div");
    el.className = "usage-caption";
    body.appendChild(el);
    usageEls.set(ablock, el);
  }
  const cache = u.lastCache > 0 && u.lastInput > 0 ? ` · 缓存 ${Math.round((u.lastCache / u.lastInput) * 100)}%` : "";
  el.textContent = `↑ ${u.lastInput.toLocaleString("zh-CN")} · ↓ ${u.lastOutput.toLocaleString("zh-CN")}${cache}`;
}

/** 把一个 block 挂到消息流末尾 */
export function mountBlock(block: ChatBlock): void {
  if (block.t === "user") {
    const wrap = document.createElement("div");
    wrap.className = "msg-user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    // 附件 chips（文件上下文来源：项目 / 远程 / 本地上传）
    if (block.files?.length) {
      const chips = document.createElement("div");
      chips.className = "f-chips";
      for (const f of block.files) {
        const c = document.createElement("span");
        c.className = "f-chip";
        c.innerHTML = `${f.image ? "🖼" : "📎"} <span class="fname"></span><span class="fsrc"></span>`;
        const name = c.querySelector(".fname");
        if (name) name.textContent = f.name;
        const src = c.querySelector(".fsrc");
        if (src) src.textContent = f.source;
        chips.appendChild(c);
      }
      bubble.appendChild(chips);
    }
    const textDiv = document.createElement("div");
    textDiv.textContent = block.text;
    bubble.appendChild(textDiv);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    block._el = wrap;
    return;
  }
  if (block.t === "notice") {
    const el = document.createElement("div");
    el.className = "notice-block" + (block.loading ? " loading" : "");
    messagesEl.appendChild(el);
    block._el = el;
    renderNoticeBlock(block);
    return;
  }
  if (block.t === "error") {
    const el = document.createElement("div");
    el.className = "error-block";
    el.textContent = "⚠️ " + block.text;
    messagesEl.appendChild(el);
    block._el = el;
    return;
  }
  // assistant
  const wrap = document.createElement("div");
  wrap.className = "msg-assistant";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "⚡";
  const body = document.createElement("div");
  body.className = "assistant-body";
  wrap.appendChild(avatar);
  wrap.appendChild(body);
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
  el.innerHTML = `<div class="notice-title"></div><div class="notice-text"></div>`;
  const title = el.querySelector(".notice-title");
  if (title) title.textContent = block.title || "提示";
  const text = el.querySelector(".notice-text");
  if (text) text.textContent = block.text || "";
  if (block.summary) {
    const details = document.createElement("details");
    details.className = "notice-details";
    const summary = document.createElement("summary");
    summary.textContent = "查看压缩摘要";
    const pre = document.createElement("pre");
    pre.textContent = block.summary;
    details.append(summary, pre);
    el.appendChild(details);
  }
}

/** 全量重绘当前会话（切换会话 / 回放补数据后） */
export function renderAll(): void {
  messagesEl.innerHTML = "";
  partEls.clear();
  blockBodies.clear();
  usageEls.clear();
  const sid = state.currentId;
  if (!sid) return;
  for (const block of transcript(sid)) mountBlock(block);
  scrollBottom(true);
}
