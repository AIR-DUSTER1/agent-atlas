/**
 * ============================================================
 * apps/workflow-plan-vue.ts — 执行流程面板 Vue 挂载（M4 批次 4.6）
 * ============================================================
 * 把 workflow-plan-vue.vue 挂进 #composer 的 #workflow-plan-mount 容器。
 * 本模块只被 views/workflow-plan.ts **动态 import**（Vue 不进 1:1 静态图）。
 */
import { createApp } from "vue";
import { pinia } from "../stores/pinia.js";
import WorkflowPlanVue from "../views/workflow-plan-vue.vue";

export function mountWorkflowPlanVue(): void {
  const target = document.getElementById("workflow-plan-mount");
  if (!target || target.dataset.vueMounted === "1") return;
  target.dataset.vueMounted = "1";
  createApp(WorkflowPlanVue).use(pinia).mount(target);
}
