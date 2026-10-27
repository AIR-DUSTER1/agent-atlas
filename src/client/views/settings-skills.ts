/**
 * ============================================================
 * views/settings-skills.ts — 设置页「技能库」分区
 * ============================================================
 * 职责：技能列表渲染、新增/更新、删除；显示技能目录位置便于用户直接编辑文件。
 * 设计立场：
 *  - 技能是纯 markdown 文档（不执行），所以设置页给的编辑器只是便利，
 *    用户完全可以直接改 .setting/skills/*.md —— 因此面板里显示目录路径；
 *  - 触发关键词用逗号分隔的文本框（比数组 UI 简单，用户也更好复制粘贴）；
 *  - 列表骨架 innerHTML + 正文 textContent（技能内容由用户/模型写入，不可信）。
 */

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { uiConfirm } from "../ui/dialog.js";

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  body: string;
}

let skillStatusTimer: ReturnType<typeof setTimeout> | undefined;

function skillStatus(text: string, cls: string): void {
  const el = $("skills-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  clearTimeout(skillStatusTimer);
  if (text) {
    skillStatusTimer = setTimeout(() => {
      if (el.textContent === text) { el.textContent = ""; el.className = "settings-status"; }
    }, 4000);
  }
}

function renderSkillList(skills: SkillItem[]): void {
  const list = $("skills-list");
  if (!list) return;
  list.innerHTML = "";
  if (!skills.length) {
    const empty = document.createElement("p");
    empty.className = "memories-empty";
    empty.textContent = "还没有技能。在下面填写标识、触发关键词和正文即可创建；也可以直接把 .md 文件放进技能目录。";
    list.appendChild(empty);
    return;
  }
  for (const s of skills) {
    const row = document.createElement("div");
    row.className = "memory-item";
    row.innerHTML = `
      <div class="m-body">
        <div class="m-key"></div>
        <div class="m-content"></div>
        <div class="m-meta"></div>
      </div>
      <button class="p-del" title="删除这个技能">删除</button>`;
    const keyEl = row.querySelector(".m-key");
    if (keyEl) keyEl.textContent = `${s.name}（${s.id}.md）`;
    const contentEl = row.querySelector(".m-content");
    if (contentEl) contentEl.textContent = s.description || s.body.slice(0, 120).replace(/\n/g, " ");
    const metaEl = row.querySelector(".m-meta");
    if (metaEl) {
      metaEl.textContent = s.triggers.length
        ? `触发词：${s.triggers.join("、")} · ${s.body.length} 字符`
        : `无触发词（只能手动指定）· ${s.body.length} 字符`;
    }
    // 点击载入编辑区
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".p-del")) return;
      setInput("skill-id", s.id);
      setInput("skill-name", s.name === s.id ? "" : s.name);
      setInput("skill-desc", s.description);
      setInput("skill-triggers", s.triggers.join(", "));
      setInput("skill-body", s.body);
      skillStatus(`已载入「${s.name}」，修改后点「保存技能」覆盖`, "");
    });
    row.querySelector(".p-del")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!(await uiConfirm(`删除技能「${s.name}」？这会删掉 .setting/skills/${s.id}.md`, {
        title: "删除技能", okText: "删除", danger: true,
      }))) return;
      try {
        const res = await api<{ skills?: SkillItem[] }>(`/api/skills/${encodeURIComponent(s.id)}`, {
          method: "DELETE",
        });
        renderSkillList(res.skills || []);
        skillStatus("已删除", "ok");
      } catch (err) {
        skillStatus(`✗ ${(err as Error).message}`, "err");
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

export async function refreshSkills(): Promise<SkillItem[]> {
  const data = await api<{ skills?: SkillItem[]; dir?: string }>("/api/skills");
  renderSkillList(data.skills || []);
  const dirEl = $("skills-dir");
  if (dirEl && data.dir) dirEl.textContent = `· 目录 ${data.dir}`;
  return data.skills || [];
}

export async function saveSkillFromForm(): Promise<void> {
  const id = inputValue("skill-id").trim();
  const body = inputValue("skill-body");
  if (!id) { skillStatus("技能标识（文件名）不能为空", "err"); return; }
  if (!body.trim()) { skillStatus("技能正文不能为空", "err"); return; }
  try {
    const res = await api<{ skill: SkillItem; created?: boolean; skills?: SkillItem[] }>("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        name: inputValue("skill-name").trim() || undefined,
        description: inputValue("skill-desc").trim() || undefined,
        triggers: inputValue("skill-triggers"),
        body,
      }),
    });
    renderSkillList(res.skills || []);
    setInput("skill-id", "");
    setInput("skill-name", "");
    setInput("skill-desc", "");
    setInput("skill-triggers", "");
    setInput("skill-body", "");
    skillStatus(res.created ? `✓ 已创建技能「${res.skill.name}」` : `✓ 已更新技能「${res.skill.name}」`, "ok");
  } catch (err) {
    skillStatus(`✗ ${(err as Error).message}`, "err");
  }
}
