/**
 * ============================================================
 * stream/turn.ts — 发送 / 审批续跑 / 停止（一轮对话的生命周期）
 * ============================================================
 * 职责：把输入框内容或 resume 载荷变成一次 SSE 请求，并维护
 * state.streams 中对应会话的按钮显隐、状态点与收尾。
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
import { updateContextBar } from "../views/composer-bar.js";
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
  const sid = state.currentId;
  if (!text || !sid || state.streams[sid] || state.compacting[sid]) return;
  const cur = state.sessions.find((x) => x.id === sid);
  if (cur?.stale) return; // 历史会话不可发送
  closeComposerMenu();

  // 参考 ZCode：请求耗时期间保留上一轮主模型 context used 与当前模型窗口，
  // 新一轮的首个服务端 usage 到达后再用权威 token 快照校正。
  const previousUsage = state.usage[sid];
  state.usage[sid] = {
    lastInput: previousUsage?.lastInput ?? 0,
    lastOutput: previousUsage?.lastOutput ?? 0,
    lastCache: previousUsage?.lastCache ?? 0,
    contextTokens: previousUsage?.contextTokens,
    contextWindow: state.config?.contextWindow ?? previousUsage?.contextWindow,
    contextInputBudget: state.config?.contextBudget?.inputBudgetTokens ?? previousUsage?.contextInputBudget,
    outputReserveTokens: state.config?.contextBudget?.outputReserveTokens ?? previousUsage?.outputReserveTokens,
    safetyMarginTokens: state.config?.contextBudget?.safetyMarginTokens ?? previousUsage?.safetyMarginTokens,
    contextPending: true,
    taskInput: previousUsage?.taskInput,
    taskOutput: previousUsage?.taskOutput,
    taskTools: previousUsage?.taskTools,
    taskModels: previousUsage?.taskModels,
    taskActiveMs: previousUsage?.taskActiveMs,
    lastActivityAt: Date.now(),
    usagePeaks: previousUsage?.usagePeaks,
    taskUsagePeaks: previousUsage?.taskUsagePeaks,
    seenToolIds: previousUsage?.seenToolIds,
  };
  updateContextBar();

  const pending = state.pendingFiles;
  const fileRefs = fileRefsOf(pending);
  const filesMeta = filesMetaOf(pending);
  inputEl.value = "";
  autoGrowImpl();

  const arr = transcript(sid);
  const userBlock: ChatBlock = { t: "user", text, ...(filesMeta.length ? { files: filesMeta } : {}) };
  const ablock: AssistantBlock = { t: "assistant", parts: [] };
  arr.push(userBlock, ablock);
  mountBlock(userBlock);
  mountBlock(ablock);
  saveLocal();
  state.pendingFiles = [];
  renderAttachChips();

  // 首条消息自动作为会话标题
  const s = state.sessions.find((x) => x.id === sid);
  if (s && !s._renamed) {
    s.title = text.slice(0, 24) + (text.length > 24 ? "…" : "");
    s._renamed = true;
    const titleEl = $("session-title");
    if (titleEl) titleEl.textContent = s.title;
    renderSessions();
  }
  await streamTurn("/api/chat", {
    sessionId: sid,
    message: text,
    ...(fileRefs.length ? { files: fileRefs } : {}),
  }, ablock, sid);
}

export async function runResume(
  payload: Record<string, unknown>, targetBlock: AssistantBlock | null = null
): Promise<void> {
  const sid = state.currentId;
  if (!sid || state.streams[sid] || state.compacting[sid]) return;
  let ablock = targetBlock;
  if (ablock) {
    // 审批 / 澄清恢复沿用原助手块：一个完整回合始终只有一个头像。
    mountTyping(ablock);
  } else {
    const created: AssistantBlock = { t: "assistant", parts: [] };
    transcript(sid).push(created);
    mountBlock(created);
    ablock = created;
  }
  await streamTurn("/api/resume", { sessionId: sid, ...payload }, ablock, sid);
}

async function streamTurn(
  url: string, body: Record<string, unknown>, ablock: AssistantBlock, sid: string
): Promise<void> {
  const ctrl = new AbortController();
  state.streams[sid] = { ctrl, sid, ablock };
  syncComposerState(sid);
  renderSessions();
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
    await consumeSSE(res, (ev) => handleEvent(ev, ablock, sid));
  } catch (err) {
    const error = err as Error;
    if (error.name !== "AbortError") {
      const { addErrorBlock } = await import("./events.js");
      addErrorBlock(`请求失败：${error.message}`, sid);
    }
  } finally {
    finalize(ablock, sid);
    if (sid === state.currentId && wasNear) chatScroll.scrollTop = chatScroll.scrollHeight;
  }
}

function nearBottomImpl(): boolean {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 110;
}

/** finalize：结束流式态，清空光标 / 清理空块 */
export function finalize(ablock: AssistantBlock | null, sid: string | null = state.currentId): void {
  if (ablock) {
    if (!ablock.parts.length) {
      // 整轮无输出（请求失败 / 立即中止）→ 移除空助手块
      ablock._el?.remove();
      const arr = transcript(sid);
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
  if (sid && state.streams[sid]?.ablock === ablock) delete state.streams[sid];
  if (sid === state.currentId) syncComposerState(sid);
  renderSessions();
  saveLocal();
}

/** 当前会话的输入区只受本会话流 / 压缩状态影响，后台会话不锁输入。 */
export function syncComposerState(sid: string | null = state.currentId): void {
  const session = state.sessions.find((item) => item.id === sid);
  if (!session || !sid || sid !== state.currentId) return;
  const streaming = Boolean(state.streams[sid]);
  const compacting = Boolean(state.compacting[sid]);
  inputEl.disabled = Boolean(session.stale) || compacting;
  sendBtn.classList.toggle("hidden", streaming);
  stopBtn.classList.toggle("hidden", !streaming);
  sendBtn.disabled = Boolean(session.stale) || compacting;
  setStatus(streaming || compacting ? "busy" : "idle");
}

export function stopStreaming(): void {
  if (state.currentId) state.streams[state.currentId]?.ctrl.abort();
}

/** 新建会话（含 demo / external / estate 三种归属） */
export async function createSession(
  kind?: SessionKind | null, demo?: number | null, prefill?: string | null, agentId?: string
): Promise<void> {
  // 新会话归属当前选中的项目（「全部项目」视图下归入未归属）
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
