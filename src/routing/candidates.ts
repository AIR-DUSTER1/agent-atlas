/**
 * ============================================================
 * routing/candidates.ts — 从子代理配置导出路由候选
 * ============================================================
 * 职责：把只读的子代理快照（subagent-state.ts）投影成路由层需要的候选列表，
 * 并负责「这个 agent 能不能参与竞争」的判定。
 *
 * 设计立场：
 *  - 兜底型 agent（没有关键词、也没有类别）不参与竞争：它是「谁都不合适时」的
 *    落点，不是候选。让兜底 agent 参与打分会让所有请求都变成「有候选」，
 *    快速路径与守卫全部失真；
 *  - 路由候选只取决于启用状态与路由元数据，不读模型配置（那是派发阶段的事）。
 */
import type { SubagentConfig } from "../subagent-state.js";
import type { RoutingCandidate, SubagentRouting } from "./types.js";

/** 一条路由名片是否具备「参与竞争」的最低信息量。 */
export function isCompetitive(routing: SubagentRouting): boolean {
  return routing.keywords.some((item) => item.trim()) || Boolean(routing.category?.trim());
}

/**
 * 生成候选列表。`exclude` 用于转回场景：已经试过的 agent 不再进入候选，
 * 避免 A→B→A 绕圈。
 */
export function buildRoutingCandidates(
  agents: readonly SubagentConfig[],
  exclude: readonly string[] = [],
): RoutingCandidate[] {
  const blocked = new Set(exclude);
  return agents
    .filter((agent) => agent.enabled && !blocked.has(agent.id))
    .filter((agent) => isCompetitive(agent.routing))
    .map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      description: agent.description,
      routing: agent.routing,
    }));
}

/** 类别查询：给分层归并使用；找不到类别时返回空串（归入「其他」）。 */
export function categoryLookup(agents: readonly SubagentConfig[]): (agentId: string) => string {
  const map = new Map(agents.map((agent) => [agent.id, agent.routing.category?.trim() ?? ""]));
  return (agentId: string) => map.get(agentId) ?? "";
}
