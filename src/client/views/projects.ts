/**
 * ============================================================
 * views/projects.ts — 项目文件夹（本地 💻 / 云端 ☁️ Git 仓库）
 * ============================================================
 * 职责：项目下拉菜单的渲染、切换、添加/删除/刷新云端缓存。
 * 设计立场：
 *  - projectView 决定侧栏过滤与新建会话归属，写回 localStorage 与 state 同步；
 *  - 菜单项正文一律 textContent 填充，只有骨架用 innerHTML（防注入）；
 *  - 删除项目由服务端把它的会话迁到默认项目，前端只负责重拉列表。
 */

import { $, setSidebarOpen } from "../core/dom.js";
import { api } from "../core/api.js";
import { saveLocal, state } from "../core/state.js";
import { uiAlert, uiConfirm, uiPrompt } from "../ui/dialog.js";
import type { ProjectEntry } from "../modules/types.js";

export function projectById(id: string | null): ProjectEntry | undefined {
  return state.projects.find((p) => p.id === id);
}

export function projectIcon(p: ProjectEntry | null | undefined): string {
  return p?.type === "cloud" ? "☁️" : "📁";
}

/** 会话列表要跟着项目一起刷新：由 app 注入，避免 projects ↔ session-list 的循环依赖 */
let onProjectsChanged: () => void = () => {};

export function bindProjectsChanged(handler: () => void): void {
  onProjectsChanged = handler;
}

export async function loadProjects(): Promise<void> {
  try {
    const data = await api<{ projects?: ProjectEntry[] }>("/api/projects");
    state.projects = data.projects || [];
    if (state.projectView !== "all" && !projectById(state.projectView)) state.projectView = "all";
    renderProjectSwitcher();
    onProjectsChanged();
  } catch { /* 服务重启等 */ }
}

export function showProjectMenu(show: boolean): void {
  $("project-menu")?.classList.toggle("hidden", !show);
}

export function renderProjectSwitcher(): void {
  const view = state.projectView;
  const active = view === "all" ? null : projectById(view);
  const iconEl = $("project-btn-icon");
  const textEl = $("project-btn-text");
  if (iconEl) iconEl.textContent = active ? projectIcon(active) : "🗂";
  if (textEl) textEl.textContent = active ? active.name : "全部项目";

  const menu = $("project-menu");
  if (!menu) return;
  menu.innerHTML = "";

  const all = document.createElement("button");
  all.className = "pm-item" + (view === "all" ? " active" : "");
  all.innerHTML = `<span class="pm-ic">🗂</span><span>全部项目</span><span class="pm-check">${view === "all" ? "✓" : ""}</span>`;
  all.addEventListener("click", () => {
    state.projectView = "all";
    saveLocal();
    showProjectMenu(false);
    setSidebarOpen(false);
    renderProjectSwitcher();
    onProjectsChanged();
  });
  menu.appendChild(all);

  for (const p of state.projects) {
    const item = document.createElement("div");
    item.className = "pm-item" + (view === p.id ? " active" : "");
    item.style.display = "flex";
    item.innerHTML = `
      <span class="pm-ic">${projectIcon(p)}</span>
      <span class="pm-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
      <span class="pm-sub ${p.type}">${p.type === "cloud" ? "云端" : "本地"}</span>
      ${p.type === "cloud" ? '<button class="pm-x pm-refresh" title="git pull 刷新缓存">⟳</button>' : ""}
      ${p.builtin ? "" : '<button class="pm-x pm-del" title="删除项目">✕</button>'}
      <span class="pm-check">${view === p.id ? "✓" : ""}</span>`;
    const nameEl = item.querySelector(".pm-name");
    if (nameEl) nameEl.textContent = p.name;
    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".pm-x")) return; // 删除/刷新按钮单独处理
      state.projectView = p.id;
      saveLocal();
      showProjectMenu(false);
      setSidebarOpen(false); // 窄屏抽屉：选中项目即收起
      renderProjectSwitcher();
      onProjectsChanged();
    });
    const refresh = item.querySelector<HTMLElement>(".pm-refresh");
    if (refresh) refresh.addEventListener("click", async (e) => {
      e.stopPropagation();
      refresh.textContent = "…";
      try {
        await api(`/api/projects/${p.id}/refresh`, { method: "POST" });
      } catch (err) { uiAlert(`刷新失败：${(err as Error).message}`, "刷新云端文件夹"); }
      refresh.textContent = "⟳";
    });
    const del = item.querySelector<HTMLElement>(".pm-del");
    if (del) del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await uiConfirm(
        `删除项目「${p.name}」？${p.type === "cloud" ? "\n云端缓存副本将一并删除。" : ""}\n其会话会迁移到 learn-agent 项目。`,
        { title: "删除项目", okText: "删除", danger: true }
      );
      if (!ok) return;
      try {
        await api(`/api/projects/${p.id}`, { method: "DELETE" });
        await loadProjects();
        if (state.projectView === p.id) { state.projectView = "all"; saveLocal(); }
        renderProjectSwitcher();
        onProjectsChanged();
      } catch (err) { uiAlert(`删除失败：${(err as Error).message}`, "删除项目"); }
    });
    menu.appendChild(item);
  }

  const divider = document.createElement("div");
  divider.className = "pm-divider";
  menu.appendChild(divider);

  const addLocal = document.createElement("button");
  addLocal.className = "pm-item pm-manage";
  addLocal.textContent = "💻 添加本地文件夹（服务器路径）";
  addLocal.addEventListener("click", () => { showProjectMenu(false); void addProjectFolder("local"); });
  menu.appendChild(addLocal);

  const addCloud = document.createElement("button");
  addCloud.className = "pm-item pm-manage";
  addCloud.textContent = "☁️ 添加云端文件夹（Git 仓库）";
  addCloud.addEventListener("click", () => { showProjectMenu(false); void addProjectFolder("cloud"); });
  menu.appendChild(addCloud);
}

export async function addProjectFolder(type: "local" | "cloud"): Promise<void> {
  let body: Record<string, unknown>;
  if (type === "cloud") {
    const url = await uiPrompt(
      "输入云端 Git 仓库地址（将自动 clone 到本地缓存）：\n例如 https://github.com/user/repo.git",
      { title: "添加云端文件夹（Git 仓库）", placeholder: "https://github.com/user/repo.git" }
    );
    if (typeof url !== "string" || !url.trim()) return;
    const name = await uiPrompt("项目显示名称（留空则取仓库名）：", {
      title: "添加云端文件夹（Git 仓库）",
      placeholder: "留空 = 取仓库名",
    });
    body = { type: "cloud", url: url.trim(), name: typeof name === "string" ? name.trim() || undefined : undefined };
  } else {
    const path = await uiPrompt(
      "输入服务器上的文件夹绝对路径：\n⚠ 这会把该目录暴露给网页端浏览，仅建议本地/可信环境使用",
      { title: "添加本地文件夹（服务器路径）", placeholder: "例如 E:\\study 或 /home/user/project" }
    );
    if (typeof path !== "string" || !path.trim()) return;
    body = { type: "local", path: path.trim() };
  }
  try {
    const res = await api<{ projects: ProjectEntry[]; project: ProjectEntry }>("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    state.projects = res.projects;
    state.projectView = res.project.id;
    saveLocal();
    renderProjectSwitcher();
    onProjectsChanged();
  } catch (err) {
    uiAlert(`${type === "cloud" ? "云端仓库" : "本地文件夹"}添加失败：${(err as Error).message}`, "添加项目");
  }
}
