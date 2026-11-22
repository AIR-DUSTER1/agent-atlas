/**
 * ============================================================
 * apps/settings-memories-vue.ts — 记忆面板 Vue 挂载（M4 批次 4.2）
 * ============================================================
 * 把 settings-memories-vue.vue 挂进 #memories-modal 容器。本模块只被
 * views/settings-memories.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../../../stores/pinia.js";
import SettingsMemoriesVue from "./settings-memories-vue.vue";

export function mountMemoriesVue(): void {
  const target = document.getElementById("memories-modal");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(SettingsMemoriesVue).use(pinia).mount(target);
}
