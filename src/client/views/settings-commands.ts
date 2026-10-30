/**
 * ============================================================
 * views/settings-commands.ts — 自定义命令的双栏管理页
 * ============================================================
 * 职责：命令检索、选择、创建、编辑、改名与删除，并同步斜杠菜单缓存。
 * 设计立场：
 *  - 列表与编辑器分区：管理已有命令时不再复用「同名覆盖」表单；
 *  - 命令只是提示词模板，编辑内容必须用 textContent 语义渲染；
 *  - 编辑未保存时切换或关闭要确认，避免误丢模板；
 *  - 保存/删除后立即重拉 `/api/commands`，斜杠菜单无需刷新页面。
 */

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { loadUserCommands, type UserCommandItem } from "../composer/menu.js";
import { uiConfirm } from "../ui/dialog.js";
import { clearFieldError, setFieldError } from "../ui/field.js";
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";

const MAX_TEMPLATE_CHARS = 8_000;
const MAX_NAME_CHARS = 40;
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const RESERVED_NAMES = new Set(["compact"]);

type EditorMode = "closed" | "create" | "edit";

interface EditorSnapshot {
  name: string;
  title: string;
  description: string;
  template: string;
}

let allCommands: UserCommandItem[] = [];
let searchTerm = "";
let editorMode: EditorMode = "closed";
let editingOriginalName = "";
let baseline: EditorSnapshot = { name: "", title: "", description: "", template: "" };
let saving = false;
let bound = false;
let cmdStatusTimer: ReturnType<typeof setTimeout> | undefined;

export function cmdStatus(text: string, cls: string): void {
  const el = $("commands-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  clearTimeout(cmdStatusTimer);
  if (text) {
    cmdStatusTimer = setTimeout(() => {
      if (el.textContent === text) {
        el.textContent = "";
        el.className = "settings-status";
      }
    }, 4_000);
  }
}

function input(id: string): HTMLInputElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ? element : null;
}

function textarea(id: string): HTMLTextAreaElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLTextAreaElement ? element : null;
}

function valueOf(id: string): string {
  return (input(id) ?? textarea(id))?.value ?? "";
}

function setValue(id: string, value: string): void {
  const el = input(id) ?? textarea(id);
  if (el) el.value = value;
}

function currentSnapshot(): EditorSnapshot {
  return {
    name: valueOf("cmd-name"),
    title: valueOf("cmd-title"),
    description: valueOf("cmd-desc"),
    template: valueOf("cmd-template"),
  };
}

function isEditorDirty(): boolean {
  if (editorMode === "closed") return false;
  const current = currentSnapshot();
  return current.name !== baseline.name
    || current.title !== baseline.title
    || current.description !== baseline.description
    || current.template !== baseline.template;
}

async function confirmDiscardIfDirty(): Promise<boolean> {
  if (!isEditorDirty()) return true;
  const confirmed = await uiConfirm("当前命令有未保存的修改，确定放弃吗？", {
    title: "放弃未保存的修改",
    okText: "放弃修改",
    danger: true,
  });
  return Boolean(confirmed);
}

function syncTemplateCount(): void {
  const count = $("cmd-template-count");
  if (count) count.textContent = `${valueOf("cmd-template").length} / ${MAX_TEMPLATE_CHARS}`;
}

function clearEditorErrors(): void {
  clearFieldError("cmd-name");
  clearFieldError("cmd-template");
}

function updateEditorChrome(): void {
  const mode = $("cmd-editor-mode");
  const title = $("cmd-editor-title");
  const save = $("cmd-save-btn") as HTMLButtonElement | null;
  if (mode) mode.textContent = editorMode === "create" ? "新建命令" : "编辑命令";
  if (title) title.textContent = editorMode === "create" ? "命令详情" : `/${editingOriginalName}`;
  if (save) save.textContent = editorMode === "create" ? "创建命令" : "保存修改";
}

function showEditorForm(): void {
  $("commands-editor-empty")?.classList.add("hidden");
  $("command-form")?.classList.remove("hidden");
}

function collapseEditor(): void {
  editorMode = "closed";
  editingOriginalName = "";
  baseline = { name: "", title: "", description: "", template: "" };
  $("command-form")?.classList.add("hidden");
  $("commands-editor-empty")?.classList.remove("hidden");
  clearEditorErrors();
  renderCommandList();
}

function setSaving(next: boolean): void {
  saving = next;
  const form = $("command-form") as HTMLFormElement | null;
  form?.setAttribute("aria-busy", String(next));
  for (const id of ["cmd-save-btn", "cmd-editor-cancel", "cmd-editor-close"]) {
    const button = $(id) as HTMLButtonElement | null;
    if (button) button.disabled = next;
  }
  const save = $("cmd-save-btn") as HTMLButtonElement | null;
  if (save) {
    save.textContent = next
      ? "保存中…"
      : editorMode === "create" ? "创建命令" : "保存修改";
  }
}

function fillEditor(command: UserCommandItem | null): void {
  setValue("cmd-name", command?.name ?? "");
  setValue("cmd-title", command?.title ?? "");
  setValue("cmd-desc", command?.description ?? "");
  setValue("cmd-template", command?.template ?? "");
  clearEditorErrors();
  syncTemplateCount();
  updateEditorChrome();
  showEditorForm();
  baseline = currentSnapshot();
}

async function openCreateEditor(): Promise<void> {
  if (saving) return;
  if (!(await confirmDiscardIfDirty())) return;
  editorMode = "create";
  editingOriginalName = "";
  fillEditor(null);
  renderCommandList();
  cmdStatus("", "");
  requestAnimationFrame(() => input("cmd-name")?.focus());
}

async function openEditEditor(command: UserCommandItem): Promise<void> {
  if (saving) return;
  if (editorMode === "edit" && editingOriginalName === command.name) {
    input("cmd-name")?.focus();
    return;
  }
  if (!(await confirmDiscardIfDirty())) return;
  editorMode = "edit";
  editingOriginalName = command.name;
  fillEditor(command);
  renderCommandList();
  cmdStatus("", "");
  requestAnimationFrame(() => input("cmd-name")?.focus());
}

async function closeEditor(): Promise<void> {
  if (editorMode === "closed" || saving) return;
  if (!(await confirmDiscardIfDirty())) return;
  collapseEditor();
  $("cmd-new-btn")?.focus();
}

function visibleCommands(): UserCommandItem[] {
  const query = searchTerm.trim().toLowerCase();
  if (!query) return allCommands;
  return allCommands.filter((command) =>
    command.name.toLowerCase().includes(query)
    || (command.title ?? "").toLowerCase().includes(query)
    || (command.description ?? "").toLowerCase().includes(query)
    || command.template.toLowerCase().includes(query)
  );
}

function renderEmptyState(filtered: boolean): HTMLElement {
  const empty = h("div", { class: "commands-empty-state" });
  empty.append(icon(filtered ? "Search" : "Command", { size: 26 }));
  empty.appendChild(h("h3", null, filtered ? "没有匹配的命令" : "还没有自定义命令"));
  empty.appendChild(h(
    "p",
    null,
    filtered
      ? "调整搜索词，或清空搜索查看全部命令。"
      : "把常用提示词保存成斜杠命令，之后在输入框敲 / 就能快速填入。",
  ));
  if (!filtered) {
    empty.appendChild(h("button", {
      type: "button",
      class: "ghost-btn small",
      onclick: () => { void openCreateEditor(); },
    }, "新建第一条命令"));
  }
  return empty;
}

function renderCommandList(): void {
  const list = $("commands-list");
  if (!list) return;
  const commands = visibleCommands();
  const count = $("commands-count");
  if (count) {
    count.textContent = searchTerm.trim()
      ? `${commands.length} / ${allCommands.length} 个命令`
      : `${allCommands.length} 个命令`;
  }

  list.replaceChildren();
  if (!commands.length) {
    list.appendChild(renderEmptyState(allCommands.length > 0));
    return;
  }

  for (const command of commands) {
    const active = editorMode === "edit" && editingOriginalName === command.name;
    const open = (): void => { void openEditEditor(command); };
    const editButton = h("button", {
      type: "button",
      class: "command-card-action",
      title: `编辑 /${command.name}`,
      "aria-label": `编辑命令 /${command.name}`,
      onclick: open,
    }, icon("Pencil", { size: 14 }));
    const deleteButton = h("button", {
      type: "button",
      class: "command-card-action delete",
      title: `删除 /${command.name}`,
      "aria-label": `删除命令 /${command.name}`,
    }, icon("Trash2", { size: 14 }));
    deleteButton.addEventListener("click", () => { void deleteCommandCard(command, deleteButton); });

    const card = h("article", { class: "command-card" + (active ? " active" : "") },
      h("button", {
        type: "button",
        class: "command-card-main",
        "aria-label": `打开命令 /${command.name}`,
        onclick: open,
      },
        h("span", { class: "command-card-syntax" }, `/${command.name}`),
        h("span", { class: "command-card-title" }, command.title || "未设置菜单显示名"),
        h("span", { class: "command-card-desc" }, command.description || "未填写命令说明"),
        h("span", { class: "command-card-meta" }, `${command.template.length} 字符`),
      ),
      h("div", { class: "command-card-actions" }, editButton, deleteButton),
    );
    list.appendChild(card);
  }
}

function validateForm(): boolean {
  const name = valueOf("cmd-name").trim();
  const template = valueOf("cmd-template");
  clearEditorErrors();
  let valid = true;
  let firstInvalidId = "";

  if (!name) {
    setFieldError("cmd-name", "命令名不能为空");
    valid = false;
    firstInvalidId = "cmd-name";
  } else if (name.length > MAX_NAME_CHARS) {
    setFieldError("cmd-name", `命令名不能超过 ${MAX_NAME_CHARS} 个字符`);
    valid = false;
    firstInvalidId = "cmd-name";
  } else if (!NAME_RE.test(name)) {
    setFieldError("cmd-name", "命令名只能用字母、数字、下划线和短横线，且以字母或数字开头");
    valid = false;
    firstInvalidId = "cmd-name";
  } else if (RESERVED_NAMES.has(name.toLowerCase())) {
    setFieldError("cmd-name", `「${name}」是内置命令名，请换一个`);
    valid = false;
    firstInvalidId = "cmd-name";
  } else if (allCommands.some((command) =>
    command.name === name && (editorMode === "create" || command.name !== editingOriginalName)
  )) {
    setFieldError("cmd-name", `命令「${name}」已存在，请直接编辑现有命令或换一个名字`);
    valid = false;
    firstInvalidId = "cmd-name";
  }

  if (!template.trim()) {
    setFieldError("cmd-template", "提示词模板不能为空");
    valid = false;
    if (!firstInvalidId) firstInvalidId = "cmd-template";
  } else if (template.length > MAX_TEMPLATE_CHARS) {
    setFieldError("cmd-template", `提示词模板不能超过 ${MAX_TEMPLATE_CHARS} 个字符`);
    valid = false;
    if (!firstInvalidId) firstInvalidId = "cmd-template";
  }

  if (!valid) {
    cmdStatus("请先修正表单中的错误", "err");
    (input(firstInvalidId) ?? textarea(firstInvalidId))?.focus();
  }
  return valid;
}

export async function saveCommandFromForm(): Promise<void> {
  if (editorMode === "closed" || saving || !validateForm()) return;
  const originalName = editingOriginalName;
  const wasEditing = editorMode === "edit";
  const payload = {
    name: valueOf("cmd-name").trim(),
    title: valueOf("cmd-title").trim() || undefined,
    description: valueOf("cmd-desc").trim() || undefined,
    template: valueOf("cmd-template"),
  };

  setSaving(true);
  try {
    const res = await api<{ command: UserCommandItem; created?: boolean; commands?: UserCommandItem[] }>(
      wasEditing ? `/api/commands/${encodeURIComponent(originalName)}` : "/api/commands",
      {
        method: wasEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    allCommands = res.commands ?? (wasEditing
      ? allCommands.map((command) => command.name === originalName ? res.command : command)
      : [...allCommands, res.command]);

    const refreshed = await loadUserCommands();
    if (refreshed.length || allCommands.length === 0) allCommands = refreshed;

    editorMode = "edit";
    editingOriginalName = res.command.name;
    searchTerm = "";
    const search = input("commands-search");
    if (search) search.value = "";
    fillEditor(res.command);
    renderCommandList();
    cmdStatus(
      res.created ? `已创建 /${res.command.name}，输入框敲 / 即可选到` : `已保存 /${res.command.name}`,
      "ok",
    );
  } catch (err) {
    cmdStatus(`保存失败：${(err as Error).message}`, "err");
  } finally {
    setSaving(false);
  }
}

async function deleteCommandCard(command: UserCommandItem, button: HTMLButtonElement): Promise<void> {
  if (saving) return;
  const editingThisCommand = editorMode === "edit" && editingOriginalName === command.name;
  const discardWarning = editingThisCommand && isEditorDirty() ? "\n当前未保存的修改也会丢失。" : "";
  const confirmed = await uiConfirm(`删除命令「/${command.name}」？${discardWarning}`, {
    title: "删除命令",
    okText: "删除",
    danger: true,
  });
  if (!confirmed) return;

  button.disabled = true;
  try {
    const res = await api<{ commands?: UserCommandItem[] }>(`/api/commands/${encodeURIComponent(command.name)}`, {
      method: "DELETE",
    });
    allCommands = res.commands ?? allCommands.filter((item) => item.name !== command.name);
    await loadUserCommands();
    if (editingThisCommand) collapseEditor();
    renderCommandList();
    cmdStatus(`已删除 /${command.name}`, "ok");
  } catch (err) {
    button.disabled = false;
    cmdStatus(`删除失败：${(err as Error).message}`, "err");
  }
}

function insertTemplateToken(token: string): void {
  const template = textarea("cmd-template");
  if (!template) return;
  const insert = `{{${token}}}`;
  const start = template.selectionStart ?? template.value.length;
  const end = template.selectionEnd ?? start;
  template.value = template.value.slice(0, start) + insert + template.value.slice(end);
  const next = start + insert.length;
  template.setSelectionRange(next, next);
  template.dispatchEvent(new Event("input", { bubbles: true }));
  template.focus();
}

/** 初始化设置页命令分区的事件；只在 main 启动时调用一次。 */
export function bindCommandSettings(): void {
  if (bound) return;
  bound = true;
  $("cmd-new-btn")?.addEventListener("click", () => { void openCreateEditor(); });
  $("cmd-empty-new-btn")?.addEventListener("click", () => { void openCreateEditor(); });
  $("cmd-editor-close")?.addEventListener("click", () => { void closeEditor(); });
  $("cmd-editor-cancel")?.addEventListener("click", () => { void closeEditor(); });
  input("commands-search")?.addEventListener("input", (event) => {
    searchTerm = (event.currentTarget as HTMLInputElement | null)?.value ?? "";
    renderCommandList();
  });
  input("cmd-name")?.addEventListener("input", () => clearFieldError("cmd-name"));
  textarea("cmd-template")?.addEventListener("input", () => {
    clearFieldError("cmd-template");
    syncTemplateCount();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-command-token]").forEach((button) => {
    button.addEventListener("click", () => insertTemplateToken(button.dataset.commandToken ?? ""));
  });
  $("command-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveCommandFromForm();
  });
  $("command-form")?.addEventListener("keydown", (event) => {
    const keyboard = event as KeyboardEvent;
    if ((keyboard.ctrlKey || keyboard.metaKey) && keyboard.key === "Enter") {
      event.preventDefault();
      void saveCommandFromForm();
    } else if (keyboard.key === "Escape") {
      event.preventDefault();
      void closeEditor();
    }
  });
}

/** 进入设置分区时重拉列表；编辑器停留在选择态，避免带出上次页面的输入。 */
export async function refreshCommands(): Promise<UserCommandItem[]> {
  const commands = await loadUserCommands();
  allCommands = commands;
  searchTerm = "";
  const search = input("commands-search");
  if (search) search.value = "";
  collapseEditor();
  cmdStatus("", "");
  return commands;
}
