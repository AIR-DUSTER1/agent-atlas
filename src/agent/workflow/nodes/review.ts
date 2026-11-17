/**
 * workflow/nodes/review.ts — 结果反思与修订闸门
 * ============================================================
 * 普通模式最多三次回炉；连续模式以任务完成为目标，并保留空转熔断和计划步态守卫。
 */
import type { AIMessage } from "@langchain/core/messages";
import {
  finalizeWorkflowPlan,
  settleReviewPassedPlan,
  workflowPlanSummary,
} from "../../../workflow-plan.js";
import {
  MAX_CONTINUOUS_REVISIONS,
  MAX_FEEDBACK_TEXT,
  MAX_IDLE_REVIEW_ROUNDS,
  MAX_REVIEW_REVISIONS,
  MAX_USER_TEXT,
} from "../limits.js";
import { contentText, recentToolResults } from "../message-utils.js";
import { invokeModel } from "../model-adapter.js";
import { parseReviewResult } from "../parsing.js";
import type { WorkflowRuntime } from "../runtime.js";
import type { WorkflowStateType } from "../state.js";

export function createReviewNode(runtime: WorkflowRuntime) {
  return async function reviewNode(state: WorkflowStateType, nodeConfig?: { signal?: AbortSignal }) {
    const last = state.messages.at(-1);
    const lastAi = last?.getType() === "ai" ? (last as AIMessage) : undefined;
    const answer = contentText(lastAi?.content).slice(0, MAX_USER_TEXT);
    const attempts = state.reviewAttempts;
    // 空转检测：两次反思之间没有任何新工具消息 = 助手在纯文本打转。
    // 首次反思以整回合为基准（lastReviewMessageCount 为 0 → 取全部消息）。
    const sinceLastReview = state.lastReviewMessageCount > 0
      ? state.messages.slice(state.lastReviewMessageCount)
      : state.messages;
    const hadToolWork = sinceLastReview.some((message) => message.getType() === "tool");
    const bookkeeping = {
      idleReviewRounds: hadToolWork ? 0 : state.idleReviewRounds + 1,
      lastReviewMessageCount: state.messages.length,
    };
    const continuous = state.continuousMode;
    const plan = state.workflowPlan;
    const planSummary = workflowPlanSummary(plan);
    const unfinishedPlanSteps = plan?.steps.filter(
      (step) => step.status !== "completed" && step.status !== "skipped",
    ) ?? [];
    // 回炉上限：普通模式 3 次防死循环；连续模式放宽到保险丝级，靠空转熔断与异常兜底
    const cap = continuous ? MAX_CONTINUOUS_REVISIONS : MAX_REVIEW_REVISIONS;
    const finishPlan = (status: "completed" | "failed", target = plan) => finalizeWorkflowPlan(target, status);
    try {
      const response = await invokeModel(runtime.reviewerModel, [
        { role: "system", content: continuous ? runtime.continuousReviewPrompt : runtime.reviewPrompt },
        {
          role: "user",
          content:
            `用户本轮需求/理解：\n${state.requirementBrief || "（无）"}\n\n` +
            `上一轮澄清（仅在相关时参考）：\n${state.clarificationHistory || "（无）"}\n\n` +
            `执行流程：\n${planSummary}\n\n` +
            `最近工具结果：\n${recentToolResults(state.messages) || "（无）"}\n\n` +
            `助手最新回答：\n${answer || "（空回答）"}`,
        },
      ], nodeConfig?.signal, runtime.options.sessionId);
      runtime.observeModel("review", response);
      const review = parseReviewResult(contentText(response.content));
      // 模型常忘记把最后一个 in_progress 步骤标 completed。反思已确认结果满足需求时，
      // 若只差这一个 active 步骤封口，由编排层补 bookkeeping，避免同一答案被反复回炉。
      const settledPlan = review.passes ? settleReviewPassedPlan(plan) : plan;
      const unsettledPlanSteps = settledPlan?.steps.filter(
        (step) => step.status !== "completed" && step.status !== "skipped",
      ) ?? [];
      // 计划是可见承诺：仍有 pending / failed 步骤时，即使模型说 passes 也不能提前收尾。
      if (review.passes && unsettledPlanSteps.length && attempts < cap) {
        const names = unsettledPlanSteps.slice(0, 6).map((step) => step.title).join("、");
        return {
          reviewFeedback: `执行流程仍有未完成或失败的步骤：${names}。请继续执行，并用 update_workflow_plan 同步证据；无法完成的步骤标记 failed 或 skipped 并说明原因。`,
          reviewAttempts: attempts + 1,
          ...bookkeeping,
        };
      }
      if (review.passes || attempts >= cap) {
        return {
          reviewFeedback: "",
          reviewAttempts: attempts + 1,
          ...bookkeeping,
          ...(settledPlan ? { workflowPlan: finishPlan(unsettledPlanSteps.length ? "failed" : "completed", settledPlan) } : {}),
        };
      }
      // 连续模式空转熔断：反思连续多轮不通过且期间没有任何工具动作，
      // 继续回炉只是烧钱；把控制权交还用户比第 N 次换措辞重说更有价值。
      if (continuous && bookkeeping.idleReviewRounds >= MAX_IDLE_REVIEW_ROUNDS) {
        return {
          reviewFeedback: "",
          reviewAttempts: attempts + 1,
          ...bookkeeping,
          ...(plan ? { workflowPlan: finishPlan("failed") } : {}),
        };
      }
      const feedback = (review.feedback || review.reason || "回答没有完全满足需求，请检查遗漏并补齐。")
        .slice(0, MAX_FEEDBACK_TEXT);
      return { reviewFeedback: feedback, reviewAttempts: attempts + 1, ...bookkeeping };
    } catch {
      return {
        reviewFeedback: "",
        reviewAttempts: attempts + 1,
        ...bookkeeping,
        ...(plan ? { workflowPlan: finishPlan(unfinishedPlanSteps.length ? "failed" : "completed") } : {}),
      };
    }
  };
}