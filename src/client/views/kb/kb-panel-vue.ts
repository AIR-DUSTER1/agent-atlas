/**
 * ============================================================
 * apps/kb-panel-vue.ts — 知识库弹窗 Vue 挂载（M4 批次 4.4）
 * ============================================================
 * 把 kb-panel-vue.vue 挂进 #kb-mask 容器（启动即挂载，默认隐藏）。
 * 本模块只被 views/rag.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../../stores/pinia.js";
import KbPanelVue from "./kb-panel-vue.vue";

export function mountKbPanelVue(): void {
  const target = document.getElementById("kb-mask");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(KbPanelVue).use(pinia).mount(target);
}
