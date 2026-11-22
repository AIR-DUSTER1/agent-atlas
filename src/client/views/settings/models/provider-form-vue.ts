/**
 * ============================================================
 * apps/provider-form-vue.ts — 供应商弹窗 Vue 挂载（M4 批次 4.3）
 * ============================================================
 * 把 provider-form-vue.vue 挂进 #provider-modal-mask 容器（启动时挂载，
 * 默认隐藏；开关完全由 stores/models.providerFormOpen 驱动）。
 * 本模块只被 main.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../../../stores/pinia.js";
import ProviderFormVue from "./provider-form-vue.vue";

export function mountProviderFormVue(): void {
  const target = document.getElementById("provider-modal-mask");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(ProviderFormVue).use(pinia).mount(target);
}
