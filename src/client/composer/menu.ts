/**
 * ============================================================
 * composer/menu.ts — 输入框 / 命令与 @ 文件搜索菜单
 * ============================================================
 * 职责：检测触发字符、防抖搜索文件、渲染候选列表、键盘上下选择与确认。
 * 设计立场：
 *  - 触发必须位于 token 开头（行首或空白后），避免正文里的邮箱被误判成 @；
 *  - @ 选中不往输入框插「@路径」文本，而是加进附件 chips —— 内容由服务端授权读取；
 *  - 搜索请求带序号 + AbortController：快速输入时旧响应必须丢弃，不能覆盖新结果。
 */

import { $, autoGrowImpl, inputEl } from "../core/dom.js";
import { api } from "../core/api.js";
import { state } from "../core/state.js";
import { fmtSize } from "../modules/format.js";
import { addPendingFile } from "../views/attachments.js";
import type { ComposerItem, ComposerTrigger } from "../modules/types.js";

export const FILE_MENTION_LIMIT = 20;

export interface SlashCommandDef {
  id: string;
  icon: string;
  label: string;
  desc: string;
  keywords: string;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    id: "compact",
    icon: "🗜️",
    label: "压缩上下文",
    desc: "把当前会话整理成摘要，释放上下文空间",
    keywords: "compact 压缩 上下文 摘要",
  },
];

/** 压缩上下文动作：由 turn 层注入（避免 composer → stream 的环） */
let compactAction: () => Promise<void> = async () => {};
export function bindCompactAction(fn: () => Promise<void>): void {
  compactAction = fn;
}

const composerMenu: {
  kind: "slash" | "file" | null;
  items: ComposerItem[];
  active: number;
  trigger: ComposerTrigger | null;
  loading: boolean;
  error: string;
  searchSeq: number;
  searchTimer: ReturnType<typeof setTimeout> | undefined;
  ctrl: AbortController | null;
} = {
  kind: null,
  items: [],
  active: 0,
  trigger: null,
  loading: false,
  error: "",
  searchSeq: 0,
  searchTimer: undefined,
  ctrl: null,
};

export function isComposerMenuOpen(): boolean {
  return composerMenu.kind !== null;
}

export function closeComposerMenu(): void {
  composerMenu.kind = null;
  composerMenu.items = [];
  composerMenu.active = 0;
  composerMenu.trigger = null;
  composerMenu.loading = false;
  composerMenu.error = "";
  composerMenu.searchSeq += 1;
  clearTimeout(composerMenu.searchTimer);
  composerMenu.ctrl?.abort();
  composerMenu.ctrl = null;
  const menu = $("composer-menu");
  if (menu) {
    menu.classList.add("hidden");
    menu.innerHTML = "";
  }
}

function currentComposerTrigger(): ComposerTrigger | null {
  if (!state.currentId || state.streaming || state.compacting || inputEl.disabled) return null;
  const cur = state.sessions.find((s) => s.id === state.currentId);
  if (cur?.stale) return null;
  const end = inputEl.selectionStart ?? 0;
  if (end !== inputEl.selectionEnd) return null;
  const match = inputEl.value.slice(0, end).match(/(^|\s)([/@])([^\s]*)$/);
  if (!match) return null;
  return {
    char: match[2] as "/" | "@",
    query: match[3],
    start: end - match[2].length - match[3].length,
    end,
  };
}

function slashCommandItems(query: string): ComposerItem[] {
  const q = query.trim().toLowerCase();
  return SLASH_COMMANDS
    .filter((cmd) => !q || cmd.label.toLowerCase().includes(q) || cmd.keywords.toLowerCase().includes(q) || cmd.id.includes(q))
    .map((cmd) => ({ type: "command" as const, ...cmd }));
}

export function refreshComposerMenu(): void {
  const trigger = currentComposerTrigger();
  if (!trigger) {
    closeComposerMenu();
    return;
  }

  composerMenu.trigger = trigger;
  composerMenu.active = 0;

  if (trigger.char === "/") {
    clearTimeout(composerMenu.searchTimer);
    composerMenu.ctrl?.abort();
    composerMenu.ctrl = null;
    composerMenu.kind = "slash";
    composerMenu.loading = false;
    composerMenu.error = "";
    composerMenu.items = slashCommandItems(trigger.query);
    renderComposerMenu();
    return;
  }

  // @：先显示加载态，再防抖请求服务端搜索（最多 20 条）
  composerMenu.kind = "file";
  composerMenu.items = [];
  composerMenu.loading = true;
  composerMenu.error = "";
  renderComposerMenu();
  clearTimeout(composerMenu.searchTimer);
  const query = trigger.query;
  composerMenu.searchTimer = setTimeout(() => {
    if (composerMenu.kind === "file" && composerMenu.trigger?.query === query) {
      void searchComposerFiles(query);
    }
  }, 140);
}

export function renderComposerMenu(): void {
  const menu = $("composer-menu");
  if (!menu) return;
  if (!composerMenu.kind) {
    closeComposerMenu();
    return;
  }

  menu.classList.remove("hidden");
  menu.innerHTML = `<div class="composer-menu-head"><span></span><span></span></div>`;
  const head = menu.querySelector(".composer-menu-head");
  if (head && head.firstElementChild) {
    head.firstElementChild.textContent = composerMenu.kind === "slash"
      ? "命令"
      : `文件（最多 ${FILE_MENTION_LIMIT} 个）`;
  }
  if (head && head.lastElementChild && !composerMenu.loading && !composerMenu.error) {
    head.lastElementChild.textContent = composerMenu.items.length ? `${composerMenu.items.length} 个结果` : "";
  }

  if (composerMenu.loading) {
    const empty = document.createElement("div");
    empty.className = "composer-menu-empty";
    empty.textContent = "搜索文件中…";
    menu.appendChild(empty);
    return;
  }
  if (composerMenu.error) {
    const empty = document.createElement("div");
    empty.className = "composer-menu-empty";
    empty.textContent = `搜索失败：${composerMenu.error}`;
    menu.appendChild(empty);
    return;
  }
  if (!composerMenu.items.length) {
    const empty = document.createElement("div");
    empty.className = "composer-menu-empty";
    empty.textContent = composerMenu.kind === "slash" ? "没有匹配的命令" : "没有找到文件";
    menu.appendChild(empty);
    return;
  }

  composerMenu.items.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-item" + (index === composerMenu.active ? " active" : "");
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === composerMenu.active ? "true" : "false");
    button.innerHTML = `<span class="ci-icon"></span><span class="ci-main"><span class="ci-title"></span><span class="ci-desc"></span></span><span class="ci-meta"></span>`;
    const icon = button.querySelector(".ci-icon");
    const title = button.querySelector(".ci-title");
    const desc = button.querySelector(".ci-desc");
    const meta = button.querySelector(".ci-meta");
    if (item.type === "command") {
      if (icon) icon.textContent = item.icon;
      if (title) title.textContent = item.label;
      if (desc) desc.textContent = item.desc;
      if (meta) meta.textContent = "Enter";
    } else {
      if (icon) icon.textContent = "📄";
      if (title) title.textContent = item.file.name;
      if (desc) desc.textContent = `${item.file.rootName || ""} / ${item.file.rel || ""}`;
      if (meta) meta.textContent = fmtSize(item.file.size);
    }
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectComposerItem(index);
    });
    menu.appendChild(button);
  });
  menu.querySelector(".composer-item.active")?.scrollIntoView({ block: "nearest" });
}

async function searchComposerFiles(query: string): Promise<void> {
  const seq = ++composerMenu.searchSeq;
  composerMenu.ctrl?.abort();
  const ctrl = new AbortController();
  composerMenu.ctrl = ctrl;
  try {
    const data = await api<{ files?: Array<{ path: string; name: string; rootName?: string; rel?: string; size: number }> }>(
      "/api/fs/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: ctrl.signal,
      }
    );
    if (seq !== composerMenu.searchSeq || composerMenu.kind !== "file") return;
    composerMenu.items = (data.files || []).slice(0, FILE_MENTION_LIMIT)
      .map((file) => ({ type: "file" as const, file: { ...file, rel: file.rel ?? file.path } }));
    composerMenu.active = 0;
    composerMenu.loading = false;
    renderComposerMenu();
  } catch (err) {
    const error = err as Error;
    if (seq !== composerMenu.searchSeq || error.name === "AbortError") return;
    composerMenu.items = [];
    composerMenu.loading = false;
    composerMenu.error = error.message;
    renderComposerMenu();
  }
}

export function selectComposerItem(index: number): void {
  const item = composerMenu.items[index];
  const trigger = composerMenu.trigger;
  if (!item || !trigger) return;
  const value = inputEl.value;
  const next = value.slice(0, trigger.start) + value.slice(trigger.end);

  if (item.type === "command") {
    inputEl.value = next.replace(/\s+$/, "");
    closeComposerMenu();
    autoGrowImpl();
    inputEl.focus();
    if (item.id === "compact") void compactAction();
    return;
  }

  if (!addPendingFile({
    kind: "fs",
    path: item.file.path,
    name: item.file.name,
    source: item.file.rootName || "项目文件",
  })) return;
  inputEl.value = next;
  closeComposerMenu();
  autoGrowImpl();
  inputEl.focus();
}

function moveComposerActive(delta: number): void {
  if (!composerMenu.kind || !composerMenu.items.length) return;
  const length = composerMenu.items.length;
  composerMenu.active = (composerMenu.active + delta + length) % length;
  renderComposerMenu();
}

/** 返回 true 表示事件已被输入菜单消费，调用方不要再走发送逻辑 */
export function handleComposerKeydown(event: KeyboardEvent): boolean {
  if (!composerMenu.kind) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    closeComposerMenu();
    return true;
  }
  if (!composerMenu.items.length) return false;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveComposerActive(1);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveComposerActive(-1);
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    selectComposerItem(composerMenu.active);
    return true;
  }
  return false;
}
