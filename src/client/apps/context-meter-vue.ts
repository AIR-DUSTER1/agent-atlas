/**
 * ============================================================
 * apps/context-meter-vue.ts — 容量条 Vue 挂载（M4 批次 4.6）
 * ============================================================
 * 把 context-meter-vue.vue 挂进 composer 的 #context-meter-mount 容器。
 * 本模块只被 views/composer-bar.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import ContextMeterVue from "../views/context-meter-vue.vue";

export function mountContextMeterVue(): void {
  const target = document.getElementById("context-meter-mount");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(ContextMeterVue).use(pinia).mount(target);
}
