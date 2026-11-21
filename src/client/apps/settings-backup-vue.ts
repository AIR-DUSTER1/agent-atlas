/**
 * ============================================================
 * apps/settings-backup-vue.ts — 备份列表 Vue 挂载（M4 批次 4.2）
 * ============================================================
 * 把 settings-backup-vue.vue 挂进 #backup-list 容器。本模块只被
 * views/settings-backup.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import SettingsBackupVue from "../views/settings-backup-vue.vue";

export function mountBackupVue(): void {
  const target = document.getElementById("backup-list");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(SettingsBackupVue).use(pinia).mount(target);
}
