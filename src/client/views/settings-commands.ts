/**
 * ============================================================
 * views/settings-commands.ts — 设置页「自定义命令」分区
 * ============================================================
 * 职责：命令列表渲染、新增/更新、删除；保存后同步刷新斜杠菜单缓存。
 * 设计立场：
 *  - 命令是纯提示词模板（不执行代码），所以允许用户自由编辑；
 *  - 保存/删除后立刻重拉 `/api/commands` 并刷新 composer 缓存 ——
 *    否则用户得刷新页面才能在斜杠菜单里看到新命令；
 *  - 列表骨架 innerHTML + 正文 textContent（命令内容由用户输入，不可信）。
 */

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { uiConfirm } from "../modules/ui-dialog.js";
import { loadUserCommands, type UserCommandItem } from "../composer/menu.js";

let cmdStatusTimer: ReturnType<typeof setTimeout> | undefined;

export function cmdStatus(text: string, cls: string): void {
  const el = $("commands-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  clearTimeout(cmdStatusTimer);
  if (text) {
    cmdStatusTimer = setTimeout(() => {
      if (el.textContent === text) { el.textContent = ""; el.className = "settings-status"; }
    }, 4000);
  }
}

function renderCommandList(commands: UserCommandItem[]): void {
  const list = $("commands-list");
  if (!list) return;
  list.innerHTML = "";
  if (!commands.length) {
    const empty = document.createElement("p");
    empty.className = "memories-empty";
    empty.textContent = "还没有自定义命令。在下面填命令名与提示词模板即可创建，之后在输入框敲「/」就能选到。";
    list.appendChild(empty);
    return;
  }
  for (const c of commands) {
    const row = document.createElement("div");
    row.className = "memory-item";
    row.innerHTML = `
      <div class="m-body">
        <div class="m-key"></div>
        <div class="m-content"></div>
        <div class="m-meta"></div>
      </div>
      <button class="p-del" title="删除这条命令">删除</button>`;
    const keyEl = row.querySelector(".m-key");
    if (keyEl) keyEl.textContent = `/${c.name}${c.title ? ` · ${c.title}` : ""}`;
    const contentEl = row.querySelector(".m-content");
    if (contentEl) contentEl.textContent = c.template.slice(0, 200).replace(/\n/g, " ");
    const metaEl = row.querySelector(".m-meta");
    if (metaEl) metaEl.textContent = c.description || `${c.template.length} 字符`;
    // 点行内任意处把该命令载入编辑区，便于改名/改模板
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".p-del")) return;
      setInput("cmd-name", c.name);
      setInput("cmd-title", c.title || "");
      setInput("cmd-desc", c.description || "");
      setInput("cmd-template", c.template);
      cmdStatus(`已载入 /${c.name}，修改后点「保存命令」覆盖`, "");
    });
    row.querySelector(".p-del")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!(await uiConfirm(`删除命令「/${c.name}」？`, { title: "删除命令", okText: "删除", danger: true }))) return;
      try {
        const res = await api<{ commands?: UserCommandItem[] }>(`/api/commands/${encodeURIComponent(c.name)}`, {
          method: "DELETE",
        });
        renderCommandList(res.commands || []);
        await loadUserCommands(); // 同步斜杠菜单
        cmdStatus("已删除", "ok");
      } catch (err) {
        cmdStatus(`✗ ${(err as Error).message}`, "err");
      }
    });
    list.appendChild(row);
  }
}

function setInput(id: string, value: string): void {
  const el = $(id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (el) el.value = value;
}

function inputValue(id: string): string {
  return (($(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value || "");
}

export async function refreshCommands(): Promise<UserCommandItem[]> {
  const commands = await loadUserCommands();
  renderCommandList(commands);
  return commands;
}

export async function saveCommandFromForm(): Promise<void> {
  const name = inputValue("cmd-name").trim();
  const template = inputValue("cmd-template");
  if (!name) { cmdStatus("命令名不能为空", "err"); return; }
  if (!template.trim()) { cmdStatus("提示词模板不能为空", "err"); return; }
  try {
    const res = await api<{ command: UserCommandItem; created?: boolean; commands?: UserCommandItem[] }>(
      "/api/commands",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          title: inputValue("cmd-title").trim() || undefined,
          description: inputValue("cmd-desc").trim() || undefined,
          template,
        }),
      }
    );
    renderCommandList(res.commands || []);
    await loadUserCommands(); // 让斜杠菜单立即能搜到
    setInput("cmd-name", "");
    setInput("cmd-title", "");
    setInput("cmd-desc", "");
    setInput("cmd-template", "");
    cmdStatus(res.created ? `✓ 已创建 /${res.command.name}（输入框敲 / 即可选到）` : `✓ 已更新 /${res.command.name}`, "ok");
  } catch (err) {
    cmdStatus(`✗ ${(err as Error).message}`, "err");
  }
}
