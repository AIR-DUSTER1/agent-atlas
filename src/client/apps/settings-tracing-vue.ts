/**
 * ============================================================
 * apps/settings-tracing-vue.ts — 链路追踪面板 Vue 挂载（M4 批次 4.2）
 * ============================================================
 * 把 settings-tracing-vue.vue 挂进 #tracing-panel 容器（组件渲染分区全部
 * 内容）。本模块只被 views/settings-tracing.ts **动态 import**（Vue 不进
 * 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import SettingsTracingVue from "../views/settings-tracing-vue.vue";

export function mountTracingVue(): void {
  const target = document.getElementById("tracing-panel");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(SettingsTracingVue).use(pinia).mount(target);
}
