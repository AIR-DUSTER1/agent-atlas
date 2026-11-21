/**
 * ============================================================
 * apps/settings-routing-vue.ts — 路由面板 Vue 挂载（M4 批次 4.2）
 * ============================================================
 * 把 settings-routing-vue.vue 挂进 #routing-panel 容器（组件渲染分区全部
 * 内容）。本模块只被 views/settings-routing.ts **动态 import**。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import SettingsRoutingVue from "../views/settings-routing-vue.vue";

export function mountRoutingVue(): void {
  const target = document.getElementById("routing-panel");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(SettingsRoutingVue).use(pinia).mount(target);
}
