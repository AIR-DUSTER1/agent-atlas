/**
 * ============================================================
 * stores/workflow-plan.ts — 自主执行流程面板（框架迁移 M4 批次 4.6）
 * ============================================================
 * 职责：workflow_plan 快照的展示状态（当前会话计划、新流程折叠标记）。
 * 设计立场：
 *  - 计划本体仍按会话持久化在 core state（state.workflowPlans，切会话不串台），
 *    store 只镜像「当前会话 + render 序号」触发 Vue 重渲染；
 *  - 无计划完全不占位；新流程默认收起，后续进度更新不打断用户手动展开。
 */
import { defineStore } from "pinia";
import { state } from "../core/state.js";
import type { WorkflowPlanSnapshot } from "../modules/types-api.js";
import "./pinia.js";

export const useWorkflowPlanStore = defineStore("workflowPlan", {
  state: () => ({
    /** 当前会话的计划快照（null = 无计划，面板完全隐藏）。 */
    plan: null as WorkflowPlanSnapshot | null,
    /** 跨会话切换标识：用于「新流程默认收起」判定。 */
    planKey: "",
    /** 用户是否手动展开过当前流程（流程更新不抢回折叠态）。 */
    userOpened: false,
  }),
  getters: {
    steps(): WorkflowPlanSnapshot["steps"] {
      return this.plan?.steps ?? [];
    },
    percent(): number {
      const total = this.steps.length;
      if (!total) return 0;
      const completed = this.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
      return Math.round((completed / total) * 100);
    },
    completedCount(): number {
      return this.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
    },
    activeStepTitle(): string {
      const plan = this.plan;
      if (!plan) return "";
      return plan.steps.find((step) => step.id === plan.activeStepId)?.title ?? "";
    },
    statusLabel(): string {
      const plan = this.plan;
      if (!plan) return "";
      return plan.status === "completed" ? "已完成" : plan.status === "failed" ? "未完成" : "执行中";
    },
    activeText(): string {
      const plan = this.plan;
      if (!plan) return "";
      if (plan.status !== "running") return this.statusLabel;
      return this.activeStepTitle ? `正在执行 · ${this.activeStepTitle}` : "准备下一步";
    },
  },
  actions: {
    /** 由 stream 层调用：写入快照并同步到 core state（会话级持久化）。 */
    apply(plan: WorkflowPlanSnapshot | null, sid: string | null): void {
      if (!sid) return;
      state.workflowPlans[sid] = plan;
      if (sid !== state.currentId) return;
      const key = plan ? `${sid}:${plan.id}` : "";
      if (key !== this.planKey) {
        // 新流程默认收起；同一条流程的后续进度更新不打断用户手动展开。
        this.userOpened = false;
        this.planKey = key;
      }
      this.plan = plan;
    },
    /** 会话切换时重取该会话自己的计划（禁止串台）。 */
    syncForCurrentSession(): void {
      const sid = state.currentId;
      const plan = sid ? state.workflowPlans[sid] ?? null : null;
      const key = plan ? `${sid}:${plan.id}` : "";
      if (key !== this.planKey) {
        this.userOpened = false;
        this.planKey = key;
      }
      this.plan = plan;
    },
    toggleOpen(open: boolean): void {
      this.userOpened = open;
    },
  },
});
