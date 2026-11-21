/**
 * ============================================================
 * apps/estate-panel-vue.ts — 贝壳面板 Vue 挂载（M4 批次 4.4）
 * ============================================================
 * 把 estate-panel-vue.vue 挂进 #estate-mask 容器（启动即挂载，默认隐藏）。
 * 本模块只被 views/estate.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import EstatePanelVue from "../views/estate-panel-vue.vue";

export function mountEstatePanelVue(): void {
  const target = document.getElementById("estate-mask");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(EstatePanelVue).use(pinia).mount(target);
}
