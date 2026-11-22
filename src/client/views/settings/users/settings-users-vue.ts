/**
 * ============================================================
 * apps/settings-users-vue.ts — 用户管理面板 Vue 挂载（M4 批次 4.2）
 * ============================================================
 * 把 settings-users-vue.vue 挂进 #users-panel 容器。本模块只被
 * views/settings-users.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../../../stores/pinia.js";
import SettingsUsersVue from "./settings-users-vue.vue";

export function mountUsersVue(): void {
  const target = document.getElementById("users-panel");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(SettingsUsersVue).use(pinia).mount(target);
}
