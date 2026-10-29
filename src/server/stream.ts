/**
 * ============================================================
 * stream.ts — 把 LangGraph 原始流事件「翻译」成前端友好的 AgentEvent
 * ============================================================
 * 实测（LangGraph JS v1.x）streamMode: ["messages","updates"] 的事件形状：
 *
 *   ["messages",  [ chunk, metadata ]]     ← 模型 token / 整条 ToolMessage
 *   ["updates",   { 节点名: { messages: [...] } }]
 *   ["updates",   { __interrupt__: [{ value: 审批载荷 }] }]
 *
 * 关键结论（均有探针脚本实测）：
 *   1. messages 模式会把子图里的消息也「冒泡」上来，
 *      metadata.langgraph_node 是内层节点名，checkpoint_ns 前缀是父节点名；
 *   2. ToolMessage 在 messages 模式里是「整条」出现，带 tool_call_id 可配对；
 *   3. 子图的 updates 会把进入子图前的整段历史再回显一遍 ——
 *      这里按消息 id 去重（流式 chunk 与最终消息共享同一个 id），杜绝重复渲染。
 */
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentEvent, InterruptPayload } from "./events.js";
import type { PermissionMode } from "../agent/permission.js";
import { log } from "./logging.js";
import { getActiveModelLabel } from "./settings.js";
import { AGENT_RECURSION_LIMIT, config } from "../config.js";
import { incCounter } from "./observability/metrics.js";

/** 这些节点会调用模型，但产出是内部 JSON，不属于用户可见回答，必须过滤。 */
const INTERNAL_LLM_NODES = new Set(["analyze", "clarify", "review", "tools"]);

function nodeSegments(node: string | undefined): string[] {
  return (node ?? "").split(/[/:]/).filter(Boolean);
}

function isInternalNodeName(node: string | undefined): boolean {
  return nodeSegments(node).some((segment) => INTERNAL_LLM_NODES.has(segment));
}

function isToolNodeName(node: string | undefined): boolean {
  return nodeSegments(node).some((segment) => segment === "tools");
}

function looksLikeRiskJson(text: string): boolean {
  const compact = text.replace(/\s+/g, "").toLowerCase();
  return compact.startsWith("{") && compact.includes("highrisk") && compact.includes("reason");
}
function asInterruptPayload(value: unknown): InterruptPayload | null {
  if (!value || typeof value !== "object") return null;
  const type = (value as { type?: unknown }).type;
  return type === "approval" || type === "clarification" ? (value as InterruptPayload) : null;
}


/** 任意 graph.stream() 可用对象（4 个 demo 的图节点名互不相同，泛型互斥，鸭子类型即可） */
type AnyGraph = {
  stream: (input: unknown, options: Record<string, unknown>) => Promise<AsyncIterable<unknown>>;
};

interface NormalizeOptions {
  threadId: string;
  signal?: AbortSignal;
  /** 观测字段：只写结构化日志，不进入模型上下文或前端事件。 */
  agentProfileId?: "general" | "estate" | null;
  turnId?: string;
  /** 会话权限模式：经 configurable 传进图，工具执行节点（hitl.ts）按它裁决 */
  permissionMode?: PermissionMode;
  /** 跨审批任务台账与预算注记：只进入模型 system 注记，不写 checkpoint。 */
  taskLedger?: string;
  budgetNote?: string;
  /** 当前模型总窗口；由路由在请求开始时冻结，避免流中途切换配置。 */
  contextWindow?: number;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 识别供应商的思考内容块。Anthropic 用 type=thinking，部分兼容网关用
 * type=reasoning，Gemini 用 thought=true —— 这些内容不能混进最终回答正文。
 */
function isReasoningBlock(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const block = value as { type?: unknown; thought?: unknown };
  return block.thought === true || block.type === "thinking" || block.type === "reasoning" || block.type === "reasoning_content";
}

/** 从单个 content block 里取纯文本（思考块与正文块共用） */
function blockText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const block = value as { text?: unknown; thinking?: unknown; reasoning?: unknown; content?: unknown };
  for (const candidate of [block.text, block.thinking, block.reasoning, block.content]) {
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

/** 把消息 content（string 或内容块数组）拍平成正文；思考 block 必须排除。 */
function contentText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => !isReasoningBlock(part))
      .map(blockText)
      .join("");
  }
  return "";
}

/**
 * 提取供应商原生思考内容。优先 additional_kwargs.reasoning_content（DeepSeek/
 * OpenCode 等 OpenAI 兼容网关），其次 reasoning 字段与 content 里的 thinking block。
 * 只在供应商确实返回时产出，不把最终回答或内部 JSON 伪装成思考内容。
 */
function reasoningText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const message = msg as {
    content?: BaseMessage["content"];
    additional_kwargs?: { reasoning_content?: unknown; reasoning?: unknown };
    response_metadata?: { reasoning_content?: unknown };
  };
  const direct = [
    message.additional_kwargs?.reasoning_content,
    message.additional_kwargs?.reasoning,
    message.response_metadata?.reasoning_content,
  ];
  for (const value of direct) {
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value)) {
      const text = value.map(blockText).join("");
      if (text) return text;
    }
  }
  if (Array.isArray(message.content)) {
    return message.content.filter(isReasoningBlock).map(blockText).join("");
  }
  return "";
}

/**
 * 从 AI 消息 / 流式 chunk 里提取 token 用量。
 * 标准路径是 usage_metadata（@langchain/openai 由网关的 usage 字段映射而来，
 * input_token_details.cache_read 即「提示词缓存命中」）；
 * 再兜底兼容 response_metadata.tokenUsage / additional_kwargs.tokenUsage 旧形状。
 *
 * 注意流式分片：Anthropic 系网关在 message_start 只给 input_tokens（output=0），
 * 最终 output_tokens 在后面的 message_delta 里且不含 input —— 所以调用方必须
 * 按「节点内累积合并」处理本函数的分片结果（见 runGraphEvents 的 usageAccum）。
 */
function extractUsage(msg: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
} | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as {
    usage_metadata?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_token_details?: { cache_read?: number };
    };
    response_metadata?: { tokenUsage?: Record<string, unknown> };
    additional_kwargs?: { tokenUsage?: Record<string, unknown> };
  };
  const um = m.usage_metadata;
  if (um && (typeof um.input_tokens === "number" || typeof um.output_tokens === "number")) {
    return {
      inputTokens: um.input_tokens,
      outputTokens: um.output_tokens,
      totalTokens: um.total_tokens,
      cacheReadTokens: um.input_token_details?.cache_read,
    };
  }
  const tu = (m.response_metadata?.tokenUsage ?? m.additional_kwargs?.tokenUsage) as
    | { promptTokens?: number; prompt_tokens?: number; completionTokens?: number; completion_tokens?: number; totalTokens?: number; total_tokens?: number; cacheReadTokens?: number; cache_read?: number }
    | undefined;
  const input = tu?.promptTokens ?? tu?.prompt_tokens;
  const output = tu?.completionTokens ?? tu?.completion_tokens;
  if (typeof input === "number" && input > 0) {
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: tu?.totalTokens ?? tu?.total_tokens ?? input + (output ?? 0),
      cacheReadTokens: tu?.cacheReadTokens ?? tu?.cache_read,
    };
  }
  if (typeof output === "number" && output > 0) {
    return { outputTokens: output };
  }
  return null;
}

function extractRiskUsage(msg: ToolMessage): { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; callId?: string } | null {
  const kwargs = msg.additional_kwargs as {
    riskUsage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown; cacheReadTokens?: unknown };
    riskCallId?: unknown;
  } | undefined;
  const usage = kwargs?.riskUsage;
  if (!usage || typeof usage.inputTokens !== "number") return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
    totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : usage.inputTokens,
    cacheReadTokens: typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0,
    callId: typeof kwargs?.riskCallId === "string" ? kwargs.riskCallId : undefined,
  };
}

/** 自主模式低风险放行的审计元数据：来源是同一条 ToolMessage，跨双流按 callId 去重。 */
function extractAutoRiskDecision(msg: ToolMessage): { reason: string; callId?: string } | null {
  const kwargs = msg.additional_kwargs as {
    riskDecision?: unknown;
    riskReason?: unknown;
    riskCallId?: unknown;
  } | undefined;
  if (kwargs?.riskDecision !== "auto") return null;
  return {
    reason: typeof kwargs.riskReason === "string" ? kwargs.riskReason : "审查模型判定为低风险操作",
    callId: typeof kwargs.riskCallId === "string" ? kwargs.riskCallId : undefined,
  };
}

/** 用量分片合并：分片里的 0 值 / 缺失字段不覆盖已有值（Anthropic 末片 input=0、首片 output=0） */
function mergeUsage(
  acc: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number } | null,
  next: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number } | null
) {
  if (!next) return acc;
  const pick = (a: number | undefined, b: number | undefined) =>
    b !== undefined && b > 0 ? b : a ?? 0;
  const input = pick(acc?.inputTokens, next.inputTokens);
  const output = pick(acc?.outputTokens, next.outputTokens);
  const total = input > 0 && output > 0 ? input + output : pick(acc?.totalTokens, next.totalTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: pick(acc?.cacheReadTokens, next.cacheReadTokens),
  };
}

/** 从 messages 模式的 metadata 里取出可读的节点标签（子图显示为 "父节点/内层节点"） */
function nodeLabel(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  const node = typeof meta.langgraph_node === "string" ? meta.langgraph_node : undefined;
  if (!node) return undefined;
  const ns = typeof meta.checkpoint_ns === "string" ? meta.checkpoint_ns : "";
  const parent = ns.split(":")[0] ?? "";
  // 顶层节点的 checkpoint_ns 前缀 === 节点名本身；不一致说明消息来自子图
  return parent && parent !== node ? `${parent}/${node}` : node;
}

/**
 * 递归展开 updates 里的嵌套消息数组（子图回显形如 { researcher: { agent: { messages } } }），
 * 返回 [节点路径, 消息] 对，任何深度都能展开。
 */
function* walkUpdateMessages(
  key: string,
  update: unknown
): Generator<[string, BaseMessage]> {
  if (!update || typeof update !== "object") return;
  if (Array.isArray((update as { messages?: unknown }).messages)) {
    for (const msg of (update as { messages: unknown[] }).messages) {
      if (msg && typeof msg === "object" && "content" in (msg as object)) {
        yield [key, msg as BaseMessage];
      }
    }
    return;
  }
  for (const [childKey, child] of Object.entries(update as Record<string, unknown>)) {
    if (child && typeof child === "object") {
      yield* walkUpdateMessages(`${key}:${childKey}`, child);
    }
  }
}

// ---------------------------------------------------------------------------
// 主转换器
// ---------------------------------------------------------------------------

/**
 * 运行一张图并把原始流事件规范化为 AgentEvent 序列（总是以 done 结尾）。
 *
 * 渲染策略：**内容只认 messages 模式，updates 模式只用来取「步骤节点 + interrupt + 兜底消息」**。
 * 这样完全避开「子图回显整段历史」造成的重复，token 流与最终消息天然不重叠。
 */
export async function* runGraphEvents(
  graph: AnyGraph,
  input: unknown,
  options: NormalizeOptions
): AsyncGenerator<AgentEvent> {
  // 本轮用量事件的模型标注：一次流一次取值（轮中途切模型不影响进行中的流）
  const usageModel = getActiveModelLabel() || undefined;
  const stream = await graph.stream(input, {
    streamMode: ["messages", "updates"],
    // 业务层不限制任务时长 / 调用次数；图运行用 1000 超步兜底，避免正常长任务触发默认 25 步上限。
    recursionLimit: AGENT_RECURSION_LIMIT,
    // permission_mode 会被 LangGraph 透传给每个节点函数的 config（不传 = 默认审批行为）
    configurable: {
      thread_id: options.threadId,
      ...(options.permissionMode ? { permission_mode: options.permissionMode } : {}),
      ...(options.taskLedger ? { task_ledger: options.taskLedger } : {}),
      ...(options.budgetNote ? { task_budget_note: options.budgetNote } : {}),
      ...(options.contextWindow ? { context_window: options.contextWindow } : {}),
    },
    signal: options.signal,
  });

  const streamedIds = new Set<string>();          // messages 模式已流式输出过的正文消息 id
  const streamedReasoningIds = new Set<string>(); // messages 模式已流式输出过的思考消息 id
  const emittedRiskUsageIds = new Set<string>();  // 审查模型 usage 在 messages/updates 双流中的去重
  const emittedRiskDecisionIds = new Set<string>();
  let streamedSinceBoundary = false;              // 距上个「边界消息」（工具结果等）是否已有流式正文
  let toolSeq = 0;                       // 网关不给 tool_call id 时兜底编号
  const toolIds = new Map<number, string>(); // tool_call_chunks 的 index → 事件 id
  const announcedTools = new Set<string>();
  const loggedToolResults = new Set<string>();
  // 用量分片累积（Anthropic 系 input/output 分片到达）；同一调用只落一次快照。
  let usageAccum: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number } | null = null;
  let usageNode: string | undefined;
  let usageCallSeq = 0;
  let usageCallId: string | undefined;
  let usageSignature = "";

  const beginUsageCall = (node: string | undefined) => {
    usageAccum = null;
    usageNode = node;
    usageCallSeq += 1;
    usageCallId = `usage-${usageCallSeq}`;
    usageSignature = "";
  };

  const resetUsageCall = () => {
    usageAccum = null;
    usageNode = undefined;
    usageCallId = undefined;
    usageSignature = "";
  };

  const usageMetricState = new Map<string, { input: number; output: number; cache: number }>();
  const observeUsageMetrics = (
    key: string,
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
    model: string | undefined
  ) => {
    const metricKey = key || "usage";
    const modelLabel = model || config.model || "unknown";
    const previous = usageMetricState.get(metricKey);
    if (!previous) incCounter("agent_model_calls_total", { model: modelLabel, provider: config.protocol });
    const before = previous ?? { input: 0, output: 0, cache: 0 };
    const inputDelta = Math.max(0, usage.inputTokens - before.input);
    const outputDelta = Math.max(0, usage.outputTokens - before.output);
    const cacheDelta = Math.max(0, usage.cacheReadTokens - before.cache);
    if (inputDelta) incCounter("agent_model_tokens_total", { model: modelLabel, type: "input" }, inputDelta);
    if (outputDelta) incCounter("agent_model_tokens_total", { model: modelLabel, type: "output" }, outputDelta);
    if (cacheDelta) incCounter("agent_model_tokens_total", { model: modelLabel, type: "cache_read" }, cacheDelta);
    usageMetricState.set(metricKey, {
      input: Math.max(before.input, usage.inputTokens),
      output: Math.max(before.output, usage.outputTokens),
      cache: Math.max(before.cache, usage.cacheReadTokens),
    });
  };

  for await (const tagged of stream) {
    if (options.signal?.aborted) return;
    if (!Array.isArray(tagged)) continue;
    const [mode, payload] = tagged as [string, unknown];

    // -------------------------------------------------------------
    // messages 模式：模型 token 流 + 整条工具消息
    // -------------------------------------------------------------
    if (mode === "messages" && Array.isArray(payload)) {
      const [msg, meta] = payload as [unknown, Record<string, unknown>];
      const node = nodeLabel(meta);
      const internalNode = isInternalNodeName(node);

      if (msg instanceof AIMessageChunk) {
        // -- token 用量（分片累积合并；Anthropic 系 input/output 分散在多个 chunk）--
        if (node !== usageNode || !usageCallId) beginUsageCall(node);
        usageAccum = mergeUsage(usageAccum, extractUsage(msg));
        if (usageAccum) {
          const signature = `${usageAccum.inputTokens}/${usageAccum.outputTokens}/${usageAccum.cacheReadTokens}`;
          if (signature !== usageSignature) {
            usageSignature = signature;
            observeUsageMetrics(usageCallId ?? usageNode ?? "usage", usageAccum, usageModel);
            yield { type: "usage", ...usageAccum, model: usageModel, callId: usageCallId, node, internal: internalNode };
          }
        }
        // -- 原生思考内容：内部 JSON 节点的正文要过滤，但思考过程仍允许用户查看 --
        const reasoning = reasoningText(msg);
        if (reasoning) {
          if (msg.id) streamedReasoningIds.add(msg.id);
          yield { type: "reasoning", text: reasoning, node };
        }
        if (internalNode) continue;
        // -- 文本 token --
        const text = contentText(msg.content);
        if (text && !looksLikeRiskJson(text)) {
          streamedSinceBoundary = true;
          if (msg.id) streamedIds.add(msg.id);
          yield { type: "token", text, node };
        }
        // -- 工具调用参数流（ZCode 风格：边生成参数边渲染）--
        for (const tc of msg.tool_call_chunks ?? []) {
          let id: string;
          if (tc.id) {
            id = tc.id;
            toolIds.set(tc.index ?? -1, id);
          } else {
            id = toolIds.get(tc.index ?? -1) ?? `tool-${toolSeq++}`;
            toolIds.set(tc.index ?? -1, id);
          }
          const name = typeof tc.name === "string" && tc.name ? tc.name : undefined;
          const frag = typeof tc.args === "string" ? tc.args : tc.args ? JSON.stringify(tc.args) : "";
          if (name && !announcedTools.has(id)) {
            announcedTools.add(id);
            incCounter("agent_tool_calls_total", { tool: name, status: "requested", agentProfileId: options.agentProfileId ?? "none" });
            log("debug", "agent_tool_started", {
              agentProfileId: options.agentProfileId,
              turnId: options.turnId,
              toolName: name,
            });
          }
          if (name || frag) {
            yield { type: "tool_call", id, name, argsFragment: frag };
          }
        }
        continue;
      }

      if (msg instanceof ToolMessage) {
        if (internalNode && !isToolNodeName(node)) continue;
        // 整条工具结果（id 与 tool_call 配对）
        if (msg.id) streamedIds.add(msg.id);
        streamedSinceBoundary = false;
        const resultId = msg.tool_call_id ?? "";
        if (!loggedToolResults.has(resultId)) {
          loggedToolResults.add(resultId);
          incCounter("agent_tool_results_total", { tool: msg.name ?? "unknown", status: msg.status ?? "success", agentProfileId: options.agentProfileId ?? "none" });
          log("debug", "agent_tool_finished", {
            agentProfileId: options.agentProfileId,
            turnId: options.turnId,
            toolName: msg.name ?? "unknown",
            status: msg.status ?? "success",
          });
        }
        const riskUsage = extractRiskUsage(msg);
        const riskUsageKey = riskUsage?.callId || msg.id || resultId;
        if (riskUsage && !emittedRiskUsageIds.has(riskUsageKey)) {
          emittedRiskUsageIds.add(riskUsageKey);
          observeUsageMetrics(riskUsageKey, riskUsage, usageModel);
          yield { type: "usage", ...riskUsage, model: usageModel, node: "tools", internal: true };
        }
        const autoDecision = extractAutoRiskDecision(msg);
        const autoDecisionKey = autoDecision?.callId || msg.id || resultId;
        if (autoDecision && !emittedRiskDecisionIds.has(autoDecisionKey)) {
          emittedRiskDecisionIds.add(autoDecisionKey);
          yield {
            type: "risk_decision",
            decision: "auto",
            toolName: msg.name ?? "unknown",
            reason: autoDecision.reason,
            ...(autoDecision.callId ? { callId: autoDecision.callId } : {}),
          };
        }
        yield {
          type: "tool_result",
          id: resultId,
          content: contentText(msg.content),
          isError: msg.status === "error",
        };
        resetUsageCall(); // 下一次工具返回后的模型请求是新的 API 调用
        continue;
      }
      continue;
    }

    // -------------------------------------------------------------
    // updates 模式：节点徽章 / interrupt / 兜底完整消息
    // -------------------------------------------------------------
    if (mode === "updates" && payload && typeof payload === "object") {
      for (const [nodeKey, update] of Object.entries(payload as Record<string, unknown>)) {
        if (nodeKey === "__interrupt__") {
          const list = (update as Array<{ value?: unknown }>) ?? [];
          for (const item of list) {
            const value = asInterruptPayload(item?.value);
            if (value) {
              incCounter("agent_approvals_total", { tool: value.type === "approval" ? value.toolName : "clarification", agentProfileId: options.agentProfileId ?? "none", outcome: "requested" });
              yield { type: "interrupt", payload: value };
            }
          }
          continue;
        }
        if (!nodeKey.startsWith("__")) {
          log("debug", "agent_step_started", {
            agentProfileId: options.agentProfileId,
            turnId: options.turnId,
            step: nodeKey,
          });
          yield { type: "node", name: nodeKey };
        }
        const internalNode = isInternalNodeName(nodeKey);
        // 兜底：极少数网关不流式返回 token，此时从 updates 里补出完整 AI 消息。
        // 内部 JSON 节点仍会进入循环，以便提取 usage 与原生思考内容，但正文不外泄。
        for (const [, msg] of walkUpdateMessages(nodeKey, update)) {
          if (msg instanceof HumanMessage) continue;
          if (msg instanceof ToolMessage) {
            if (internalNode && !isToolNodeName(nodeKey)) continue;
            if (msg.id) streamedIds.add(msg.id);
            streamedSinceBoundary = false;
            const riskUsage = extractRiskUsage(msg);
            const riskUsageKey = riskUsage?.callId || msg.id || msg.tool_call_id || "risk-usage";
            if (riskUsage && !emittedRiskUsageIds.has(riskUsageKey)) {
              emittedRiskUsageIds.add(riskUsageKey);
              observeUsageMetrics(riskUsageKey, riskUsage, usageModel);
          yield { type: "usage", ...riskUsage, model: usageModel, node: "tools", internal: true };
            }
            const autoDecision = extractAutoRiskDecision(msg);
            const autoDecisionKey = autoDecision?.callId || msg.id || msg.tool_call_id || "risk-decision";
            if (autoDecision && !emittedRiskDecisionIds.has(autoDecisionKey)) {
              emittedRiskDecisionIds.add(autoDecisionKey);
              yield {
                type: "risk_decision",
                decision: "auto",
                toolName: msg.name ?? "unknown",
                reason: autoDecision.reason,
                ...(autoDecision.callId ? { callId: autoDecision.callId } : {}),
              };
            }
            yield {
              type: "tool_result",
              id: msg.tool_call_id ?? "",
              content: contentText(msg.content),
              isError: msg.status === "error",
            };
            resetUsageCall();
            continue;
          }
          if (msg instanceof AIMessage) {
            // 用量在去重前提取：即使这条消息因「子图回显」被跳过，它携带的用量依然有效
            if (nodeKey !== usageNode || !usageCallId) beginUsageCall(nodeKey);
            usageAccum = mergeUsage(usageAccum, extractUsage(msg));
            if (usageAccum) {
              const signature = `${usageAccum.inputTokens}/${usageAccum.outputTokens}/${usageAccum.cacheReadTokens}`;
              if (signature !== usageSignature) {
                usageSignature = signature;
                observeUsageMetrics(usageCallId ?? usageNode ?? "usage", usageAccum, usageModel);
                yield { type: "usage", ...usageAccum, model: usageModel, callId: usageCallId, node: nodeKey, internal: internalNode };
              }
            }
            // 非流式兜底同样保留思考过程；同一消息已流式产出思考时不重复。
            const reasoning = reasoningText(msg);
            if (reasoning && !(msg.id && streamedReasoningIds.has(msg.id))) {
              yield { type: "reasoning", text: reasoning, node: nodeKey.split(":")[0] };
            }
            if (internalNode) continue;
            const text = contentText(msg.content);
            if (!text || looksLikeRiskJson(text)) continue;
            if (msg.id && streamedIds.has(msg.id)) continue; // 已流式输出过 → 去重
            if (!msg.id && streamedSinceBoundary) continue;  // 无 id 且刚流过 → 视为回显
            if (msg.id) streamedIds.add(msg.id);
            if (msg.tool_calls?.length) {
              // 兜底场景里的工具调用：补一张静态卡片
              for (const call of msg.tool_calls) {
                yield { type: "tool_call", id: call.id ?? `tool-${toolSeq++}`, name: call.name, argsFragment: JSON.stringify(call.args ?? {}) };
              }
            }
            streamedSinceBoundary = false;
            yield { type: "ai_message", content: text, node: nodeKey.split(":")[0] };
          }
        }
      }
    }
  }

  yield { type: "done" };
}
