/**
 * workflow/edges.ts — 图条件边
 * ============================================================
 * 条件边只读取图状态和当前路由设置，不调用模型、不产生副作用。
 */
import { END } from "@langchain/langgraph";
import type { AIMessage } from "@langchain/core/messages";
import { isRoutingEnabled, getRoutingSettings } from "../../routing/state.js";
import { shouldDispatch } from "../../routing/route-step.js";
import { OUT_OF_SCOPE_MARKER } from "../../routing/briefing.js";
import { toolResultsStopTurn } from "../turn-stop.js";
import type { WorkflowStateType } from "./state.js";

/**
 * 派发后：还能转回就回到 route（排除已试过的 agent），否则交主 Agent 收尾。
 *
 * 判定只看「本轮是否出现过超出范围」+「转回额度」：
 * dispatchBrief 里有 outOfScope 段落才代表子代理明确说「我做不了」，
 * 普通成功不需要重新路由。
 */
export function afterDispatch(state: WorkflowStateType): "route" | "agent" {
  if (!state.dispatchBrief.includes(OUT_OF_SCOPE_MARKER)) return "agent";
  const limit = getRoutingSettings().limits.maxHandoffs;
  return state.handoffCount < limit ? "route" : "agent";
}

export function afterRoute(state: WorkflowStateType): "routeAsk" | "dispatch" | "agent" {
  const decision = state.routeDecision;
  if (!decision) return "agent";
  if (decision.kind === "ask") return "routeAsk";
  if (shouldDispatch(decision)) return "dispatch";
  return "agent";
}

export function afterAnalyze(state: WorkflowStateType): "clarify" | "route" | "agent" {
  // 路由未启用时直接进 agent：不产出空的 route 节点徽章，行为与引入前一致。
  if (!isRoutingEnabled()) return state.clarification ? "clarify" : "agent";
  return state.clarification ? "clarify" : "route";
}

/** 澄清之后同样按开关决定进不进路由节点，避免关闭时多一个空节点徽章。 */
export function afterClarify(): "route" | "agent" {
  return isRoutingEnabled() ? "route" : "agent";
}

export function afterAgent(state: WorkflowStateType): "tools" | "review" {
  const last = state.messages.at(-1) as AIMessage | undefined;
  return last?.tool_calls?.length ? "tools" : "review";
}

export function afterPlanProgress(state: WorkflowStateType): "stopNotice" | "agent" {
  return toolResultsStopTurn(state.messages) ? "stopNotice" : "agent";
}

export function afterReview(state: WorkflowStateType): "agent" | typeof END {
  return state.reviewFeedback ? "agent" : END;
}