/**
 * ============================================================
 * apps/settings-skills-vue.ts — 技能面板 Vue 挂载（M4 批次 4.2）
 * ============================================================
 * 把 settings-skills-vue.vue 挂进 #skills-modal 容器。本模块只被
 * views/settings-skills.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import SettingsSkillsVue from "../views/settings-skills-vue.vue";

export function mountSkillsVue(): void {
  const target = document.getElementById("skills-modal");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(SettingsSkillsVue).use(pinia).mount(target);
}
