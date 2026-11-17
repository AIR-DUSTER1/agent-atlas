/**
 * ============================================================
 * workflow.ts — 产品级 Agent 编排公共门面
 * ============================================================
 * 具体状态、提示词、解析器、节点和图装配拆在 ./workflow/ 下；本文件只保留稳定
 * 导出路径，避免外部调用方和测试随内部模块调整而迁移。
 *
 * 约束：本文件属于 agent 层，只做 re-export，不直接定义节点、图或外部 IO。
 */
export type {
  ClarificationOption,
  ClarificationQuestion,
  ClarificationRequest,
  WorkflowChatModel,
  WorkflowModels,
} from "./workflow/types.js";
export { parseRequirementAnalysis, parseReviewResult, defaultAssumption } from "./workflow/parsing.js";
export { createWorkflowGraph } from "./workflow/graph.js";