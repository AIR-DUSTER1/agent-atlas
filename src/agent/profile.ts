/**
 * profile.ts — Agent 能力边界与工具装配契约
 * ============================================================
 * profile 只描述「这个 Agent 允许什么」：身份、提示词、工具 allowlist、审批文案。
 * 不执行 IO、不建图；general / estate 各自导出 profile，workflow 只消费 profile。
 *
 * 关键约束：工具执行必须使用 profile 自己的 tools 建 local map，
 * 禁止再引入全局 toolsByName，否则隔离退化成 prompt 约束。
 */
import type { StructuredToolInterface } from "@langchain/core/tools";

export type AgentProfileId = "general" | "estate";

export type ApprovalDescriptions = Record<string, (args: Record<string, unknown>) => string>;

export interface AgentContextPolicy {
  /** 送给模型的最近消息上限；工具结果按字符预算再裁剪。 */
  maxRecentMessages: number;
  /** 单条 ToolMessage 进入模型上下文前的字符上限。 */
  maxToolResultChars: number;
}

export interface AgentProfile {
  id: AgentProfileId;
  displayName: string;
  systemPrompt: string;
  /** 当前 profile 允许模型调用的全部工具；执行节点只认这一份。 */
  tools: StructuredToolInterface[];
  /** 需要人工审批的工具名 → 审批卡片文案。未登记的工具直接执行。 */
  approvalDescriptions: ApprovalDescriptions;
  /** 可选：追加到需求分析 / 结果反思提示词的领域规则。 */
  analystGuidance?: string;
  reviewerGuidance?: string;
  /** 可选：消息与工具结果预算；未配置时使用 workflow 的安全默认值。 */
  contextPolicy?: Partial<AgentContextPolicy>;
}

/** 会话 kind 到 profile 的派生规则；demo / external 没有可执行 profile。 */
export function profileIdForKind(kind: "agent" | "estate" | "demo" | "external"): AgentProfileId | null {
  if (kind === "agent") return "general";
  if (kind === "estate") return "estate";
  return null;
}

export function isAgentProfileId(value: unknown): value is AgentProfileId {
  return value === "general" || value === "estate";
}

/** 每个图实例自建的工具表；同名工具在装配期直接失败，避免静默覆盖。 */
export function createToolMap(tools: StructuredToolInterface[]): Map<string, StructuredToolInterface> {
  const map = new Map<string, StructuredToolInterface>();
  for (const item of tools) {
    if (map.has(item.name)) throw new Error(`Agent 工具名重复：${item.name}`);
    map.set(item.name, item);
  }
  return map;
}
