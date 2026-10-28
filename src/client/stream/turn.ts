/**
 * ============================================================
 * stream/turn.ts — 发送 / 审批续跑 / 停止（一轮对话的生命周期）
 * ============================================================
 * 职责：把输入框内容或 resume 载荷变成一次 SSE 请求，并维护
 * state.streaming、按钮显隐、状态点与收尾。
 * 设计立场：
 *  - 「一个回合 = 一个助手块」：审批 / 澄清续跑必须沿用原块，否则会多出头像；
 *  - 中断（AbortError）不当作错误展示 —— 用户点停止是正常操作；
 *  - 无论成功失败，finally 都要 finalize（否则按钮卡在「停止」态）。
 */

import { $, autoGrowImpl, chatScroll, inputEl, sendBtn, stopBtn } from "../core/dom.js";
import { authFetch } from "../core/api.js";
import { saveLocal, state, transcript } from "../core/state.js";
import { uiAlert } from "../ui/dialog.js";
import { mountBlock } from "../render/messages.js";
import { closeComposerMenu } from "../composer/menu.js";
import { renderAttachChips } from "../views/attachments.js";
import { renderSessions } from "../views/sessions.js";
import { renderAll } from "../render/messages.js";
import { showChatState } from "../views/navigation.js";
import { mountTyping } from "../render/parts.js";
import { consumeSSE, handleEvent } from "./events.js";
import type { AssistantBlock, ChatBlock, PendingFile, Session, SessionKind } from "../modules/types.js";

/** 附件引用：项目/远程文件传路径（服务端读取校验），上传传 uploadId */
function fileRefsOf(files: PendingFile[]): Array<{ kind: string; path?: string; uploadId?: string; name: string }> {
  return files.map((f) => f.kind === "upload"
    ? { kind: "upload", uploadId: f.uploadId, name: f.name }
    : { kind: "fs", path: f.path, name: f.name });
}

function filesMetaOf(files: PendingFile[]): Array<{ name: string; source: string; image?: boolean }> {
  return files.map((f) => ({
    name: f.name,
    source: f.kind === "upload" && f.preview ? "图片" : (f.source || "项目文件"),
    image: f.kind === "upload" && Boolean(f.preview),
  }));
}

export function setStatus(mode: "idle" | "busy"): void {
  const el = $("status-dot");
  if (!el) return;
  el.className = "status " + mode;
  const label = mode === "busy" ? "正在生成回复" : "空闲";
  el.title = label;
  el.setAttribute("aria-label", label);
}
export async function send(): Promise<void> {
  const text = inputEl.value.trim();
  if (!text || !state.currentId || state.streaming || state.compacting) return;
  const cur = state.sessions.find((x) => x.id === state.currentId);
  if (cur?.stale) return; // 历史会话不可发送
  closeComposerMenu();

  // 新一轮上下文用量必须从空开始，否则上一轮峰值会污染本轮容量条。
  delete state.usage[state.currentId];
  document.getElementById("context-bar")?.classList.add("hidden");

  const pending = state.pendingFiles;
  const fileRefs = fileRefsOf(pending);
  const filesMeta = filesMetaOf(pending);
  inputEl.value = "";
  autoGrowImpl();

  const arr = transcript(state.currentId);
  const userBlock: ChatBlock = { t: "user", text, ...(filesMeta.length ? { files: filesMeta } : {}) };
  const ablock: AssistantBlock = { t: "assistant", parts: [] };
  arr.push(userBlock, ablock);
  mountBlock(userBlock);
  mountBlock(ablock);
  saveLocal();
  state.pendingFiles = [];
  renderAttachChips();

  // 首条消息自动作为会话标题
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (s && !s._renamed) {
    s.title = text.slice(0, 24) + (text.length > 24 ? "…" : "");
    s._renamed = true;
    const titleEl = $("session-title");
    if (titleEl) titleEl.textContent = s.title;
    renderSessions();
  }
  await streamTurn("/api/chat", {
    sessionId: state.currentId,
    message: text,
    ...(fileRefs.length ? { files: fileRefs } : {}),
  }, ablock);
}

export async function runResume(
  payload: Record<string, unknown>, targetBlock: AssistantBlock | null = null
): Promise<void> {
  if (!state.currentId || state.streaming) return;
  let ablock = targetBlock;
  if (ablock) {
    // 审批 / 澄清恢复沿用原助手块：一个完整回合始终只有一个头像。
    mountTyping(ablock);
  } else {
    const created: AssistantBlock = { t: "assistant", parts: [] };
    transcript(state.currentId).push(created);
    mountBlock(created);
    ablock = created;
  }
  await streamTurn("/api/resume", { sessionId: state.currentId, ...payload }, ablock);
}

async function streamTurn(
  url: string, body: Record<string, unknown>, ablock: AssistantBlock
): Promise<void> {
  const sid = state.currentId;
  if (!sid) return;
  const ctrl = new AbortController();
  state.streaming = { ctrl, sid, ablock };
  stopBtn.classList.remove("hidden");
  sendBtn.classList.add("hidden");
  setStatus("busy");
  const wasNear = nearBottomImpl();

  try {
    const res = await authFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await consumeSSE(res, (ev) => handleEvent(ev, ablock));
  } catch (err) {
    const error = err as Error;
    if (error.name !== "AbortError") {
      const { addErrorBlock } = await import("./events.js");
      addErrorBlock(`请求失败：${error.message}`);
    }
  } finally {
    finalize(ablock);
    if (wasNear) chatScroll.scrollTop = chatScroll.scrollHeight;
  }
}

function nearBottomImpl(): boolean {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 110;
}

/** finalize：结束流式态，清空光标 / 清理空块 */
export function finalize(ablock: AssistantBlock | null): void {
  if (ablock) {
    if (!ablock.parts.length) {
      // 整轮无输出（请求失败 / 立即中止）→ 移除空助手块
      ablock._el?.remove();
      const arr = transcript(state.currentId);
      const i = arr.indexOf(ablock);
      if (i >= 0) arr.splice(i, 1);
    } else {
      for (const p of ablock.parts) {
        if (p.p === "text" && p.streaming) {
          p.streaming = false;
          void import("../render/parts.js").then((m) => m.renderTextPart(p));
        } else if (p.p === "thinking" && p.streaming) {
          p.streaming = false;
          void import("../render/parts.js").then((m) => m.updateThinkingPart(p));
        }
      }
    }
  }
  state.streaming = null;
  stopBtn.classList.add("hidden");
  sendBtn.classList.remove("hidden");
  sendBtn.disabled = !state.currentId;
  setStatus("idle");
  saveLocal();
}

export function stopStreaming(): void {
  state.streaming?.ctrl.abort();
}

/** 新建会话（含 demo / external / estate 三种归属） */
export async function createSession(
  kind?: SessionKind | null, demo?: number | null, prefill?: string | null, agentId?: string
): Promise<void> {
  // 新会话归属当前选中的项目（「全部项目」视图下归到默认项目）
  const projectId = state.projectView !== "all" ? state.projectView : "default";
  const { api } = await import("../core/api.js");
  const data = await api<{ id: string }>("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(demo
      ? { kind: "demo", demo, projectId }
      : { kind: kind || "agent", projectId, ...(kind === "external" ? { agentId, title: prefill || undefined } : {}) }),
  });
  const created = { ...(data as unknown as Session), stale: false };
  state.sessions.unshift(created);
  state.currentId = created.id;
  renderSessions();
  showChatState(created);
  renderAll();
  closeModalImpl();
  if (prefill) {
    inputEl.value = prefill;
    autoGrowImpl();
    inputEl.focus();
  } else {
    void uiAlert;
  }
}

export function closeModalImpl(): void {
  $("modal-mask")?.classList.add("hidden");
}

export function openModalImpl(): void {
  $("modal-mask")?.classList.remove("hidden");
}
