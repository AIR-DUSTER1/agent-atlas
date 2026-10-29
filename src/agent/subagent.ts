/**
 * ============================================================
 * subagent.ts — 子 Agent 执行器（多智能体协同的运行核心）
 * ============================================================
 * 把「委派一个子任务」变成一次可复用的执行：用目标 profile 的 workflow
 * 子图（analyze→ReAct→review）跑完任务，返回最终回答文本。
 *
 * 设计立场（阶段 1 的三条安全默认，见 wiki §3.24）：
 *   1. 强制只读 —— permission_mode 固定 readonly 传入子图，写操作一律被
 *      权限闸门拒绝；需要改世界的操作由主 Agent 自己走完整审批链；
 *   2. 深度 = 1 —— 子 profile 剔除 delegate_agent 工具，子 Agent 不能再委派，
 *      防递归套娃与配额失控；
 *   3. 黑盒交互 —— 子图在工具函数内运行，interrupt 无法冒泡给用户：
 *      澄清 interrupt 与超时一律转成「模型可读的中文错误」让主 Agent 另想办法
 *      （自己回答 / 把任务拆细重试），绝不静默挂死。
 *
 * 上下文隔离：每次委派独立的 threadId + 全新 MemorySaver，子 Agent 看不到
 * 主会话历史（只看到任务书），主会话也只看到截断后的结果文本。
 *
 * 约束：agent 层，不 import server/*；不 import 具体 profile（由调用方传入，
 * 避免与 general.ts ↔ tools-team.ts 形成 import 环）。
 */
import { randomUUID } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createWorkflowGraph, type WorkflowModels } from "./workflow.js";
import { clearModelRetryRecords } from "../model-retry.js";
import type { AgentProfile } from "./profile.js";

/** 子 Agent 整体超时：子图含多轮模型调用与工具执行，给足但不无限等 */
const SUBAGENT_TIMEOUT_MS = 180_000;
/** 子 Agent 结果回填主上下文的字符上限（超长截头保尾，结论通常在尾部） */
const MAX_RESULT_CHARS = 4_000;
/** 任务书长度上限 */
const MAX_TASK_CHARS = 2_000;

/** 委派工具名：子 profile 剔除它以实现深度 = 1 */
export const DELEGATE_TOOL_NAME = "delegate_agent";

/** 追加到子 profile 的需求分析规则：子 Agent 不能向用户提问 */
const SUBAGENT_ANALYST_RULES = [
  "你是被主 Agent 委派的子 Agent，运行在无人工交互的后台：",
  "- 任何情况下都不要请求澄清（understood 永远输出 true）；",
  "- 信息不足时按合理假设继续并在结果开头说明假设；",
  "- 你是只读权限，写操作会被系统拒绝，不要尝试；",
  "- 完成后直接给出结论，不要复述任务。",
].join("\n");

export interface SubagentResult {
  ok: boolean;
  /** 最终回答文本（ok=false 时为模型可读的中文失败说明） */
  text: string;
  durationMs: number;
  /**
   * 子 Agent 用过的工具名（按调用顺序去重）。
   * 前端委派卡据此展示「它干了什么」—— 子 Agent 的完整对话仍是黑盒，
   * 但「用了哪几个工具」足以让用户判断这个结论可不可信。
   */
  toolsUsed?: string[];
}

/** 子 Agent 不能携带的工具名（深度 1 + 防污染）：委派自身 + 跨会话记忆写入 */
const SUBAGENT_EXCLUDED_TOOLS = [DELEGATE_TOOL_NAME, "memory_save", "memory_recall"];

/** 构造子 Agent 专用 profile 副本：剔除受限工具 + 追加黑盒分析规则 */
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

/** 从子图的消息历史里抽出用过的工具名（按首次出现顺序去重） */
function collectToolsUsed(messages: Array<{ tool_calls?: Array<{ name?: string }> }>): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      const name = call?.name;
      if (typeof name !== "string" || !name || seen.has(name)) continue;
      seen.add(name);
      order.push(name);
    }
  }
  return order;
}

/**
 * 运行一次子 Agent 任务。失败不 throw（工具层约定 §5.4）：转成中文错误文本，
 * 让主 Agent 决定是自己接手还是把任务描述得更具体后重试。
 * models 参数供测试注入假模型；生产路径由 createWorkflowGraph 内部建真实模型。
 */
export async function runSubagent(
  profile: AgentProfile,
  task: string,
  models?: WorkflowModels
): Promise<SubagentResult> {
  const startedAt = Date.now();
  const trimmedTask = task.trim().slice(0, MAX_TASK_CHARS);
  if (!trimmedTask) {
    return { ok: false, text: "委派失败：任务书为空，请写明目标与期望输出。", durationMs: 0 };
  }

  // 子 Agent 是一次性后台执行：显式传自建 MemorySaver（不落盘），
  // 避免每次委派把整段子任务消息写进共享的 checkpoints.ndjson。
  const threadId = `subagent-${randomUUID()}`;
  const graph = createWorkflowGraph(subagentProfileOf(profile), models, {
    checkpointer: new MemorySaver(),
    sessionId: threadId,
  });

  let finalState: unknown;
  try {
    try {
      // 任务书作为子图的唯一用户消息：analyze 据此判断需求，agent 据此执行
      finalState = await graph.invoke(
        { messages: [new HumanMessage(trimmedTask)] },
        {
          configurable: { thread_id: threadId, permission_mode: "readonly" },
          signal: AbortSignal.timeout(SUBAGENT_TIMEOUT_MS),
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = /timeout|timed out|aborted?/i.test(message);
      return {
        ok: false,
        text: timedOut
          ? `子 Agent 执行超时（${Math.round(SUBAGENT_TIMEOUT_MS / 1000)}s），已终止。建议把任务拆小后重试，或由你直接完成。`
          : `子 Agent 执行失败：${message.slice(0, 200)}。请把原因转述给用户，不要盲目重试。`,
        durationMs: Date.now() - startedAt,
      };
    }

    // 黑盒执行中子图仍可能触发澄清 interrupt（模型无视「不要提问」规则）——
  // 无法向用户冒泡，转为可重试的明确错误，而不是返回半截结果。
    const state = finalState as { messages?: Array<{ content: unknown; getType?: () => string }>; __interrupt__?: unknown[] };
    if (state?.__interrupt__?.length) {
      return {
        ok: false,
        text: "子 Agent 中途请求澄清，但后台执行无法交互。请把任务描述得更具体（给足对象/范围/期望格式）后重试，或由你直接回答。",
        durationMs: Date.now() - startedAt,
      };
    }

    const messages = state?.messages ?? [];
    const lastAi = [...messages].reverse().find((m) => m.getType?.() === "ai");
    const answer = contentToText(lastAi?.content).trim();
    if (!answer) {
      return {
        ok: false,
        text: "子 Agent 没有产出有效结论（可能全是工具调用轮）。请重试一次或由你直接完成。",
        durationMs: Date.now() - startedAt,
      };
    }

    const clipped = answer.length > MAX_RESULT_CHARS
      ? `…（前文已省略）${answer.slice(-MAX_RESULT_CHARS)}`
      : answer;
    return {
      ok: true,
      text: `${clipped}\n\n（子 Agent ${profile.displayName} · 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    // 子图没有 SSE 消费者；成功与失败路径都不能让重试队列残留。
    clearModelRetryRecords(threadId);
  }
}
