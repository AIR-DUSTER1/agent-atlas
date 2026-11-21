/**
 * ============================================================
 * apps/topbar-vue.ts — 顶栏会话头与欢迎页标题挂载（M4 批次 4.5）
 * ============================================================
 * 三处挂载：
 *  - #topbar-head-mount  → 会话头（标题 / 面包屑 / 示例徽标）
 *  - #welcome-head-mount → 欢迎页 hero +「试试这些」标签
 *  - #welcome-cards-mount → 「选择 Agent 或内置示例」标签
 * 后两者分两段是为了保持 #example-chips / #demo-cards 的原始 DOM 顺序。
 * 本模块只被 views/navigation.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import TopbarVue from "../views/topbar-vue.vue";
import WelcomeHeadVue from "../views/welcome-head-vue.vue";
import PermChipVue from "../views/perm-chip-vue.vue";

type Mountable = typeof TopbarVue | typeof WelcomeHeadVue | typeof PermChipVue;

function mountInto(id: string, component: Mountable, section?: "hero" | "cards"): void {
  const target = document.getElementById(id);
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(component, section ? { section } : undefined).use(pinia).mount(target);
}

/** 会话头（标题 / 面包屑 / 示例徽标）。 */
export function mountTopbarVue(): void {
  mountInto("topbar-head-mount", TopbarVue);
}

/** 欢迎页 hero +「试试这些」标签。 */
export function mountWelcomeHeadVue(): void {
  mountInto("welcome-head-mount", WelcomeHeadVue, "hero");
  mountInto("welcome-cards-mount", WelcomeHeadVue, "cards");
}

/** 三处一起挂载（启动与切换欢迎态时调用，幂等）。 */
export function mountShellHeadsVue(): void {
  mountTopbarVue();
  mountWelcomeHeadVue();
  mountPermChipVue();
}

/** 权限 chip（按钮 + 菜单容器）；开合仍是 main.ts 的 toggleCmMenu。 */
export function mountPermChipVue(): void {
  mountInto("perm-chip-mount", PermChipVue);
}
