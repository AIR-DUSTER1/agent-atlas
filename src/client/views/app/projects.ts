/**
 * ============================================================
 * views/projects.ts — 项目文件夹：数据与副作用（M4 批次 4.4 起）
 * ============================================================
 * 切换器渲染已迁往 Vue（project-switcher-vue.vue + stores/projects.ts）；
 * 本文件保留全部「行为」职责：
 *  1. 列表拉取与竞态守卫（晚到的过期响应必须丢弃）；
 *  2. 添加本地 / 云端项目的完整流程（系统目录框、降级手输、单飞锁）；
 *  3. 选中 / 刷新云端 / 删除项目的副作用与确认对话；
 *  4. 菜单开合（ui/menu.ts 浮动控制器）与命令面注册。
 * 渲染数据经 window 通道推给 Vue（bundle 与 1:1 副本是两个模块实例，
 * 各有独立 pinia），本模块静态依赖图保持纯 .ts。
 */
import { $, desktopBridge, setSidebarOpen } from "../../core/dom.js";
import { api, ApiError } from "../../core/api.js";
import { saveLocal, state } from "../../core/state.js";
import { uiAlert, uiConfirm, uiPrompt } from "../../ui/dialog.js";
import { openFloatingMenu, type MenuController } from "../../ui/menu.js";
import { toast } from "../../ui/toast.js";
import { PROJECT_VIEW_ALL, PROJECT_VIEW_NONE } from "../../modules/project-view.js";
import type { ProjectEntry } from "../../modules/types.js";

let menuController: MenuController | null = null;

export function projectById(id: string | null): ProjectEntry | undefined {
  return state.projects.find((project) => project.id === id);
}

/** 会话列表要跟着项目一起刷新：由 app 注入，避免 projects ↔ session-list 的循环依赖 */
let onProjectsChanged: () => void = () => {};
export function bindProjectsChanged(handler: () => void): void { onProjectsChanged = handler; }

/** 通知 Vue 侧重新同步（core state 已更新后调用）。 */
function notifyProjectsChanged(): void {
  for (const listener of window.__agentatlasProjectListeners ?? []) listener();
}

/**
 * 拉取项目列表并刷新切换器。
 *
 * 竞态防护（真实 bug，非测试问题）：「点击项目按钮」会 await 一次本函数，
 * 若此时用户紧接着点了「添加本地文件夹」，添加流程先回来并设好 projectView，
 * 而这次**更早发出、更晚返回**的列表响应里还没有新项目 —— 守卫会把刚选中的
 * 项目重置成「全部项目」，localStorage 也不写入。表现是「加完项目又跳回全部」。
 *
 * 对策：只重置「确实已不存在」的 view，并且**忽略晚到的过期响应**（用序号判断）。
 */
let projectsRequestSeq = 0;

export async function loadProjects(): Promise<void> {
  const seq = ++projectsRequestSeq;
  try {
    const data = await api<{ projects?: ProjectEntry[] }>("/api/projects");
    // 有更新的请求已经发出（或已完成），本次结果作废，避免旧列表覆盖新状态。
    if (seq !== projectsRequestSeq) return;
    state.projects = data.projects || [];
    if (state.projectView !== PROJECT_VIEW_ALL && state.projectView !== PROJECT_VIEW_NONE && !projectById(state.projectView)) state.projectView = PROJECT_VIEW_ALL;
    renderProjectSwitcher();
  } catch { /* 服务重启等临时失败不阻塞主界面 */ }
}

/** 添加/删除项目后直接写入权威结果，同时作废仍在飞行中的旧列表请求。 */
export function applyProjectList(projects: ProjectEntry[], view?: string): void {
  projectsRequestSeq += 1;
  state.projects = projects;
  if (view !== undefined) state.projectView = view;
  saveLocal();
  renderProjectSwitcher();
}

/** 把 core state 的项目数据同步给 Vue 切换器（幂等挂载 + 通知重算）。 */
export function renderProjectSwitcher(): void {
  void import("./project-switcher-vue.js")
    .then((m) => m.mountProjectSwitcherVue())
    .catch(() => {});
  notifyProjectsChanged();
  onProjectsChanged();
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
  // Vue 侧同步 + 会话列表刷新
  notifyProjectsChanged();
  onProjectsChanged();
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
    // 用服务端返回的权威列表直接落状态，并作废仍在飞行中的旧列表请求，
    // 否则「点开菜单时发出的那次 loadProjects」稍后返回会把新项目抹掉。
    applyProjectList(res.projects, res.project.id);
  } catch (err) {
    uiAlert(`${type === "cloud" ? "云端仓库" : "本地文件夹"}添加失败：${(err as Error).message}`, "添加项目");
  }
}

/** 刷新云端项目的本地缓存（git pull）。 */
async function refreshCloudProject(project: ProjectEntry): Promise<void> {
  try {
    await api(`/api/projects/${project.id}/refresh`, { method: "POST" });
  } catch (err) {
    uiAlert(`刷新失败：${(err as Error).message}`, "刷新云端文件夹");
  }
}

/** 删除项目（云端副本一并删除；其会话归入「未归属」）。 */
async function removeProject(project: ProjectEntry): Promise<void> {
  const confirmed = await uiConfirm(
    `删除项目「${project.name}」？${project.type === "cloud" ? "\n云端缓存副本将一并删除。" : ""}\n其会话会归入「未归属」。`,
    { title: "删除项目", okText: "删除", danger: true },
  );
  if (!confirmed) return;
  try {
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
    if (state.projectView === project.id) state.projectView = PROJECT_VIEW_ALL;
    saveLocal();
    await loadProjects();
  } catch (err) {
    uiAlert(`删除失败：${(err as Error).message}`, "删除项目");
  }
}

/** 注册组件命令面：Vue 只发意图，副作用与确认对话都在这里。 */
export function bindProjectCommands(): void {
  window.__agentatlasProjectCommands = {
    choose: (view) => { chooseProject(view); },
    addLocal: () => { showProjectMenu(false); void addProjectFolder("local"); },
    addCloud: () => { showProjectMenu(false); void addProjectFolder("cloud"); },
    refreshCloud: (id) => {
      const project = projectById(id);
      if (project) void refreshCloudProject(project);
    },
    remove: (id) => {
      const project = projectById(id);
      if (project) void removeProject(project);
    },
  };
  renderProjectSwitcher();
}
