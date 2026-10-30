/**
 * delegation-catalog.ts — 主 Agent 可分配给子代理的工具目录
 * ============================================================
 * 职责：把当前主 Agent 已经启用的工具，加上找房插件提供的 house_* 工具，
 * 组合成一次委派可分配的能力集合；每项同时携带审批文案。
 *
 * 设计立场：
 *  - 目录只决定「可以选什么」，真正绑定到子代理的仍是本次请求显式选择的子集；
 *  - delegate_agent 永不进入目录，确保委派深度固定为 1；
 *  - 未启用插件的工具不出现，防止通过子代理绕过插件开关；
 *  - 重名工具装配期失败，不静默选择其中一个。
 */
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ApprovalDescriptions } from "./agent/profile.js";
import { estateApprovals } from "./agent/approvals.js";
import { estateTools } from "./tools-estate.js";
import { isPluginEnabled } from "./plugin-state.js";

export interface DelegableToolEntry {
  tool: StructuredToolInterface;
  approvalDescription?: (args: Record<string, unknown>) => string;
}

const NEVER_DELEGABLE = new Set(["delegate_agent", "memory_save", "memory_recall"]);

export function buildDelegationCatalog(input: {
  parentTools: readonly StructuredToolInterface[];
  parentApprovals: ApprovalDescriptions;
  externalTools?: readonly StructuredToolInterface[];
  externalApprovals?: ApprovalDescriptions;
}): DelegableToolEntry[] {
  const entries: DelegableToolEntry[] = [];
  const names = new Set<string>();

  const add = (tool: StructuredToolInterface, approvals: ApprovalDescriptions): void => {
    if (NEVER_DELEGABLE.has(tool.name)) return;
    if (names.has(tool.name)) throw new Error(`可委派工具名重复：${tool.name}`);
    names.add(tool.name);
    entries.push({ tool, approvalDescription: approvals[tool.name] });
  };

  for (const tool of input.parentTools) add(tool, input.parentApprovals);
  for (const tool of input.externalTools ?? []) add(tool, input.externalApprovals ?? {});
  if (isPluginEnabled("estate")) {
    for (const tool of estateTools) add(tool, estateApprovals);
  }
  return entries;
}

/** 给主 Agent / 委派工具描述使用；只暴露名称与简短作用，不泄露参数细节。 */
export function describeDelegableTools(entries: readonly DelegableToolEntry[]): string {
  return entries
    .map((entry) => {
      const description = entry.tool.description.replace(/\s+/g, " ").trim();
      return `- ${entry.tool.name}: ${description}`;
    })
    .join("\n");
}
