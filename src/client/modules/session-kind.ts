/**
 * modules/session-kind.ts — 会话类型的能力判定（客户端唯一来源）
 * ============================================================
 * 职责：回答「这种会话有没有 Agent 执行力」这类跨模块问题。
 * 设计立场：
 *  - 新增 Agent 类型（如 job）时，只改这一个文件；
 *  - 之前每个调用点各写一份 `kind === "agent" || kind === "estate"`，
 *    加求职 Agent 时漏改 navigation.ts，导致会话里看不到权限切换 chip、
 *    压缩后旧 checkpoint 线程不清理、重启后不注入历史上下文三处不一致。
 */

import type { SessionKind } from "./types-api.js";

/**
 * 有 Agent 执行力的会话：走 workflow 图、绑工具、受权限模式约束。
 * demo 是教学示例（自建图、无审批登记），external 是外部 Agent（不经过本仓库的图）。
 */
export const AGENT_KINDS = ["agent", "estate", "job"] as const satisfies readonly SessionKind[];

export type AgentKind = (typeof AGENT_KINDS)[number];

export function isAgentKind(kind: SessionKind | null | undefined): kind is AgentKind {
  return kind === "agent" || kind === "estate" || kind === "job";
}
