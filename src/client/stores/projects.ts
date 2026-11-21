/**
 * ============================================================
 * stores/projects.ts — 项目文件夹切换器（框架迁移 M4 批次 4.4）
 * ============================================================
 * 职责：项目列表、当前视图（全部 / 不选择 / 具体项目）与切换器的展示派生。
 * 设计立场：
 *  - 项目列表仍以 core state（state.projects / state.projectView）为持久源，
 *    store 是它的响应式镜像（saveLocal 与其它 legacy 消费方继续读 core state）；
 *  - 「点开菜单时发出的列表请求晚返回」的竞态守卫在 legacy 桥里（序号比较），
 *    store 只接收权威结果；
 *  - 图标名与按钮文案由 getters 统一派生，模板不再判断 noProject/active；
 *  - 菜单开合由 ui/menu.ts 浮动控制器管 hidden 类（组件不绑定 class，
 *    否则重渲染会把控制器的开合状态打回去）。
 */
import { defineStore } from "pinia";
import { state } from "../core/state.js";
import { isNoProjectView, PROJECT_VIEW_ALL, PROJECT_VIEW_NONE } from "../modules/project-view.js";
import type { ProjectEntry } from "../modules/types.js";
import "./pinia.js";

export interface ProjectViewItem {
  id: string;
  name: string;
  type: "local" | "cloud" | "";
  builtin: boolean;
  active: boolean;
}

/** 组件侧的菜单命令面（legacy 桥注册；组件只发意图，副作用留在 bridge）。 */
declare global {
  interface Window {
    __agentatlasProjectCommands?: {
      choose?: (view: string) => void;
      addLocal?: () => void;
      addCloud?: () => void;
      refreshCloud?: (id: string) => void;
      remove?: (id: string) => void;
    };
    __agentatlasProjectListeners?: Set<() => void>;
  }
}

export const useProjectsStore = defineStore("projects", {
  state: () => ({
    projects: [] as ProjectEntry[],
    view: PROJECT_VIEW_ALL as string,
  }),
  getters: {
    noProject(): boolean {
      return isNoProjectView(this.view);
    },
    activeProject(): ProjectEntry | null {
      if (this.view === PROJECT_VIEW_ALL || this.noProject) return null;
      return this.projects.find((project) => project.id === this.view) ?? null;
    },
    /** 按钮图标：不选择项目 = Folder；选中项目按其类型；否则 FolderTree。 */
    buttonIcon(): string {
      if (this.noProject) return "Folder";
      return this.activeProject?.type === "cloud" ? "Globe" : this.activeProject ? "Folder" : "FolderTree";
    },
    buttonText(): string {
      if (this.noProject) return "不选择项目";
      return this.activeProject?.name ?? "全部项目";
    },
    /** 菜单选择项（不含两个固定项与底部管理项）。 */
    items(): ProjectViewItem[] {
      return this.projects.map((project) => ({
        id: project.id,
        name: project.name,
        type: project.type,
        builtin: Boolean(project.builtin),
        active: this.view === project.id,
      }));
    },
    isAllView(): boolean {
      return this.view === PROJECT_VIEW_ALL;
    },
    isNoneView(): boolean {
      return this.view === PROJECT_VIEW_NONE;
    },
  },
  actions: {
    /** 从 core state 同步（legacy 桥每次改完 core state 后调用）。 */
    sync(): void {
      this.projects = [...state.projects];
      this.view = state.projectView;
    },
  },
});
