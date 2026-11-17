/**
 * workflow/nodes/plan-progress.ts — 执行流程状态迁移节点
 * ============================================================
 * 只读上一批 update_workflow_plan 工具调用并把合法参数写回图状态，
 * 独立成节点保证审批 resume 重放时仍按当前批次幂等应用。
 */
import type { AIMessage } from "@langchain/core/messages";
import {
  applyWorkflowPlanToolInput,
  finalizeWorkflowPlan,
  WORKFLOW_PLAN_TOOL_NAME,
} from "../../../workflow-plan.js";
import { toolResultsStopTurn } from "../../turn-stop.js";
import type { WorkflowRuntime } from "../runtime.js";
import type { WorkflowStateType } from "../state.js";

export function createPlanProgressNode(runtime: WorkflowRuntime) {
  return async function planProgressNode(state: WorkflowStateType) {
    if (!runtime.planningEnabled) return {};
    let cursor = state.messages.length - 1;
    while (cursor >= 0 && state.messages[cursor]?.getType() === "tool") cursor -= 1;
    const lastAi = cursor >= 0 && state.messages[cursor]?.getType() === "ai"
      ? state.messages[cursor] as AIMessage
      : undefined;
    const calls = (lastAi?.tool_calls ?? []).filter((call) => call.name === WORKFLOW_PLAN_TOOL_NAME);
    let plan = state.workflowPlan;
    let changed = false;
    for (const call of calls) {
      const next = applyWorkflowPlanToolInput(plan, call.args);
      if (next !== plan) changed = true;
      plan = next;
    }
    // 工具结果已经标记 stopAgent 时不再回模型；若已有流程，把当前状态显式收口为失败，
    // 避免窗体永远停在一个“进行中”的假进度。
    if (plan && toolResultsStopTurn(state.messages)) {
      const finalized = finalizeWorkflowPlan(plan, "failed");
      if (finalized !== plan) changed = true;
      plan = finalized;
    }
    return changed ? { workflowPlan: plan } : {};
  };
}