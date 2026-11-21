/**
 * ============================================================
 * apps/stats-panel-vue.ts — 使用统计面板 Vue 挂载（M4 批次 4.2）
 * ============================================================
 * 把 stats-panel-vue.vue 挂进 #stats-modal 容器（组件渲染分区全部内容）。
 * 本模块只被 views/stats/index.ts **动态 import**（Vue 与 Chart.js 都不进
 * 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import StatsPanelVue from "../views/stats-panel-vue.vue";

export function mountStatsVue(): void {
  const target = document.getElementById("stats-modal");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(StatsPanelVue).use(pinia).mount(target);
}
