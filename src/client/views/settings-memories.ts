/**
 * ============================================================
 * views/settings-memories.ts — 设置页「长期记忆」分区
 * ============================================================
 * 职责：记忆列表渲染、手动新增、删除、状态条。
 * 设计立场：
 *  - innerHTML 搭骨架 + textContent 填正文（记忆内容来自模型/用户输入，不可信）；
 *  - 删除后立刻重拉列表（服务端是唯一真相，不做本地列表裁剪）；
 *  - 状态条 4 秒自动淡出，避免久留让人误以为是当前状态。
 */

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import type { MemoryEntry } from "../modules/types.js";

let memStatusTimer: ReturnType<typeof setTimeout> | undefined;

export function memStatus(text: string, cls: string): void {
  const el = $("memories-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  clearTimeout(memStatusTimer);
  if (text) {
    memStatusTimer = setTimeout(() => {
      if (el.textContent === text) { el.textContent = ""; el.className = "settings-status"; }
    }, 4000);
  }
}

function renderMemoriesList(memories: MemoryEntry[]): void {
  const list = $("memories-list");
  if (!list) return;
  list.innerHTML = "";
  if (!memories.length) {
    const empty = document.createElement("p");
    empty.className = "memories-empty";
    empty.textContent = "还没有长期记忆。在对话里说「记住：…」或用下面的表单手动添加。";
    list.appendChild(empty);
    return;
  }
  for (const m of memories) {
    const row = document.createElement("div");
    row.className = "memory-item";
    row.innerHTML = `
      <div class="m-body">
        <div class="m-key"></div>
        <div class="m-content"></div>
        <div class="m-meta"></div>
      </div>
      <button class="p-del" title="删除这条记忆">删除</button>`;
    const keyEl = row.querySelector(".m-key");
    if (keyEl) keyEl.textContent = m.key;
    const contentEl = row.querySelector(".m-content");
    if (contentEl) contentEl.textContent = m.content;
    const when = new Date(m.updatedAt).toLocaleString();
    const metaEl = row.querySelector(".m-meta");
    if (metaEl) metaEl.textContent = `${m.source === "agent" ? "Agent 保存" : "手动添加"} · ${when}`;
    row.querySelector(".p-del")?.addEventListener("click", async () => {
      try {
        await api(`/api/memories/${encodeURIComponent(m.id)}`, { method: "DELETE" });
        await refreshMemories();
        memStatus("已删除", "ok");
      } catch (err) {
        memStatus(`✗ ${(err as Error).message}`, "err");
      }
    });
    list.appendChild(row);
  }
}

export async function refreshMemories(): Promise<MemoryEntry[]> {
  const data = await api<{ memories?: MemoryEntry[] }>("/api/memories");
  renderMemoriesList(data.memories || []);
  return data.memories || [];
}

export async function saveMemoryFromForm(): Promise<void> {
  const keyEl = $("mem-key") as HTMLInputElement | null;
  const contentEl = $("mem-content") as HTMLTextAreaElement | null;
  const key = (keyEl?.value || "").trim();
  const content = (contentEl?.value || "").trim();
  if (!key || !content) { memStatus("主题与内容都要填", "err"); return; }
  try {
    await api("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, content }),
    });
    if (keyEl) keyEl.value = "";
    if (contentEl) contentEl.value = "";
    await refreshMemories();
    memStatus("已保存（下轮对话即生效）", "ok");
  } catch (err) {
    memStatus(`✗ ${(err as Error).message}`, "err");
  }
}
