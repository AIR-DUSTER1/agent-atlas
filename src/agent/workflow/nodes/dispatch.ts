/**
 * workflow/nodes/dispatch.ts — 路由派发子代理节点
 * ============================================================
 * 该节点有副作用，必须独立于 interrupt；程序化派发只授予只读工具，
 * 写操作仍回到主 Agent 的 HITL 审批路径。
 */
import { defaultModelRuntime } from "../../../model-runtime.js";
import { buildDelegationCatalog } from "../../../delegation-catalog.js";
import { renderBriefing, parseOutOfScope } from "../../../routing/briefing.js";
import { findSubagent } from "../../../subagent-state.js";
import { dispatchToAgent } from "../../../tools-team.js";
import { MAX_BRIEF_TEXT, MAX_USER_TEXT, MAX_WORKING_BRIEF } from "../limits.js";
import { lastHumanText } from "../message-utils.js";
import type { WorkflowRuntime } from "../runtime.js";
import type { WorkflowStateType } from "../state.js";

export function createDispatchNode(runtime: WorkflowRuntime) {
  return async function dispatchNode(state: WorkflowStateType, nodeConfig?: { signal?: AbortSignal }) {
    const decision = state.routeDecision;
    if (!decision || decision.kind !== "dispatch" || !decision.agentId) return {};
    const agent = findSubagent(decision.agentId);
    if (!agent || !agent.enabled) {
      return {
        routeDecision: {
          ...decision,
          kind: "main" as const,
          layer: "fallback" as const,
          reason: `目标子代理「${decision.agentId}」已不存在或已停用，由当前 Agent 处理。`,
        },
      };
    }

    const catalog = buildDelegationCatalog({
      parentTools: runtime.profile.tools,
      parentApprovals: runtime.profile.approvalDescriptions,
      // 房产会话本身已经绑了 house_*，再补一次会触发重名保护。
      includeEstateTools: runtime.profile.id !== "estate",
    });
    const readonlyEntries = catalog.filter((entry) => !entry.approvalDescription);

    const userText = lastHumanText(state.messages).slice(0, MAX_USER_TEXT);
    const briefing = renderBriefing({
      background: userText.slice(0, MAX_BRIEF_TEXT),
      goal: userText.slice(0, MAX_BRIEF_TEXT),
      tools: readonlyEntries.map((entry) => entry.tool.name),
      routing: agent.routing,
    });

    const result = await (runtime.options.dispatchRunner ?? dispatchToAgent)({
      agent,
      task: userText,
      prompt: briefing,
      tools: readonlyEntries.map((entry) => entry.tool.name),
      entries: readonlyEntries,
      modelRuntime: runtime.options.modelRuntime ?? defaultModelRuntime(),
      ...(nodeConfig?.signal ? { signal: nodeConfig.signal } : {}),
    });

    const outOfScope = parseOutOfScope(result.text);
    // handoffCount 记的是「转回次数」，不是「派发次数」：
    // 第一次派发不算转回（routeHistory 当时还是空的），之后的派发都算一次转回。
    const isReroute = state.routeHistory.length > 0;
    const nextHandoff = isReroute ? state.handoffCount + 1 : state.handoffCount;
    const history = state.routeHistory.includes(agent.id)
      ? state.routeHistory
      : [...state.routeHistory, agent.id];

    return {
      routeHistory: history,
      handoffCount: nextHandoff,
      // 子代理结论作为「已知事实」交给主 Agent 收尾，而不是直接当最终回答：
      // 主 Agent 还要校验、补齐、组织语言（R7 的「主 agent 收尾」）。
      dispatchBrief: [
        `【已派发给子代理「${agent.name}」】`,
        result.ok ? result.text : `子代理执行失败：${result.text}`,
        outOfScope ? "（该子代理声明了超出范围的部分，见上）" : "",
        `（用时 ${Math.round(result.durationMs / 1000)} 秒，用到工具：${result.toolsUsed.join("、") || "无"}）`,
      ].filter(Boolean).join("\n").slice(0, MAX_WORKING_BRIEF),
    };
  };
}