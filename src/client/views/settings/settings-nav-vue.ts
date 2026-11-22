/**
 * ============================================================
 * apps/settings-nav-vue.ts — 设置导航 Vue 挂载（M4 批次 4.5）
 * ============================================================
 * 把 settings-nav-vue.vue 挂进 .settings-nav 位置（替换静态导航 markup）。
 * 本模块只被 views/settings.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../../stores/pinia.js";
import SettingsNavVue from "./settings-nav-vue.vue";

export function mountSettingsNavVue(): void {
  // 静态导航骨架里放的是空容器 #settings-nav-mount；组件渲染完整 <nav>。
  const target = document.getElementById("settings-nav-mount");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(SettingsNavVue).use(pinia).mount(target);
}
