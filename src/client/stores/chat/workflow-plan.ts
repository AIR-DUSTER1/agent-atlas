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
import { state } from "../../core/state.js";
import type { WorkflowPlanSnapshot } from "../../modules/types-api.js";
import "../pinia.js";

export const useWorkflowPlanStore = defineStore("workflowPlan", {
  state: () => ({
    /** 当前会话的计划快照（null = 无计划，面板完全隐藏）。 */
    plan: null as WorkflowPlanSnapshot | null,
    /** 跨会话切换标识：用于「新流程默认收起」判定。 */
    planKey: "",
    /** 用户是否手动展开过当前流程（流程更新不抢回折叠态）。 */
    userOpened: false,
    /** 运行态变化序号：core state 不是响应式对象，「已结束 · 未完成」要靠
     *  这个计数器在运行结束/切换时触发 getter 重算（见 notifyRunStateChange）。 */
    runningTick: 0,
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
      if (plan.status === "completed") return "已完成";
      if (plan.status === "failed") return "未完成";
      // 回合已经结束但模型从未把流程推进/收口（planProgress 只在工具失败时收口）：
      // 不能继续显示「执行中」转圈 —— 那是假进度。真实事故：房产 Agent 创建 3 步
      // 流程后全程未汇报，面板永远停在 01 运行中。
      if (!this.sessionRunning) return "已结束 · 未完成";
      return "执行中";
    },
    /** 会话当前是否真的在生成（服务端 running 标志 + 本地流）。
     *  runningTick 只是为了建立响应式依赖：core state 变化不会自动触发重算。 */
    sessionRunning(): boolean {
      void this.runningTick;
      const sid = state.currentId;
      if (!sid) return false;
      const s = state.sessions.find((x) => x.id === sid);
      return Boolean(s?.running) || Boolean(state.streams[sid]);
    },
    /** 展示层状态：plan.running 但会话已结束 → 显示为 ended（不转圈、中性色）。 */
    displayStatus(): "running" | "completed" | "failed" | "ended" {
      const plan = this.plan;
      if (!plan) return "running";
      if (plan.status === "running" && !this.sessionRunning) return "ended";
      return plan.status;
    },
    activeText(): string {
      const plan = this.plan;
      if (!plan) return "";
      if (plan.status !== "running") return this.statusLabel;
      if (!this.sessionRunning) return "回合结束，流程未全部完成";
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
    /** 运行态变化时调用（流开始/结束、后台轮询发现 running 翻转、会话切换）：
     *  让「执行中 vs 已结束」的判定重新读取 core state。 */
    notifyRunStateChange(): void {
      this.runningTick++;
    },
  },
});
