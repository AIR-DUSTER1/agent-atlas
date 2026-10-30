/**
 * ============================================================
 * views/projects.ts — 项目文件夹（本地 / 云端 Git 仓库）
 * ============================================================
 * 菜单使用统一浮动层与安全 DOM 原语；项目图标来自 Lucide 白名单。
 * 删除项目后由服务端迁移会话，前端只重拉列表，避免本地状态猜测。
 */
import { $, desktopBridge, setSidebarOpen } from "../core/dom.js";
import { api, ApiError } from "../core/api.js";
import { saveLocal, state } from "../core/state.js";
import { uiAlert, uiConfirm, uiPrompt } from "../ui/dialog.js";
import { h } from "../ui/h.js";
import { icon, type IconName } from "../ui/icon.js";
import { openFloatingMenu, type MenuController } from "../ui/menu.js";
import { toast } from "../ui/toast.js";
import type { ProjectEntry } from "../modules/types.js";

let menuController: MenuController | null = null;

export function projectById(id: string | null): ProjectEntry | undefined {
  return state.projects.find((project) => project.id === id);
}

export function projectIcon(project: ProjectEntry | null | undefined): IconName {
  return project?.type === "cloud" ? "Globe" : "Folder";
}

/** 会话列表要跟着项目一起刷新：由 app 注入，避免 projects ↔ session-list 的循环依赖 */
let onProjectsChanged: () => void = () => {};
export function bindProjectsChanged(handler: () => void): void { onProjectsChanged = handler; }

export async function loadProjects(): Promise<void> {
  try {
    const data = await api<{ projects?: ProjectEntry[] }>("/api/projects");
    state.projects = data.projects || [];
    if (state.projectView !== "all" && !projectById(state.projectView)) state.projectView = "all";
    renderProjectSwitcher();
    onProjectsChanged();
  } catch { /* 服务重启等临时失败不阻塞主界面 */ }
}

export function showProjectMenu(show: boolean): void {
  const menu = $("project-menu");
  const anchor = $("project-btn");
  if (!menu || !anchor) return;
  if (!show) {
    menu.classList.add("hidden");
    menuController?.close(false);
    menuController = null;
    anchor.setAttribute("aria-expanded", "false");
    return;
  }
  anchor.setAttribute("aria-expanded", "true");
  menuController = openFloatingMenu({
    anchor,
    menu,
    align: "start",
    matchAnchorWidth: true,
    onClose: () => {
      menuController = null;
      menu.classList.add("hidden");
      anchor.setAttribute("aria-expanded", "false");
    },
  });
}

function chooseProject(projectId: string): void {
  state.projectView = projectId;
  saveLocal();
  showProjectMenu(false);
  setSidebarOpen(false);
  renderProjectSwitcher();
  onProjectsChanged();
}

export function renderProjectSwitcher(): void {
  const view = state.projectView;
  const active = view === "all" ? null : projectById(view);
  const iconHost = $("project-btn-icon");
  const textEl = $("project-btn-text");
  iconHost?.replaceChildren(icon(active ? projectIcon(active) : "FolderTree", { size: 15 }));
  if (textEl) textEl.textContent = active ? active.name : "全部项目";

  const menu = $("project-menu");
  if (!menu) return;
  menu.replaceChildren();
  menu.setAttribute("role", "menu");

  menu.appendChild(h("button", {
    type: "button",
    role: "menuitem",
    class: "pm-item" + (view === "all" ? " active" : ""),
    onclick: () => chooseProject("all"),
  },
  h("span", { class: "pm-ic" }, icon("FolderTree", { size: 15 })),
  h("span", { class: "pm-name" }, "全部项目"),
  h("span", { class: "pm-check" }, view === "all" ? "✓" : ""),
  ));

  for (const project of state.projects) {
    const select = h("button", {
      type: "button",
      role: "menuitem",
      class: "pm-select",
      title: project.name,
      onclick: () => chooseProject(project.id),
    },
    h("span", { class: "pm-ic" }, icon(projectIcon(project), { size: 15 })),
    h("span", { class: "pm-name" }, project.name),
    h("span", { class: `pm-sub ${project.type}` }, project.type === "cloud" ? "云端" : "本地"),
    );
    const item = h("div", { class: "pm-item pm-item-complex" + (view === project.id ? " active" : "") }, select);

    if (project.type === "cloud") {
      const refresh = h("button", {
        type: "button",
        class: "pm-x pm-refresh",
        title: "git pull 刷新缓存",
        "aria-label": `刷新 ${project.name}`,
        onclick: async (event: MouseEvent) => {
          event.stopPropagation();
          refresh.replaceChildren(icon("LoaderCircle", { size: 13, className: "spin" }));
          try {
            await api(`/api/projects/${project.id}/refresh`, { method: "POST" });
          } catch (err) {
            uiAlert(`刷新失败：${(err as Error).message}`, "刷新云端文件夹");
          }
          refresh.replaceChildren(icon("RefreshCw", { size: 13 }));
        },
      }, icon("RefreshCw", { size: 13 }));
      item.appendChild(refresh);
    }

    if (!project.builtin) {
      item.appendChild(h("button", {
        type: "button",
        class: "pm-x pm-del",
        title: "删除项目",
        "aria-label": `删除 ${project.name}`,
        onclick: async (event: MouseEvent) => {
          event.stopPropagation();
          const confirmed = await uiConfirm(
            `删除项目「${project.name}」？${project.type === "cloud" ? "\n云端缓存副本将一并删除。" : ""}\n其会话会归入「未归属」。`,
            { title: "删除项目", okText: "删除", danger: true },
          );
          if (!confirmed) return;
          try {
            await api(`/api/projects/${project.id}`, { method: "DELETE" });
            if (state.projectView === project.id) state.projectView = "all";
            saveLocal();
            await loadProjects();
          } catch (err) {
            uiAlert(`删除失败：${(err as Error).message}`, "删除项目");
          }
        },
      }, icon("X", { size: 13 })));
    }

    item.appendChild(h("span", { class: "pm-check" }, view === project.id ? "✓" : ""));
    menu.appendChild(item);
  }

  menu.appendChild(h("div", { class: "pm-divider" }));
  menu.appendChild(h("button", {
    type: "button",
    role: "menuitem",
    class: "pm-item pm-manage",
    onclick: () => { showProjectMenu(false); void addProjectFolder("local"); },
  }, icon("FolderOpen", { size: 15 }), h("span", null, "添加本地文件夹（系统选择）")));
  menu.appendChild(h("button", {
    type: "button",
    role: "menuitem",
    class: "pm-item pm-manage",
    onclick: () => { showProjectMenu(false); void addProjectFolder("cloud"); },
  }, icon("Globe", { size: 15 }), h("span", null, "添加云端文件夹（Git 仓库）")));
}

/** 优先用系统目录选择框取得绝对路径；无桌面环境时显式降级到手动输入。 */
export async function pickLocalProjectDirectory(): Promise<string | null> {
  const bridge = desktopBridge();
  let desktopError = "";
  if (bridge?.pickDirectory) {
    const picked = await bridge.pickDirectory();
    if (picked.path?.trim()) return picked.path.trim();
    if (picked.canceled && !picked.error) return null;
    desktopError = picked.error || "桌面端目录选择框没有返回路径";
  }

  try {
    const picked = await api<{ canceled?: boolean; path?: string }>("/api/projects/pick-directory", { method: "POST" });
    if (picked.canceled) return null;
    if (picked.path?.trim()) return picked.path.trim();
    throw new Error("系统目录选择框没有返回路径");
  } catch (err) {
    // 409 表示另一个请求已经打开系统对话框，不是能力缺失。此时弹手动输入
    // 会让用户误以为系统选择器坏了；提示其切回已存在的窗口即可。
    if (err instanceof ApiError && err.code === "DIRECTORY_PICKER_BUSY") {
      toast(err.message, "warning", { durationMs: 6500 });
      return null;
    }
    const reason = desktopError || (err as Error).message;
    const manual = await uiConfirm(
      `无法打开系统目录选择框：${reason}\n\n是否改为手动输入服务器绝对路径？`,
      { title: "添加本地文件夹", okText: "手动输入", cancelText: "取消" },
    );
    if (!manual) return null;
    const path = await uiPrompt(
      "输入服务器上的文件夹绝对路径：\n⚠ 这会把该目录暴露给网页端浏览，仅建议本地/可信环境使用",
      { title: "添加本地文件夹（服务器路径）", placeholder: "例如 E:\\study 或 /home/user/project" },
    );
    return typeof path === "string" && path.trim() ? path.trim() : null;
  }
}
let projectAddInFlight: Promise<void> | null = null;

/** 同一页面只允许一个项目添加流程，双击不会重复打开目录框或重复提交项目。 */
export function addProjectFolder(type: "local" | "cloud"): Promise<void> {
  if (projectAddInFlight) {
    toast("项目添加窗口已打开，请先完成当前操作", "info");
    return projectAddInFlight;
  }
  const task = addProjectFolderOnce(type).finally(() => {
    projectAddInFlight = null;
  });
  projectAddInFlight = task;
  return task;
}

async function addProjectFolderOnce(type: "local" | "cloud"): Promise<void> {
  let body: Record<string, unknown>;
  if (type === "cloud") {
    const url = await uiPrompt(
      "输入云端 Git 仓库地址（将自动 clone 到本地缓存）：\n例如 https://github.com/user/repo.git",
      { title: "添加云端文件夹（Git 仓库）", placeholder: "https://github.com/user/repo.git" },
    );
    if (typeof url !== "string" || !url.trim()) return;
    const name = await uiPrompt("项目显示名称（留空则取仓库名）：", {
      title: "添加云端文件夹（Git 仓库）",
      placeholder: "留空 = 取仓库名",
    });
    body = { type: "cloud", url: url.trim(), name: typeof name === "string" ? name.trim() || undefined : undefined };
  } else {
    const path = await pickLocalProjectDirectory();
    if (!path) return;
    body = { type: "local", path };
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
