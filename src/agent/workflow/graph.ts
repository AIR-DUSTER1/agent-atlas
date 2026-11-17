/**
 * workflow/graph.ts — 图装配与公共入口
 * ============================================================
 * 这是唯一知道节点名称、边连接和 compile 顺序的模块；节点实现只接收 runtime，
 * profile 只描述能力边界，不在这里感知 UI 或服务端。
 */
import { END, START, StateGraph } from "@langchain/langgraph";
import { getCheckpointSaver } from "../../checkpoint.js";
import { createApprovalToolsNode } from "../hitl.js";
import type { AgentProfile } from "../profile.js";
import { createWorkflowRuntime, type WorkflowGraphOptions } from "./runtime.js";
import type { WorkflowModels } from "./types.js";
import { WorkflowState } from "./state.js";
import { createAnalyzeNode } from "./nodes/analyze.js";
import { createClarifyNode } from "./nodes/clarify.js";
import { createRouteNode, createRouteAskNode } from "./nodes/route.js";
import { createAgentNode } from "./nodes/agent.js";
import { createPlanProgressNode } from "./nodes/plan-progress.js";
import { createStopNoticeNode } from "./nodes/stop-notice.js";
import { createReviewNode } from "./nodes/review.js";
import { createDispatchNode } from "./nodes/dispatch.js";
import {
  afterAgent,
  afterAnalyze,
  afterClarify,
  afterDispatch,
  afterPlanProgress,
  afterReview,
  afterRoute,
} from "./edges.js";

/**
 * 构建带需求理解与反思的 ReAct 图。
 * general / estate / job 只提供 profile（提示词 + 工具 allowlist + 审批策略），
 * 避免多套编排逻辑各自漂移；工具执行节点在建图时绑定 profile-local map。
 */
export function createWorkflowGraph(
  profile: AgentProfile,
  models?: WorkflowModels,
  options?: WorkflowGraphOptions,
) {
  const runtime = createWorkflowRuntime(profile, models, options);
  const toolsNode = createApprovalToolsNode({
    tools: runtime.tools,
    approvalDescriptions: profile.approvalDescriptions,
    riskAssessor: runtime.riskAssessor,
    profileId: profile.id,
    toolRetryPolicy: profile.toolRetryPolicy,
  });

  const graph = new StateGraph(WorkflowState)
    .addNode("analyze", createAnalyzeNode(runtime))
    .addNode("clarify", createClarifyNode())
    .addNode("route", createRouteNode(runtime))
    .addNode("routeAsk", createRouteAskNode())
    .addNode("dispatch", createDispatchNode(runtime))
    .addNode("agent", createAgentNode(runtime))
    .addNode("tools", toolsNode)
    .addNode("planProgress", createPlanProgressNode(runtime))
    .addNode("stopNotice", createStopNoticeNode())
    .addNode("review", createReviewNode(runtime))
    .addEdge(START, "analyze")
    .addConditionalEdges("analyze", afterAnalyze)
    .addConditionalEdges("clarify", afterClarify)
    .addConditionalEdges("route", afterRoute)
    .addEdge("routeAsk", "dispatch")
    .addConditionalEdges("dispatch", afterDispatch)
    .addConditionalEdges("agent", afterAgent)
    .addEdge("tools", "planProgress")
    .addConditionalEdges("planProgress", afterPlanProgress)
    .addEdge("stopNotice", END)
    .addConditionalEdges("review", afterReview);

  return graph.compile({
    // 默认挂共享持久检查点（重启续命，见 src/checkpoint.ts）；
    // 子 Agent / 单测可传自建 MemorySaver 保持一次性内存态。
    checkpointer: options?.checkpointer ?? getCheckpointSaver(),
  });
}