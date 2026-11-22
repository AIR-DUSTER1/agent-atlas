/**
 * ============================================================
 * apps/agent-cards-vue.ts — Agent 卡片与示例 chips 挂载（M4 批次 4.5）
 * ============================================================
 * 一个模块挂三处（欢迎页卡片 / 新会话弹窗卡片 / 示例 chips），各自幂等。
 * 本模块只被 views/shell.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../../stores/pinia.js";
import AgentCardsVue from "./agent-cards-vue.vue";
import ExampleChipsVue from "./example-chips-vue.vue";

function mountInto(id: string, component: typeof AgentCardsVue | typeof ExampleChipsVue): void {
  const target = document.getElementById(id);
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(component).use(pinia).mount(target);
}

/** 挂载欢迎页与新会话弹窗的 Agent 卡片（两处同组件、各自实例）。 */
export function mountAgentCardsVue(): void {
  mountInto("demo-cards", AgentCardsVue);
  mountInto("modal-cards", AgentCardsVue);
}

/** 挂载欢迎页示例 chips。 */
export function mountExampleChipsVue(): void {
  mountInto("example-chips", ExampleChipsVue);
}
