/**
 * ============================================================
 * apps/external-cards-vue.ts — 外部 Agent 卡片 Vue 挂载（M4 批次 4.4）
 * ============================================================
 * 把 external-cards-vue.vue 挂进 #external-cards 容器。本模块只被
 * views/external.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import ExternalCardsVue from "../views/external-cards-vue.vue";

export function mountExternalCardsVue(): void {
  const target = document.getElementById("external-cards");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(ExternalCardsVue).use(pinia).mount(target);
}
