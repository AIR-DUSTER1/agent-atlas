/**
 * ============================================================
 * tools-team.ts — 生产级多 Agent 委派工具
 * ============================================================
 * 主 Agent 通过 delegate_agent 动态创建一次子执行：
 *   delegate_agent({ agent, task, prompt, tools })
 *     → 校验启用状态、模型、工具分配
 *     → 组装一次性子 Profile
 *     → runSubagent 在独立 thread 中执行
 *     → 结构化结果作为 ToolMessage 回填主对话
 *
 * 设计立场：
 *  - 子代理身份/模型由设置页管理，专项提示词与工具由主 Agent 每次赋予；
 *  - 可分配工具只来自当前安全目录，未知 / 已停用工具一律拒绝；
 *  - delegate_agent 永不出现在工具目录中，深度固定为 1；
 *  - 委派本身是审批项，审批文案必须完整展示目标、工具与提示词摘要；
 *  - 父请求取消信号透传到子图，不留下不可取消的后台任务。
 */
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { runSubagent, type SubagentResult, type SubagentRunOptions } from "./agent/subagent.js";
import type { AgentProfile, ApprovalDescriptions } from "./agent/profile.js";
import { findSubagent, getEnabledSubagents } from "./subagent-state.js";
import { resolveModelRuntime, type ModelRuntimeConfig } from "./model-runtime.js";
import { describeDelegableTools, type DelegableToolEntry } from "./delegation-catalog.js";

const SUBAGENT_SYSTEM_RULES = [
  "你是主 Agent 在运行时创建的后台子代理。",
  "- 只执行本次任务，不请求用户澄清，不声称拥有未赋予的工具或权限。",
  "- 信息不足时采用合理假设，并在结果开头列明假设。",
  "- 不准再次委派子代理。",
  "- 完成时直接给出可交付结论；不要复述任务书，不要输出内部 JSON。",
].join("\n");

function buildAgentCatalogText(): string {
  const agents = getEnabledSubagents();
  if (!agents.length) return "（当前没有启用的子代理）";
  return agents
    .map((agent) => `- ${agent.id}: ${agent.name} — ${agent.description}`)
    .join("\n");
}

function buildToolCatalogText(entries: readonly DelegableToolEntry[]): string {
  const text = describeDelegableTools(entries);
  return text || "（本次运行没有可分配工具，子代理只能进行纯推理）";
}

function selectTools(
  requested: readonly string[],
  catalog: readonly DelegableToolEntry[],
): { entries: DelegableToolEntry[]; error?: string } {
  const byName = new Map(catalog.map((entry) => [entry.tool.name, entry]));
  const seen = new Set<string>();
  const entries: DelegableToolEntry[] = [];
  for (const raw of requested) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const entry = byName.get(name);
    if (!entry) {
      return {
        entries: [],
        error: `委派失败：工具「${name}」不在当前可分配目录中。可用工具：${[...byName.keys()].join("、") || "无"}。`,
      };
    }
    entries.push(entry);
  }
  return { entries };
}

function buildSubagentProfile(
  displayName: string,
  prompt: string,
  entries: readonly DelegableToolEntry[],
): AgentProfile {
  const approvalDescriptions: ApprovalDescriptions = {};
  for (const entry of entries) {
    if (entry.approvalDescription) approvalDescriptions[entry.tool.name] = entry.approvalDescription;
  }
  return {
    id: "general",
    displayName,
    systemPrompt: `${SUBAGENT_SYSTEM_RULES}\n\n主 Agent 赋予的专项指令：\n${prompt}`,
    tools: entries.map((entry) => entry.tool),
    approvalDescriptions,
    analystGuidance: [
      "这是无交互子代理任务：理解主 Agent 与用户目标后直接执行，不要请求澄清。",
      "工具只允许使用当前 Profile 绑定的子集；缺失能力就给出可执行替代方案。",
    ].join("\n"),
    reviewerGuidance: [
      "检查结果是否完成主 Agent 赋予的专项指令，是否基于实际工具结果，是否明确说明假设、限制和失败。",
      "不要把未执行的操作描述成已完成。",
    ].join("\n"),
    contextPolicy: {
      maxRecentMessages: 10_000,
      maxToolResultChars: 8_000,
    },
  };
}

export interface TeamToolFactoryOptions {
  /** 单测可注入假执行器；生产省略，固定走 runSubagent。 */
  run?: (profile: AgentProfile, task: string, options: SubagentRunOptions) => Promise<SubagentResult>;
  /** 父图建图时冻结的主对话模型；inherit 必须继承这份快照而不是可变全局状态。 */
  parentModelRuntime?: ModelRuntimeConfig;
}

/**
 * 创建本次建图对应的委派工具。设置页变更后 bumpConfigVersion，下一条消息
 * 会用新的子代理列表和安全工具目录重新创建。
 */
export function createTeamTools(
  catalog: readonly DelegableToolEntry[],
  options: TeamToolFactoryOptions = {},
) {
  const agents = getEnabledSubagents();
  if (!agents.length) return [];

  const agentCatalog = buildAgentCatalogText();
  const toolCatalog = buildToolCatalogText(catalog);
  const agentIds = agents.map((agent) => agent.id);
  const toolNames = catalog.map((entry) => entry.tool.name);

  return [tool(
    async (input, config?: RunnableConfig) => {
      const agent = findSubagent(input.agent);
      if (!agent || !agent.enabled) {
        return `委派失败：子代理「${input.agent}」不存在或已停用。可用子代理：${agentIds.join("、")}。`;
      }

      const selection = selectTools(input.tools, catalog);
      if (selection.error) return selection.error;

      const modelRuntime = agent.model.mode === "inherit" && options.parentModelRuntime
        ? options.parentModelRuntime
        : resolveModelRuntime(agent.model);
      if (!modelRuntime) {
        return agent.model.mode === "fixed"
          ? `委派失败：子代理「${agent.name}」固定的供应商/模型已不存在，请到「设置 → 子代理」修正。`
          : "委派失败：当前主对话模型不可解析，请检查模型与供应商配置。";
      }

      const profile = buildSubagentProfile(agent.name, input.prompt.trim(), selection.entries);
      const result = await (options.run ?? runSubagent)(profile, input.task, {
        modelRuntime,
        signal: config?.signal,
      });

      return JSON.stringify({
        ...result,
        agent: agent.id,
        agentName: agent.name,
        assignedTools: selection.entries.map((entry) => entry.tool.name),
        modelMode: agent.model.mode,
      });
    },
    {
      name: "delegate_agent",
      description:
        "把独立子任务委派给一个已启用的子代理。你必须同时赋予本次任务提示词和工具子集；" +
        "子代理拥有独立上下文，只回传结构化结论。工具必须从下方目录中选择，不能越权；" +
        "一次委派会启动多轮模型调用，执行前需要用户批准。\n\n" +
        `可用子代理：\n${agentCatalog}\n\n可分配工具：\n${toolCatalog}`,
      schema: z.object({
        agent: z.string().min(1).describe(`子代理 id，可选：${agentIds.join("、")}`),
        task: z.string().min(1).describe("完整任务书：目标、范围、输入、约束与期望输出。"),
        prompt: z.string().min(1).describe("本次子代理的专项系统提示词：角色、方法、质量标准与禁止事项。"),
        tools: z.array(z.string()).describe(`本任务允许使用的工具名子集，可选：${toolNames.join("、") || "无"}`),
      }),
    },
  )];
}
