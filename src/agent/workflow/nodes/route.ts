/**
 * workflow/nodes/route.ts — 路由决策与路由询问节点
 * ============================================================
 * route 只读取规则/向量/模型结果；routeAsk 使用 interrupt()，两者保持分离，
 * 这样审批 resume 不会把有副作用的派发节点重跑一次。
 */
import { interrupt } from "@langchain/langgraph";
import { isRoutingEnabled } from "../../../routing/state.js";
import { runRouteStep } from "../../../routing/route-step.js";
import { MAX_QUESTION_TEXT, MAX_USER_TEXT } from "../limits.js";
import { lastHumanText } from "../message-utils.js";
import type { WorkflowStateType } from "../state.js";
import type { WorkflowRuntime } from "../runtime.js";
import type { ClarificationRequest } from "../types.js";

type RouteNodeConfig = {
  signal?: AbortSignal;
  configurable?: { headless?: boolean };
};

export function createRouteNode(runtime: WorkflowRuntime) {
  return async function routeNode(state: WorkflowStateType, nodeConfig?: RouteNodeConfig) {
    if (!isRoutingEnabled()) return { routeDecision: null };
    const userText = lastHumanText(state.messages).slice(0, MAX_USER_TEXT);
    if (!userText.trim()) return { routeDecision: null };

    const result = await runRouteStep({
      text: userText,
      sessionKind: runtime.profile.id === "estate" ? "estate" : "agent",
      handoffCount: state.handoffCount,
      exclude: state.routeHistory,
      signal: nodeConfig?.signal,
    });
    const decision = result.decision;
    // 无头模式没人能回答询问：退化成当前 agent 处理，不留悬挂。
    if (decision.kind === "ask" && nodeConfig?.configurable?.headless === true) {
      return {
        routeDecision: {
          ...decision,
          kind: "main" as const,
          reason: `${decision.reason}（无头模式无人确认，改由当前 Agent 处理）`,
        },
      };
    }
    return { routeDecision: decision };
  };
}

/**
 * 询问节点：把路由候选做成本轮澄清卡。
 * 复用 clarify 的 ClarificationRequest 形状，前端无需新组件。
 * 用户选择后写进 routeDecision.agentId，再交给 dispatch（不重新路由，避免来回问）。
 */
export function createRouteAskNode() {
  return async function routeAskNode(state: WorkflowStateType) {
    const decision = state.routeDecision;
    if (!decision || decision.kind !== "ask") return {};
    const top = decision.candidates.slice(0, 3);
    const options = [
      ...top.map((candidate, index) => ({
        id: String.fromCharCode(65 + index),
        label: `交给「${candidate.name}」`,
        description: `按该子代理的专项能力处理（匹配分 ${candidate.score.toFixed(2)}）`,
      })),
      { id: String.fromCharCode(65 + Math.min(top.length, 3)), label: "由当前 Agent 直接处理", description: "不使用子代理" },
    ];
    const request: ClarificationRequest = {
      type: "clarification",
      questions: [{
        id: "route",
        question: `路由：${decision.reason}`.slice(0, MAX_QUESTION_TEXT + 20),
        options,
        allowCustom: true,
      }],
    };
    const answer = interrupt<ClarificationRequest, string>(request);
    const raw = typeof answer === "string" ? answer.trim() : String(answer ?? "").trim();
    const picked = options.find((option) => option.id === raw);
    const index = picked ? options.indexOf(picked) : -1;
    const chosen = index >= 0 && index < top.length ? top[index] : null;
    return {
      routeDecision: {
        ...decision,
        kind: "dispatch" as const,
        layer: "fallback" as const,
        ...(chosen ? { agentId: chosen.agentId, agentName: chosen.name } : {}),
        reason: chosen
          ? `用户选择「${chosen.name}」。`
          : `用户选择由当前 Agent 处理（自定义输入：${raw.slice(0, 200)}）`,
      },
      // 用户自己指定了方向，就不再让路由层二次猜测。
      routeHistory: [...state.routeHistory],
    };
  };
}