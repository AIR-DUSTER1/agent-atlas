/**
 * ============================================================
 * apps/job-panel-vue.ts — 求职面板 Vue 挂载（M4 批次 4.4）
 * ============================================================
 * 把 job-panel-vue.vue 挂进 #job-mask 容器（启动即挂载，默认隐藏）。
 * 本模块只被 views/job.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../../stores/pinia.js";
import JobPanelVue from "./job-panel-vue.vue";

export function mountJobPanelVue(): void {
  const target = document.getElementById("job-mask");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(JobPanelVue).use(pinia).mount(target);
}
