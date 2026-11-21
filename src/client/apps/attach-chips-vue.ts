/**
 * ============================================================
 * apps/attach-chips-vue.ts — 附件 chips Vue 挂载（M4 批次 4.6）
 * ============================================================
 * 把 attach-chips-vue.vue 挂进 composer 的 #attach-chips-mount 容器。
 * 本模块只被 views/attachments.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import AttachChipsVue from "../views/attach-chips-vue.vue";

export function mountAttachChipsVue(): void {
  const target = document.getElementById("attach-chips-mount");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(AttachChipsVue).use(pinia).mount(target);
}
