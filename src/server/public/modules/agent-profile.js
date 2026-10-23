/**
 * agent-profile.js — 前端 Agent profile 元数据（零依赖）
 * ============================================================
 * 只用 agentProfileId 决定展示名称 / 图标 / 短标签；kind 仅用于 demo、external
 * 和旧会话兼容，不在各个 UI 组件里散落回答「这是不是通用/房产 Agent」。
 */
export const AGENT_PROFILES = Object.freeze({
  general: Object.freeze({
    id: "general",
    label: "通用 Agent",
    shortLabel: "通用",
    icon: "⚡",
    description: "编程工具 · 文件上下文 · 知识库 · 多轮记忆 · 人工审批",
    example: "直接输入任何问题即可开始",
  }),
  estate: Object.freeze({
    id: "estate",
    label: "租房 / 房产 Agent",
    shortLabel: "找房",
    icon: "🏠",
    description: "贝壳官方数据 · 找房对比 · 区位地图 · 户型图 · 预约审批",
    example: "帮我在北京租个两居室",
  }),
});

export function agentProfileMeta(agentProfileId) {
  return typeof agentProfileId === "string" && AGENT_PROFILES[agentProfileId]
    ? AGENT_PROFILES[agentProfileId]
    : null;
}

/** 新会话优先看 agentProfileId；旧会话/本地缓存缺失时按 kind 派生。 */
export function profileMetaForSession(session) {
  const direct = agentProfileMeta(session?.agentProfileId);
  if (direct) return direct;
  if (session?.kind === "agent") return AGENT_PROFILES.general;
  if (session?.kind === "estate") return AGENT_PROFILES.estate;
  return null;
}
