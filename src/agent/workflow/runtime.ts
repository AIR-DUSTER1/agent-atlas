/**
 * workflow/runtime.ts — 单个图实例的模型、工具与提示词依赖
 * ============================================================
 * 图节点通过显式 runtime 取依赖，不共享可变异全局；这里负责收集 usage 观测回调和
 * profile 领域提示词，保证纯节点模块不需要知道 `createChatModel` 与工具装配细节。
 */
import type { AIMessage } from "@langchain/core/messages";
import type { MemorySaver } from "@langchain/langgraph";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createChatModel } from "../../llm.js";
import type { ModelRuntimeConfig } from "../../model-runtime.js";
import { createToolRiskAssessor, type ToolRiskAssessor } from "../tool-risk.js";
import type { AgentProfile } from "../profile.js";
import type { dispatchToAgent } from "../../tools-team.js";
import { updateWorkflowPlanTool } from "../../tools-plan.js";
import { WORKFLOW_PLAN_TOOL_NAME } from "../../workflow-plan.js";
import { withModelRetries } from "./model-adapter.js";
import {
  ANALYZE_PROMPT,
  CONTINUOUS_REVIEW_PROMPT,
  REVIEW_PROMPT,
} from "./prompts.js";
import type { WorkflowChatModel, WorkflowModels } from "./types.js";

export interface WorkflowGraphOptions {
  checkpointer?: MemorySaver;
  sessionId?: string;
  riskAssessor?: ToolRiskAssessor;
  /** 子代理可使用独立「供应商 × 模型」快照；主图不传时走全局当前模型。 */
  modelRuntime?: ModelRuntimeConfig;
  /** 观测每次模型响应；回调异常不得影响主图。 */
  onModelUsage?: (node: "analyze" | "agent" | "review", response: AIMessage) => void;
  /**
   * 路由派发执行器；生产省略（固定走 runSubagent）。
   * 单测注入假执行器即可覆盖「派发 → 回填 → 收尾」全链路，不碰真实网关。
   */
  dispatchRunner?: typeof dispatchToAgent;
  /** 主 Agent 默认启用可见执行流程；后台子 Agent 传 false，避免无消费者时浪费 token。 */
  enablePlanning?: boolean;
}

export interface WorkflowRuntime {
  profile: AgentProfile;
  options: WorkflowGraphOptions;
  planningEnabled: boolean;
  tools: StructuredToolInterface[];
  agentModel: WorkflowChatModel;
  analystModel: WorkflowChatModel;
  reviewerModel: WorkflowChatModel;
  riskAssessor: ToolRiskAssessor;
  analyzePrompt: string;
  reviewPrompt: string;
  continuousReviewPrompt: string;
  observeModel: (node: "analyze" | "agent" | "review", response: AIMessage) => void;
}

/** 该函数只组装依赖，不创建图；图装配留给 graph.ts。 */
export function createWorkflowRuntime(
  profile: AgentProfile,
  models?: WorkflowModels,
  options?: WorkflowGraphOptions,
): WorkflowRuntime {
  const planningEnabled = options?.enablePlanning !== false;
  const hasPlanTool = profile.tools.some((item) => item.name === WORKFLOW_PLAN_TOOL_NAME);
  const tools = planningEnabled && !hasPlanTool
    ? [...profile.tools, updateWorkflowPlanTool]
    : profile.tools;
  const modelOptions = { sessionId: options?.sessionId, runtime: options?.modelRuntime };
  const agentModel = models?.agent
    ?? withModelRetries(createChatModel(0, modelOptions).bindTools(tools) as unknown as WorkflowChatModel, options?.sessionId);
  const analystModel = models?.analyst
    ?? withModelRetries(createChatModel(0, modelOptions) as unknown as WorkflowChatModel, options?.sessionId);
  const reviewerModel = models?.reviewer
    ?? withModelRetries(createChatModel(0, modelOptions) as unknown as WorkflowChatModel, options?.sessionId);
  const riskAssessor = options?.riskAssessor
    ?? createToolRiskAssessor(createChatModel(0, modelOptions), options?.sessionId);
  const analyzePrompt = profile.analystGuidance
    ? `${ANALYZE_PROMPT}\n${profile.analystGuidance}`
    : ANALYZE_PROMPT;
  const reviewPrompt = profile.reviewerGuidance
    ? `${REVIEW_PROMPT}\n${profile.reviewerGuidance}`
    : REVIEW_PROMPT;
  const continuousReviewPrompt = profile.reviewerGuidance
    ? `${CONTINUOUS_REVIEW_PROMPT}\n${profile.reviewerGuidance}`
    : CONTINUOUS_REVIEW_PROMPT;

  function observeModel(node: "analyze" | "agent" | "review", response: AIMessage): void {
    try {
      options?.onModelUsage?.(node, response);
    } catch { /* usage 观测失败不能中断业务 */ }
  }

  return {
    profile,
    options: options ?? {},
    planningEnabled,
    tools,
    agentModel,
    analystModel,
    reviewerModel,
    riskAssessor,
    analyzePrompt,
    reviewPrompt,
    continuousReviewPrompt,
    observeModel,
  };
}