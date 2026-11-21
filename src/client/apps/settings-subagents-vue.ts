/**
 * ============================================================
 * apps/settings-subagents-vue.ts — 子代理面板 Vue 挂载（M4 批次 4.2）
 * ============================================================
 * 把 settings-subagents-vue.vue 挂进 #subagents-panel 容器。本模块只被
 * views/settings-subagents.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import SettingsSubagentsVue from "../views/settings-subagents-vue.vue";

export function mountSubagentsVue(): void {
  const target = document.getElementById("subagents-panel");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(SettingsSubagentsVue).use(pinia).mount(target);
}
