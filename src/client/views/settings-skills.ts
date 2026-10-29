/**
 * ============================================================
 * views/settings-skills.ts — 设置页「技能」分区
 * ============================================================
 * 职责：搜索、筛选、分页、上传、启停、编辑与删除技能。
 * 设计立场：
 *  - 页面以技能卡片为主，上传/创建是主操作，设置表单默认折叠；
 *  - 筛选只使用真实能力（全部 / 已启用 / 已禁用），不伪造项目级技能；
 *  - 启停状态写入 frontmatter，外部编辑和重启后保持一致。
 */
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { uiConfirm } from "../ui/dialog.js";

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  enabled: boolean;
  body: string;
}

type SkillFilter = "all" | "enabled" | "disabled";

interface SkillListResponse {
  skills?: SkillItem[];
  dir?: string;
}

interface SkillImportResponse extends SkillListResponse {
  imported?: string[];
  overwritten?: string[];
}

const MAX_SKILL_FILE_BYTES = 200_000;
const SKILLS_PER_PAGE = 5;
let allSkills: SkillItem[] = [];
let currentFilter: SkillFilter = "all";
let searchQuery = "";
let currentPage = 1;
let currentEditingId: string | null = null;
let skillStatusTimer: ReturnType<typeof setTimeout> | undefined;

export function showSkillStatus(text: string, cls: string): void {
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

function updateSkillCounts(filteredCount: number): void {
  const enabled = allSkills.filter((skill) => skill.enabled).length;
  const disabled = allSkills.length - enabled;
  const all = $("skills-count-all");
  const enabledEl = $("skills-count-enabled");
  const disabledEl = $("skills-count-disabled");
  if (all) all.textContent = String(allSkills.length);
  if (enabledEl) enabledEl.textContent = String(enabled);
  if (disabledEl) disabledEl.textContent = String(disabled);
  const summary = $("skills-count");
  if (summary) summary.textContent = filteredCount === allSkills.length
    ? `共 ${allSkills.length} 个技能`
    : `共 ${allSkills.length} 个技能 · 当前显示 ${filteredCount} 个`;
}

function syncFilterTabs(): void {
  document.querySelectorAll<HTMLElement>("[data-skill-filter]").forEach((button) => {
    const active = button.dataset.skillFilter === currentFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

function visibleSkills(): SkillItem[] {
  const term = searchQuery.trim().toLowerCase();
  return allSkills
    .filter((skill) => currentFilter === "all" || (currentFilter === "enabled" ? skill.enabled : !skill.enabled))
    .filter((skill) => !term || [skill.id, skill.name, skill.description, ...skill.triggers]
      .some((value) => value.toLowerCase().includes(term)))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, "zh-CN"));
}

function pageTokens(current: number, total: number): Array<number | "ellipsis"> {
  const pages = new Set([1, total, current - 1, current, current + 1]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const tokens: Array<number | "ellipsis"> = [];
  for (const page of sorted) {
    const previous = tokens.at(-1);
    if (typeof previous === "number" && page - previous > 1) tokens.push("ellipsis");
    tokens.push(page);
  }
  return tokens;
}

function renderPagination(totalPages: number): void {
  const nav = $("skills-pagination");
  if (!nav) return;
  nav.replaceChildren();
  nav.classList.toggle("hidden", totalPages <= 1);
  if (totalPages <= 1) return;

  const addButton = (label: string, page: number, active = false, disabled = false): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "skills-page-btn" + (active ? " active" : "");
    button.textContent = label;
    button.disabled = disabled;
    button.setAttribute("aria-label", `第 ${page} 页`);
    if (active) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => {
      currentPage = page;
      renderSkillCards();
    });
    nav.appendChild(button);
  };

  addButton("‹", currentPage - 1, false, currentPage <= 1);
  for (const token of pageTokens(currentPage, totalPages)) {
    if (token === "ellipsis") {
      const ellipsis = document.createElement("span");
      ellipsis.className = "skills-page-ellipsis";
      ellipsis.textContent = "…";
      nav.appendChild(ellipsis);
    } else {
      addButton(String(token), token, token === currentPage);
    }
  }
  addButton("›", currentPage + 1, false, currentPage >= totalPages);
}

function createSkillCard(skill: SkillItem): HTMLElement {
  const card = document.createElement("article");
  card.className = "skill-card" + (skill.enabled ? "" : " disabled");
  card.dataset.skillId = skill.id;
  card.innerHTML = `
    <div class="skill-card-icon"><i class="ui-icon" data-icon="BookOpen" aria-hidden="true"></i></div>
    <div class="skill-card-body">
      <div class="skill-card-title-row">
        <h3 class="skill-card-name"></h3>
        <span class="skill-card-kind">Markdown</span>
      </div>
      <p class="skill-card-desc"></p>
      <div class="skill-card-meta"></div>
    </div>
    <div class="skill-card-actions">
      <label class="skill-switch" title="启用或禁用技能">
        <input class="skill-enabled-toggle" type="checkbox" />
        <span class="skill-switch-track" aria-hidden="true"></span>
      </label>
      <button class="skill-settings-btn" type="button" title="编辑技能" aria-label="编辑技能">
        <i class="ui-icon" data-icon="Settings" aria-hidden="true"></i>
      </button>
    </div>`;

  const name = card.querySelector(".skill-card-name");
  if (name) name.textContent = skill.name;
  const description = card.querySelector(".skill-card-desc");
  if (description) description.textContent = skill.description || skill.body.slice(0, 180).replace(/\n/g, " ");
  const meta = card.querySelector(".skill-card-meta");
  if (meta) {
    const triggerText = skill.triggers.length ? `触发：${skill.triggers.join("、")}` : "名称触发";
    meta.textContent = `${skill.enabled ? "已启用" : "已禁用"} · ${triggerText} · ${skill.body.length} 字符`;
  }

  const toggle = card.querySelector<HTMLInputElement>(".skill-enabled-toggle");
  if (toggle) {
    toggle.checked = skill.enabled;
    toggle.setAttribute("aria-label", `启用技能 ${skill.name}`);
    toggle.addEventListener("change", () => { void updateSkillEnabled(skill, toggle); });
  }
  const settingsButton = card.querySelector<HTMLButtonElement>(".skill-settings-btn");
  if (settingsButton) {
    settingsButton.setAttribute("aria-label", `编辑技能 ${skill.name}`);
    settingsButton.addEventListener("click", () => openSkillEditor(skill));
  }
  return card;
}

function renderSkillCards(): void {
  const filtered = visibleSkills();
  const totalPages = Math.max(1, Math.ceil(filtered.length / SKILLS_PER_PAGE));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * SKILLS_PER_PAGE;
  const pageItems = filtered.slice(start, start + SKILLS_PER_PAGE);
  const list = $("skills-list");
  if (!list) return;
  list.replaceChildren();

  if (!pageItems.length) {
    const empty = document.createElement("div");
    empty.className = "skills-empty-state";
    const icon = document.createElement("i");
    icon.className = "ui-icon";
    icon.dataset.icon = searchQuery || currentFilter !== "all" ? "Search" : "BookOpen";
    const title = document.createElement("h3");
    title.textContent = searchQuery || currentFilter !== "all" ? "没有匹配的技能" : "还没有技能";
    const hint = document.createElement("p");
    hint.textContent = searchQuery || currentFilter !== "all"
      ? "调整搜索词或切换到「全部」查看其他技能。"
      : "点击「上传技能」导入 .md 文件，或使用「创建」手动添加。";
    empty.append(icon, title, hint);
    list.appendChild(empty);
  } else {
    for (const skill of pageItems) list.appendChild(createSkillCard(skill));
  }

  updateSkillCounts(filtered.length);
  renderPagination(totalPages);
}

function renderSkillList(skills: SkillItem[]): void {
  allSkills = skills;
  syncFilterTabs();
  renderSkillCards();
}

async function updateSkillEnabled(skill: SkillItem, toggle: HTMLInputElement): Promise<void> {
  const next = toggle.checked;
  toggle.disabled = true;
  try {
    const res = await api<{ skill: SkillItem; skills?: SkillItem[] }>(
      `/api/skills/${encodeURIComponent(skill.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      }
    );
    Object.assign(skill, res.skill);
    allSkills = res.skills || allSkills.map((item) => item.id === skill.id ? skill : item);
    showSkillStatus(`${skill.enabled ? "已启用" : "已禁用"}技能「${skill.name}」`, "ok");
    renderSkillCards();
  } catch (err) {
    toggle.checked = !next;
    toggle.disabled = false;
    showSkillStatus(`✗ ${(err as Error).message}`, "err");
  }
}

function setEditorSummary(text: string): void {
  const summary = $("skill-editor-details")?.querySelector("summary");
  if (summary) summary.textContent = text;
}

export function openSkillEditor(skill: SkillItem): void {
  currentEditingId = skill.id;
  const details = $("skill-editor-details") as HTMLDetailsElement | null;
  if (details) details.open = true;
  setInput("skill-id", skill.id);
  setInput("skill-name", skill.name === skill.id ? "" : skill.name);
  setInput("skill-desc", skill.description);
  setInput("skill-triggers", skill.triggers.join(", "));
  setInput("skill-body", skill.body);
  $("skill-delete-btn")?.classList.remove("hidden");
  setEditorSummary(`编辑技能 · ${skill.name}`);
  details?.scrollIntoView({ block: "nearest" });
  requestAnimationFrame(() => ($("skill-id") as HTMLInputElement | null)?.focus());
}

export function openNewSkillForm(): void {
  clearSkillForm();
  const details = $("skill-editor-details") as HTMLDetailsElement | null;
  if (details) details.open = true;
  setEditorSummary("新建技能");
  details?.scrollIntoView({ block: "nearest" });
  requestAnimationFrame(() => ($("skill-id") as HTMLInputElement | null)?.focus());
}

function setInput(id: string, value: string): void {
  const el = $(id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (el) el.value = value;
}

function inputValue(id: string): string {
  return (($(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value || "");
}

export function clearSkillForm(): void {
  currentEditingId = null;
  setInput("skill-id", "");
  setInput("skill-name", "");
  setInput("skill-desc", "");
  setInput("skill-triggers", "");
  setInput("skill-body", "");
  $("skill-delete-btn")?.classList.add("hidden");
  setEditorSummary("手动新增 / 编辑技能");
}

export function filterSkills(query: string): void {
  searchQuery = query;
  currentPage = 1;
  renderSkillCards();
}

export function setSkillFilter(filter: string): void {
  if (filter !== "all" && filter !== "enabled" && filter !== "disabled") return;
  currentFilter = filter;
  currentPage = 1;
  syncFilterTabs();
  renderSkillCards();
}

export async function refreshSkills(): Promise<SkillItem[]> {
  const refresh = $("skills-refresh-btn") as HTMLButtonElement | null;
  if (refresh) refresh.disabled = true;
  try {
    const data = await api<SkillListResponse>("/api/skills");
    renderSkillList(data.skills || []);
    const dirEl = $("skills-dir");
    if (dirEl && data.dir) {
      dirEl.textContent = `目录 ${data.dir}`;
      dirEl.title = data.dir;
    }
    return data.skills || [];
  } finally {
    if (refresh) refresh.disabled = false;
  }
}

function uploadId(filename: string): string {
  const base = filename.replaceAll("\\", "/").split("/").pop() || filename;
  return base.replace(/\.(md|markdown)$/i, "").toLowerCase();
}

/** 浏览器读取文件文本后走 JSON 导入；同名技能会在覆盖前弹一次确认。 */
export async function importSkillsFromFiles(files: FileList | null): Promise<void> {
  const input = $("skill-upload-file") as HTMLInputElement | null;
  if (!files?.length) return;
  const selected = [...files];
  try {
    const oversized = selected.find((file) => file.size > MAX_SKILL_FILE_BYTES);
    if (oversized) throw new Error(`「${oversized.name}」超过 200KB`);
    const payloads = await Promise.all(selected.map(async (file) => ({
      name: file.name,
      content: await file.text(),
    })));
    const incomingIds = new Set(payloads.map((file) => uploadId(file.name)));
    const conflicts = allSkills.filter((skill) => incomingIds.has(skill.id.toLowerCase()));
    const overwrite = conflicts.length
      ? await uiConfirm(`以下技能已存在，是否覆盖？\n${conflicts.map((skill) => skill.name).join("、")}`, {
          title: "覆盖已有技能", okText: "覆盖", danger: true,
        })
      : false;
    if (conflicts.length && !overwrite) {
      showSkillStatus("已取消覆盖，现有技能未修改", "");
      return;
    }

    const res = await api<SkillImportResponse>("/api/skills/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: payloads, overwrite }),
    });
    currentFilter = "all";
    searchQuery = "";
    currentPage = 1;
    const search = $("skills-search") as HTMLInputElement | null;
    if (search) search.value = "";
    renderSkillList(res.skills || []);
    const imported = res.imported?.length || 0;
    const overwritten = res.overwritten?.length || 0;
    showSkillStatus(`✓ 已导入 ${imported} 个，覆盖 ${overwritten} 个`, "ok");
  } catch (err) {
    showSkillStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    if (input) input.value = "";
  }
}

export async function saveSkillFromForm(): Promise<void> {
  const id = inputValue("skill-id").trim();
  const body = inputValue("skill-body");
  if (!id) { showSkillStatus("技能标识（文件名）不能为空", "err"); return; }
  if (!body.trim()) { showSkillStatus("技能正文不能为空", "err"); return; }
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
    clearSkillForm();
    const details = $("skill-editor-details") as HTMLDetailsElement | null;
    if (details) details.open = false;
    showSkillStatus(res.created ? `✓ 已创建技能「${res.skill.name}」` : `✓ 已更新技能「${res.skill.name}」`, "ok");
  } catch (err) {
    showSkillStatus(`✗ ${(err as Error).message}`, "err");
  }
}

export async function deleteSkillFromEditor(): Promise<void> {
  const skill = allSkills.find((item) => item.id === currentEditingId);
  if (!skill) { showSkillStatus("请先选择要删除的技能", "err"); return; }
  if (!(await uiConfirm(`删除技能「${skill.name}」？这会删掉 .setting/skills/${skill.id}.md`, {
    title: "删除技能", okText: "删除", danger: true,
  }))) return;
  try {
    const res = await api<SkillListResponse>(`/api/skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" });
    renderSkillList(res.skills || []);
    clearSkillForm();
    const details = $("skill-editor-details") as HTMLDetailsElement | null;
    if (details) details.open = false;
    showSkillStatus(`已删除技能「${skill.name}」`, "ok");
  } catch (err) {
    showSkillStatus(`✗ ${(err as Error).message}`, "err");
  }
}