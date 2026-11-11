/**
 * ============================================================
 * views/workflow-plan.ts — 输入框上方的自主执行流程窗体
 * ============================================================
 * 职责：消费 workflow_plan 快照，渲染折叠摘要、目标、步骤状态与总进度。
 * 设计立场：
 *  - 无计划完全不占位；有计划默认折叠，用户展开后更新不强行抢回焦点；
 *  - 所有模型文本用 textContent 写入，步骤状态只做固定枚举映射；
 *  - 计划按会话持久化，切换会话时展示该会话自己的流程，禁止串台。
 */
import { $ } from "../core/dom.js";
import { saveLocal, state } from "../core/state.js";
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";
import type { WorkflowPlanSnapshot, WorkflowPlanStep, WorkflowStepStatus } from "../modules/types-api.js";

const STEP_STATUS_LABEL: Record<WorkflowStepStatus, string> = {
  pending: "待执行",
  in_progress: "进行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

const STEP_STATUS_ICON: Record<WorkflowStepStatus, "Clock" | "LoaderCircle" | "CircleCheck" | "CircleX" | "ChevronRight"> = {
  pending: "Clock",
  in_progress: "LoaderCircle",
  completed: "CircleCheck",
  failed: "CircleX",
  skipped: "ChevronRight",
};

let lastPlanKey = "";

function stepMeta(step: WorkflowPlanStep): string {
  if (step.note) return step.note;
  if (step.detail) return step.detail;
  return "";
}

function renderStep(plan: WorkflowPlanSnapshot, step: WorkflowPlanStep, index: number): HTMLElement {
  const active = step.id === plan.activeStepId && step.status === "in_progress";
  const item = h("li", {
    class: `workflow-step status-${step.status}${active ? " is-active" : ""}`,
    ...(active ? { "aria-current": "step" } : {}),
  });
  const marker = h("span", { class: "workflow-step-marker", "aria-hidden": "true" },
    icon(STEP_STATUS_ICON[step.status], { size: 14 }),
  );
  const copy = h("div", { class: "workflow-step-copy" },
    h("div", { class: "workflow-step-title" },
      h("span", { class: "workflow-step-index" }, String(index + 1).padStart(2, "0")),
      h("strong", null, step.title),
    ),
  );
  const meta = stepMeta(step);
  if (meta) copy.appendChild(h("p", { class: "workflow-step-note" }, meta));
  const status = h("span", { class: "workflow-step-status" }, STEP_STATUS_LABEL[step.status]);
  item.append(marker, copy, status);
  return item;
}

/** 更新某个会话的计划状态；sid 默认为当前会话，后台流也写到正确会话。 */
export function setWorkflowPlan(plan: WorkflowPlanSnapshot | null, sid: string | null = state.currentId): void {
  if (!sid) return;
  state.workflowPlans[sid] = plan;
  saveLocal();
  if (sid === state.currentId) renderWorkflowPlan();
}

export function clearWorkflowPlan(sid: string | null = state.currentId): void {
  setWorkflowPlan(null, sid);
}

export function renderWorkflowPlan(): void {
  const panel = $("workflow-panel") as HTMLDetailsElement | null;
  if (!panel) return;
  const plan = state.currentId ? state.workflowPlans[state.currentId] ?? null : null;
  if (!plan || !plan.steps.length) {
    panel.classList.add("hidden");
    panel.open = false;
    lastPlanKey = "";
    return;
  }

  panel.classList.remove("hidden");
  const planKey = `${state.currentId}:${plan.id}`;
  if (planKey !== lastPlanKey) {
    // 新流程默认收起；同一条流程的后续进度更新不打断用户手动展开。
    panel.open = false;
    lastPlanKey = planKey;
  }

  const total = plan.steps.length;
  const completed = plan.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const activeStep = plan.steps.find((step) => step.id === plan.activeStepId);
  const statusLabel = plan.status === "completed" ? "已完成" : plan.status === "failed" ? "未完成" : "执行中";
  const activeText = plan.status === "running"
    ? activeStep ? `正在执行 · ${activeStep.title}` : "准备下一步"
    : statusLabel;

  const titleEl = $("workflow-active");
  if (titleEl) titleEl.textContent = activeText;
  const countEl = $("workflow-count");
  if (countEl) countEl.textContent = `${completed}/${total} 步`;
  const percentEl = $("workflow-percent");
  if (percentEl) percentEl.textContent = `${percent}%`;
  const statusEl = $("workflow-status");
  if (statusEl) {
    statusEl.textContent = statusLabel;
    statusEl.className = `workflow-status status-${plan.status}`;
  }
  const meter = $("workflow-meter");
  if (meter) {
    meter.setAttribute("aria-valuenow", String(percent));
    meter.setAttribute("aria-valuemax", "100");
    meter.setAttribute("aria-valuetext", `已完成 ${completed} 个步骤，共 ${total} 个`);
  }
  const fill = $("workflow-meter-fill");
  if (fill) {
    fill.style.width = `${percent}%`;
    fill.className = `workflow-meter-fill status-${plan.status}`;
  }
  const goal = $("workflow-goal");
  if (goal) goal.textContent = plan.goal;
  const list = $("workflow-steps");
  if (list) list.replaceChildren(...plan.steps.map((step, index) => renderStep(plan, step, index)));
}
