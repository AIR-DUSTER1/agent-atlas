/**
 * ============================================================
 * apps/settings-plugins-vue.ts — 插件面板 Vue 挂载（M4 批次 4.1）
 * ============================================================
 * 把 settings-plugins-vue.vue 挂进插件面板的 #plugin-list 容器（多根模板，
 * 卡片直接成为网格容器的子节点）。本模块只被 views/settings-plugins.ts
 * **动态 import**：
 *  - Vue 不进首屏启动闭包（可选项动态加载红线）；
 *  - 过渡期 1:1 树里本模块的静态 .vue 导入会 404，调用方 catch 降级；
 *  - 挂载一次后不再重复（refreshPluginPanel 重复进入只刷新 store 数据）。
 */
import { createApp } from "vue";
import { pinia } from "../../../stores/pinia.js";
import SettingsPluginsVue from "./settings-plugins-vue.vue";

export function mountPluginsVue(): void {
  const target = document.getElementById("plugin-list");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(SettingsPluginsVue).use(pinia).mount(target);
}
