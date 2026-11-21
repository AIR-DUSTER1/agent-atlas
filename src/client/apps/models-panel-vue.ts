/**
 * ============================================================
 * apps/models-panel-vue.ts — 模型面板 Vue 挂载（M4 批次 4.3）
 * ============================================================
 * 把 models-panel-vue.vue 挂进 #settings-modal 容器。本模块只被
 * views/model-panel.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import ModelsPanelVue from "../views/models-panel-vue.vue";

export function mountModelsPanelVue(): void {
  const target = document.getElementById("settings-modal");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(ModelsPanelVue).use(pinia).mount(target);
}
