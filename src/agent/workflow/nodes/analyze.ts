/**
 * workflow/nodes/analyze.ts — 需求理解节点
 * ============================================================
 * 只负责把最新请求转成需求 brief、澄清问题或可选执行流程，不执行工具。
 */
import { createWorkflowPlanFromDraft } from "../../../workflow-plan.js";
import { invokeModel } from "../model-adapter.js";
import { MAX_BRIEF_TEXT, MAX_USER_TEXT } from "../limits.js";
import { contentText, lastHumanText, recentContext } from "../message-utils.js";
import { parseRequirementAnalysis } from "../parsing.js";
import type { WorkflowStateType } from "../state.js";
import type { WorkflowRuntime } from "../runtime.js";

type AnalyzeNodeConfig = {
  signal?: AbortSignal;
  configurable?: { continuous?: boolean };
};

export function createAnalyzeNode(runtime: WorkflowRuntime) {
  return async function analyzeNode(state: WorkflowStateType, nodeConfig?: AnalyzeNodeConfig) {
    const userText = lastHumanText(state.messages).slice(0, MAX_USER_TEXT);
    const history = state.clarificationHistory
      ? `上一轮澄清（仅在相关时参考）：${state.clarificationHistory}`
      : "";
    const fallback = {
      requirementBrief: [userText, history].filter(Boolean).join("\n").slice(0, MAX_BRIEF_TEXT),
      workflowPlan: null,
      clarification: null,
      reviewFeedback: "",
      reviewAttempts: 0,
      // 连续模式标记只由本轮请求决定，不跨回合残留；空转计数同理归零
      continuousMode: nodeConfig?.configurable?.continuous === true,
      idleReviewRounds: 0,
      lastReviewMessageCount: 0,
    };
    if (!userText.trim()) return fallback;

    try {
      const response = await invokeModel(runtime.analystModel, [
        { role: "system", content: runtime.analyzePrompt },
        {
          role: "user",
          content:
            `上一轮澄清（仅在相关时参考）：\n${state.clarificationHistory || "（无）"}\n\n` +
            `最近对话：\n${recentContext(state.messages) || "（无）"}\n\n当前请求：\n${userText}`,
        },
      ], nodeConfig?.signal, runtime.options.sessionId);
      runtime.observeModel("analyze", response);
      const analysis = parseRequirementAnalysis(contentText(response.content));
      const brief = (analysis.brief || userText).slice(0, MAX_BRIEF_TEXT);
      if (analysis.understood) {
        return {
          ...fallback,
          requirementBrief: brief,
          workflowPlan: analysis.plan ? createWorkflowPlanFromDraft(analysis.plan) : null,
        };
      }
      return {
        ...fallback,
        requirementBrief: brief,
        clarification: {
          type: "clarification" as const,
          questions: analysis.questions,
        },
      };
    } catch {
      return fallback;
    }
  };
}