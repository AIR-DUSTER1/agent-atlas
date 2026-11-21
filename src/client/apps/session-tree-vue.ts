/**
 * ============================================================
 * apps/session-tree-vue.ts — 侧栏会话树 Vue 挂载（M4 批次 4.5）
 * ============================================================
 * 把 session-tree-vue.vue 挂进 #session-list。本模块只被
 * views/sessions.ts **动态 import**（Vue 与 pinia 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import SessionTreeVue from "../views/session-tree-vue.vue";

export function mountSessionTreeVue(): void {
  const target = document.getElementById("session-list");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(SessionTreeVue).use(pinia).mount(target);
}
