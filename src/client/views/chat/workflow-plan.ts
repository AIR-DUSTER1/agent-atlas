/**
 * views/workflow-plan.ts — 执行流程面板分发桥（M4 批次 4.6 起）
 * ============================================================
 * 渲染已迁往 Vue（workflow-plan-vue.vue + stores/workflow-plan.ts）；
 * 本文件保留 legacy 侧职责：
 *  1. setWorkflowPlan / clearWorkflowPlan —— stream 层写入快照的入口；
 *  2. renderWorkflowPlan —— 会话切换时的重取入口（syncForCurrentSession）。
 * store 经动态 import 进入（本模块在 1:1 过渡树链上：stream/events → 本模块）。
 */
import { state } from "../../core/state.js";
import { saveLocal } from "../../core/state.js";
import type { WorkflowPlanSnapshot } from "../../modules/types-api.js";

async function store() {
  const { useWorkflowPlanStore } = await import("../../stores/chat/workflow-plan.js");
  return useWorkflowPlanStore();
}

/** 更新某个会话的计划状态；sid 默认为当前会话，后台流也写到正确会话。 */
export async function setWorkflowPlan(
  plan: WorkflowPlanSnapshot | null,
  sid: string | null = state.currentId,
): Promise<void> {
  if (!sid) return;
  state.workflowPlans[sid] = plan;
  saveLocal();
  (await store()).apply(plan, sid);
}

export async function clearWorkflowPlan(sid: string | null = state.currentId): Promise<void> {
  await setWorkflowPlan(null, sid);
}

/** 会话切换 / 首次挂载时重取当前会话自己的计划（禁止串台）。 */
export async function renderWorkflowPlan(): Promise<void> {
  (await store()).syncForCurrentSession();
}

/** 面板挂载（幂等）。 */
export async function mountWorkflowPlanPanel(): Promise<void> {
  void import("./workflow-plan-vue.js")
    .then((m) => m.mountWorkflowPlanVue())
    .catch(() => {});
}
