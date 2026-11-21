/**
 * ============================================================
 * apps/project-switcher-vue.ts — 项目切换器 Vue 挂载（M4 批次 4.4）
 * ============================================================
 * 把 project-switcher-vue.vue 挂进 #project-switch。本模块只被
 * views/projects.ts **动态 import**（Vue 不进 1:1 静态图）。
 * 挂载目标包含按钮与菜单两个宿主：组件根即 .project-switch 的内容，
 * 因此挂到 #project-switch 后菜单仍与按钮同父，浮动控制器定位不变。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import ProjectSwitcherVue from "../views/project-switcher-vue.vue";

export function mountProjectSwitcherVue(): void {
  const target = document.getElementById("project-switch");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(ProjectSwitcherVue).use(pinia).mount(target);
}
