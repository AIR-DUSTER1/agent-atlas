/**
 * ============================================================
 * subagent.ts — 子 Agent 执行器（多智能体协同的运行核心）
 * ============================================================
 * 把一次委派变成独立子图执行：目标 Profile 由主 Agent 在运行时赋予提示词、
 * 工具子集与模型快照，子图完成后只回填结构化结论，不污染主会话消息。
 *
 * 设计立场：
 *   1. 深度 = 1 —— 子 Profile 强制剔除 delegate_agent，禁止递归套娃；
 *   2. 工具最小授权 —— 子图只绑定本次主 Agent 显式选择的工具子集；
 *   3. 父级可取消 —— 客户端停止 / 断连信号透传到所有模型与工具调用；
 *   4. 黑盒交互 —— 后台子图不能弹澄清，缺信息时按假设执行或明确失败；
 *   5. 不设业务级时长、任务长度或结果长度上限，长任务由父请求取消与模型窗口治理。
 *
 * 约束：agent 层不 import server/*；模型解析与配置持久化均由上层注入。
 */
import { randomUUID } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { AGENT_RECURSION_LIMIT } from "../config.js";
import { createWorkflowGraph, type WorkflowModels } from "./workflow.js";
import { clearModelRetryRecords } from "../model-retry.js";
import { defaultModelRuntime, type ModelRuntimeConfig } from "../model-runtime.js";
import type { AgentProfile } from "./profile.js";

/** 委派工具名：子 profile 剔除它以实现深度 = 1 */
export const DELEGATE_TOOL_NAME = "delegate_agent";

/** 追加到子 profile 的需求分析规则：子 Agent 不能向用户提问 */
const SUBAGENT_ANALYST_RULES = [
  "你是被主 Agent 委派的子 Agent，运行在没有实时人工交互的后台：",
  "- 任何情况下都不要请求澄清（understood 永远输出 true）；",
  "- 信息不足时按合理假设继续，并在结果开头说明关键假设；",
  "- 只能使用本次主 Agent 赋予的工具；不得声称拥有未授予的能力；",
  "- 不能再次委派子 Agent；",
  "- 完成后直接给出可交付结论，不要复述任务。",
].join("\n");

export interface SubagentUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
}

export interface SubagentResult {
  ok: boolean;
  /** 最终回答文本（ok=false 时为模型可读的中文失败说明） */
  text: string;
  durationMs: number;
  /** 子 Agent 配置 id 与实际使用的模型显示名 */
  agentId: string;
  model: string;
  /** 子 Agent 用过的工具名（按调用顺序去重）。 */
  toolsUsed: string[];
  /** 可从子图消息中观测到的 usage；内部 analyze/review 调用由父流统一观测。 */
  usage?: SubagentUsage;
}

export interface SubagentRunOptions {
  /** 测试注入假模型；生产路径由 createWorkflowGraph 按 modelRuntime 创建。 */
  models?: WorkflowModels;
  /** 委派开始时冻结的模型快照；默认继承当前 config，便于 CLI / 单测。 */
  modelRuntime?: ModelRuntimeConfig;
  /** 父请求取消信号，必须透传到子图。 */
  signal?: AbortSignal;
}

/** 子 Agent 不能携带的工具名：禁止递归委派；长期记忆写入/读取统一由主 Agent 收口。 */
const SUBAGENT_EXCLUDED_TOOLS = [DELEGATE_TOOL_NAME, "memory_save", "memory_recall"];

/** 构造子 Agent 专用 profile 副本：剔除递归委派 + 追加黑盒分析规则。 */
export function subagentProfileOf(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    id: profile.id,
    tools: profile.tools.filter((item) => !SUBAGENT_EXCLUDED_TOOLS.includes(item.name)),
    analystGuidance: [
      ...(profile.analystGuidance ? [profile.analystGuidance] : []),
      SUBAGENT_ANALYST_RULES,
    ].join("\n"),
  };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
      return "";
    })
    .join("");
}

interface SubgraphMessage {
  id?: string;
  content: unknown;
  tool_calls?: Array<{ name?: string }>;
  usage_metadata?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_token_details?: { cache_read?: number };
  };
  getType?: () => string;
}

/** 从子图消息历史里抽出用过的工具名（按首次出现顺序去重）。 */
function collectToolsUsed(messages: SubgraphMessage[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      const name = call?.name;
      if (typeof name !== "string" || !name || seen.has(name)) continue;
      seen.add(name);
      order.push(name);
    }
  }
  return order;
}

function usageFromMessage(message: unknown): SubagentUsage | null {
  const usage = (message as SubgraphMessage | null)?.usage_metadata;
  if (!usage) return null;
  return {
    calls: 1,
    inputTokens: Math.max(0, Number(usage.input_tokens) || 0),
    outputTokens: Math.max(0, Number(usage.output_tokens) || 0),
    totalTokens: Math.max(0, Number(usage.total_tokens) || 0),
    cacheReadTokens: Math.max(0, Number(usage.input_token_details?.cache_read) || 0),
  };
}

function sumUsage(items: readonly SubagentUsage[]): SubagentUsage | undefined {
  if (!items.length) return undefined;
  return items.reduce<SubagentUsage>((total, item) => ({
    calls: total.calls + item.calls,
    inputTokens: total.inputTokens + item.inputTokens,
    outputTokens: total.outputTokens + item.outputTokens,
    totalTokens: total.totalTokens + item.totalTokens,
    cacheReadTokens: total.cacheReadTokens + item.cacheReadTokens,
  }), { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 });
}

/** 回退路径：从子图最终消息里提取 usage；同一 message id 只计一次。 */
function collectUsage(messages: SubgraphMessage[]): SubagentUsage | undefined {
  const seen = new Set<string>();
  const items: SubagentUsage[] = [];
  for (const message of messages) {
    const usage = usageFromMessage(message);
    if (!usage) continue;
    const key = message.id || `${usage.inputTokens}:${usage.outputTokens}:${usage.totalTokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(usage);
  }
  return sumUsage(items);
}

function isAbortFailure(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /abort|cancel(?:led)?|取消/i.test(message);
}

/**
 * 运行一次子 Agent 任务。失败不 throw（工具层约定 §5.4）：转成中文错误文本，
 * 让主 Agent 决定接手、拆分或明确告知用户。
 */
export async function runSubagent(
  profile: AgentProfile,
  task: string,
  options: SubagentRunOptions = {},
): Promise<SubagentResult> {
  const startedAt = Date.now();
  const trimmedTask = task.trim();
  const modelRuntime = options.modelRuntime ?? defaultModelRuntime();
  const canceled = (text: string): SubagentResult => ({
    ok: false,
    text,
    durationMs: Date.now() - startedAt,
    agentId: profile.id,
    model: modelRuntime.label,
    toolsUsed: [],
  });

  if (!trimmedTask) return canceled("委派失败：任务书为空，请写明目标与期望输出。");
  if (options.signal?.aborted) return canceled("子 Agent 已取消：父请求在启动前已经终止。 ");

  // 子 Agent 是一次性执行：显式自建 MemorySaver，不把内部消息写入共享检查点。
  const threadId = `subagent-${randomUUID()}`;
  const observedUsage: SubagentUsage[] = [];
  const graph = createWorkflowGraph(subagentProfileOf(profile), options.models, {
    checkpointer: new MemorySaver(),
    sessionId: threadId,
    modelRuntime,
    onModelUsage: (_node, response) => {
      const usage = usageFromMessage(response);
      if (usage) observedUsage.push(usage);
    },
  });

  let finalState: unknown;
  try {
    try {
      finalState = await graph.invoke(
        { messages: [new HumanMessage(trimmedTask)] },
        {
          recursionLimit: AGENT_RECURSION_LIMIT,
          configurable: {
            thread_id: threadId,
            // 委派本身已经过父图审批，批准即授权本次显式工具子集；
            // 子图不能弹卡，因此用 auto 执行，工具边界由 allowlist 强制。
            permission_mode: "auto",
            context_window: modelRuntime.contextWindow,
          },
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return canceled(isAbortFailure(err, options.signal)
        ? "子 Agent 已取消：父请求已终止。"
        : `子 Agent 执行失败：${message.slice(0, 500)}。请把原因转述给用户，不要盲目重试。`);
    }

    const state = finalState as { messages?: SubgraphMessage[]; __interrupt__?: unknown[] };
    if (state?.__interrupt__?.length) {
      return canceled("子 Agent 中途请求澄清，但后台执行无法交互。请把任务描述得更具体后重试，或由你直接回答。");
    }

    const messages = state?.messages ?? [];
    const lastAi = [...messages].reverse().find((message) => message.getType?.() === "ai");
    const answer = contentToText(lastAi?.content).trim();
    if (!answer) {
      return cancelledResult("子 Agent 没有产出有效结论（可能全是工具调用轮）。请重试一次或由你直接完成。");
    }

    return {
      ok: true,
      text: answer,
      durationMs: Date.now() - startedAt,
      agentId: profile.id,
      model: modelRuntime.label,
      toolsUsed: collectToolsUsed(messages),
      usage: sumUsage(observedUsage) ?? collectUsage(messages),
    };
  } finally {
    // 子图没有 SSE 消费者；成功与失败路径都不能让重试队列残留。
    clearModelRetryRecords(threadId);
  }

  function cancelledResult(text: string): SubagentResult {
    return {
      ok: false,
      text,
      durationMs: Date.now() - startedAt,
      agentId: profile.id,
      model: modelRuntime.label,
      toolsUsed: collectToolsUsed(stateMessages(finalState)),
      usage: sumUsage(observedUsage) ?? collectUsage(stateMessages(finalState)),
    };
  }
}

function stateMessages(state: unknown): SubgraphMessage[] {
  return (state as { messages?: SubgraphMessage[] } | null)?.messages ?? [];
}
