/**
 * ============================================================
 * Demo 3：Human-in-the-loop（人工介入工作流）
 * ============================================================
 * 本 demo 讲解的核心概念：
 *   1. interrupt() —— 在节点内部暂停图的执行，把「决策权」交给人类
 *   2. resume      —— 用 Command({ resume: 值 }) 把人类的决定送回图里继续跑
 *   3. 适用场景    —— 高风险操作（发邮件、付款、删数据）执行前必须人工确认
 *
 * 交互流程：
 *   agent 决定调用 send_email → tools 节点发现是高风险操作
 *     → interrupt() 暂停 → CLI 弹出审批框（y/n）
 *     → 用户批准 → 执行 send_email；用户拒绝 → 生成拒绝结果的 ToolMessage
 *     → 回到 agent 继续总结输出
 *
 * 运行：npm run demo:3
 */
import {
  StateGraph,
  START,
  MessagesAnnotation,
  MemorySaver,
  interrupt,
  Command,
} from "@langchain/langgraph";
import { toolsCondition } from "@langchain/langgraph/prebuilt";
import type { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { ToolMessage as ToolMessageCls } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createChatModel } from "../llm.js";
import { calculator, getCurrentTime, getWeather, sendEmail } from "../tools.js";
import { demoApprovals } from "./approvals.js";
import { createToolMap, type ApprovalDescriptions } from "./profile.js";
import { resolveToolPermission, readonlyDenyText, type PermissionMode } from "./permission.js";
import { createToolRiskAssessor, type ToolRiskAssessment, type ToolRiskAssessor } from "./tool-risk.js";

// ---------------------------------------------------------------------------
// 工具集：多了一个「高风险」的 send_email
// ---------------------------------------------------------------------------
const tools = [calculator, getCurrentTime, getWeather, sendEmail];

/** 传给 interrupt() 的载荷：CLI 根据它渲染审批提示 */
export interface ApprovalRequest {
  type: "approval";
  toolName: string;
  description: string;
  args: Record<string, unknown>;
  /** 自主模式下的 AI 风险判断理由；审批卡会显式展示。 */
  riskReason?: string;
}

export interface ApprovalToolsNodeOptions {
  /** 当前图允许执行的完整工具集；执行节点只认这一份。 */
  tools: StructuredToolInterface[];
  /** 需要人工审批的工具名 → 审批文案；未登记的工具直接执行。 */
  approvalDescriptions: ApprovalDescriptions;
  /** 自主模式的风险评估器；缺失时 fail-closed，登记工具一律申请审批。 */
  riskAssessor?: ToolRiskAssessor;
  /** 领域标识，仅用于风险审查提示。 */
  profileId?: "general" | "estate";
}

/** 把消息 content 拍平为文本，用于给风险审查器补充当前用户意图。 */
function messageText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const block = part as { text?: unknown; content?: unknown };
    if (typeof block.text === "string") return block.text;
    if (typeof block.content === "string") return block.content;
    return "";
  }).join("");
}

/** 稳定序列化对象键顺序，保证同一工具参数得到相同缓存键。 */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function toolCallSignature(name: string, args: unknown): string {
  return `${name}:${stableSerialize(args)}`;
}

interface TurnToolHistory {
  completedBySignature: Map<string, { content: ToolMessage["content"]; status: string }>;
}

/** 只收集最近一条 HumanMessage 之后已成功的工具结果，用于识别完全重复的调用。 */
function turnToolHistory(messages: BaseMessage[]): TurnToolHistory {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].getType() === "human") { start = index + 1; break; }
  }
  const calls = new Map<string, string>();
  const completedBySignature = new Map<string, { content: ToolMessage["content"]; status: string }>();
  for (const message of messages.slice(start)) {
    const ai = message as AIMessage;
    if (Array.isArray(ai.tool_calls)) {
      for (const call of ai.tool_calls) {
        if (!call.id) continue;
        const signature = toolCallSignature(call.name, call.args);
        calls.set(call.id, signature);
      }
    }
    if (message instanceof ToolMessageCls) {
      const signature = calls.get(message.tool_call_id);
      if (signature && message.status !== "error") {
        completedBySignature.set(signature, { content: message.content, status: message.status ?? "success" });
      }
    }
  }
  return { completedBySignature };
}
function lastHumanIntent(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.getType() !== "human") continue;
    return messageText(message.content).replace(/\s+/g, " ").trim().slice(0, 2_000);
  }
  return "";
}
function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface ToolInvocationResult {
  /** 字符串或多模态内容块（截屏工具返回 text + image_url 块），类型对齐 ToolMessage.content */
  content: ToolMessage["content"];
  status: "success" | "error";
}

async function invokeTool(
  toolFn: StructuredToolInterface,
  args: Record<string, unknown>
): Promise<ToolInvocationResult> {
  try {
    const value = await toolFn.invoke(args);
    // 多模态工具（如 computer_screenshot）覆写 invoke 直接返回内容块数组，原样透传
    if (Array.isArray(value)) return { content: value as ToolMessage["content"], status: "success" };
    return { content: toolResultText(value), status: "success" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `工具「${toolFn.name}」执行失败：${message}。请把原因转述给用户，不要重复执行。`,
      status: "error",
    };
  }
}

// ---------------------------------------------------------------------------
// 节点「tools」工厂：手动实现工具执行循环（演示 ToolNode 的内部原理）
//   ★ 高风险工具执行前先 interrupt() 暂停；工具不在 profile allowlist 时
//     fail-closed 返回 ToolMessage，绝不按全局名字去别的 Agent 找工具。
// ---------------------------------------------------------------------------
/** LangGraph 注入节点的 config 子集：只取我们关心的 configurable 权限字段 */
interface NodeConfig {
  configurable?: { permission_mode?: PermissionMode; thread_id?: string };
}

export function createApprovalToolsNode(options: ApprovalToolsNodeOptions) {
  const toolMap = createToolMap(options.tools);
  // interrupt 恢复会重放节点；同一 thread + tool call 的风险判断必须缓存，避免重复计费。
  const riskCache = new Map<string, Promise<ToolRiskAssessment>>();
  const MAX_RISK_CACHE_ENTRIES = 200;
  for (const name of Object.keys(options.approvalDescriptions)) {
    if (!toolMap.has(name)) throw new Error(`Agent 审批项未绑定工具：${name}`);
  }

  return async function approvalToolsNode(state: typeof MessagesAnnotation.State, config?: NodeConfig) {
    // 会话级权限模式由 server 经 graph.stream({ configurable }) 传入；
    // 不传 = approve（引入权限模式之前的默认行为，demo / CLI 路径走这里）
    const permissionMode = config?.configurable?.permission_mode;
    const threadId = config?.configurable?.thread_id || "";
    const lastMessage = state.messages.at(-1) as AIMessage;
    const toolResults: ToolMessage[] = [];
    const userIntent = lastHumanIntent(state.messages);
    const history = turnToolHistory(state.messages);

    // 阶段 2（F8）：把「可直接执行」的调用攒成一批并发跑，审批类仍逐个串行。
    //
    // 为什么这样分：
    //  - 审批必须串行 —— 一次只给用户看一张卡片，否则 interrupt 语义会打架；
    //  - 拒绝（readonly）也是即时判定，归入批处理；
    //  - 真正的收益在 delegate_agent / browser_fetch / 各类 MCP 调用：
    //    模型一轮里发起多个独立子任务时，不必一个跑完再跑下一个。
    type ToolCallItem = NonNullable<typeof lastMessage.tool_calls>[number];
    const parallelBatch: Array<{
      callIndex: number;
      call: ToolCallItem;
      action: "run" | "deny";
      toolFn: StructuredToolInterface;
    }> = [];

    for (const [callIndex, call] of (lastMessage.tool_calls ?? []).entries()) {
      const signature = toolCallSignature(call.name, call.args);
      const prior = history.completedBySignature.get(signature);
      if (prior) {
        toolResults.push(new ToolMessageCls({
          content: `检测到重复工具调用，已复用本轮上一次「${call.name}」的结果，未重复执行。\n${toolResultText(prior.content)}`.slice(0, 12_000),
          tool_call_id: call.id ?? "",
          name: call.name,
          status: prior.status === "error" ? "error" : "success",
        }));
        continue;
      }
      const toolFn = toolMap.get(call.name);
      if (!toolFn) {
        // 模型可能伪造或残留旧工具调用：只返回模型可读的拒绝结果，不 throw 穿透图。
        toolResults.push(new ToolMessageCls({
          content: `当前 Agent 不支持工具「${call.name}」，未执行。请改用当前可用工具或直接回答。`,
          tool_call_id: call.id ?? "",
          name: call.name,
          status: "error",
        }));
        continue;
      }

      const action = resolveToolPermission(permissionMode, call.name, options.approvalDescriptions);
      // 可并行的三类：只读拒绝（立即有结论）、auto/未登记审批的直接执行、自主低风险。
      // interrupt 类必须留在外面串行处理。
      if (action === "deny" || action === "run") {
        parallelBatch.push({ callIndex, call, action, toolFn });
        continue;
      }
      const description = options.approvalDescriptions[call.name]?.(call.args as Record<string, unknown>)
        || `执行工具 ${call.name}`;
      let shouldInterrupt = action === "interrupt";
      let riskReason: string | undefined;
      let riskUsage: ToolRiskAssessment["usage"];
      let riskCallId: string | undefined;
      if (action === "assess") {
        const cacheKey = `${threadId}|${call.name}|${stableSerialize(call.args)}|${userIntent}`;
        let pendingAssessment = riskCache.get(cacheKey);
        if (!pendingAssessment) {
          if (riskCache.size >= MAX_RISK_CACHE_ENTRIES) {
            const oldest = riskCache.keys().next().value;
            if (oldest) riskCache.delete(oldest);
          }
          pendingAssessment = options.riskAssessor
            ? options.riskAssessor({
                toolName: call.name,
                description,
                args: call.args as Record<string, unknown>,
                userIntent,
                profileId: options.profileId,
              })
            : Promise.resolve({
                highRisk: true,
                reason: "自主风险评估器未配置，已按高风险处理",
                failed: true,
              });
          riskCache.set(cacheKey, pendingAssessment);
        }
        const assessment = await pendingAssessment;
        shouldInterrupt = assessment.highRisk;
        riskReason = assessment.reason;
        riskUsage = assessment.usage;
        riskCallId = `risk:${threadId}:${call.id || callIndex}`;
      }

      let content: ToolInvocationResult["content"];
      let status: "success" | "error" = "success";
      if (shouldInterrupt) {
        // interrupt() 的参数会原样出现在流输出里（__interrupt__），
        // 返回值则是 CLI / Web 通过 Command({ resume }) 传回来的内容。
        const decision = interrupt<ApprovalRequest, "approve" | "reject">({
          type: "approval",
          toolName: call.name,
          description,
          args: call.args as Record<string, unknown>,
          ...(riskReason ? { riskReason } : {}),
        });
        if (decision === "approve") {
          const result = await invokeTool(toolFn, call.args);
          content = result.content;
          status = result.status;
        } else {
          content = `用户拒绝了本次 ${call.name} 操作，不要执行。`;
        }
      } else {
        // 自主模式判定为低风险：直接执行（其余「可直接执行」的已在批处理里）
        const result = await invokeTool(toolFn, call.args);
        content = result.content;
        status = result.status;
      }
      toolResults.push(new ToolMessageCls({
        content,
        tool_call_id: call.id ?? "",
        name: call.name,
        status,
        ...(riskUsage ? {
          additional_kwargs: {
            riskUsage,
            riskCallId,
          },
        } : {}),
      }));
      if (status === "success") history.completedBySignature.set(signature, { content, status });
    }

    // ── 批量并发执行「可直接执行」的调用（F8 阶段 2）──
    // 并发不改变结果顺序：按原始 tool_calls 下标回填，模型看到的顺序与它发起的一致。
    if (parallelBatch.length) {
      const settled = await Promise.all(
        parallelBatch.map(async (item) => {
          if (item.action === "deny") {
            // 只读会话：改世界操作直接拒绝，让模型转述而不是反复重试
            return { item, content: readonlyDenyText(item.call.name), status: "error" as const };
          }
          const result = await invokeTool(item.toolFn, item.call.args);
          return { item, content: result.content, status: result.status };
        })
      );
      for (const entry of settled) {
        toolResults.push(new ToolMessageCls({
          content: entry.content,
          tool_call_id: entry.item.call.id ?? "",
          name: entry.item.call.name,
          status: entry.status,
        }));
        if (entry.status === "success") {
          history.completedBySignature.set(toolCallSignature(entry.item.call.name, entry.item.call.args), { content: entry.content, status: entry.status });
        }
      }
    }

    // 把工具结果追加进消息历史，agent 下一轮才能「看到结果并总结」
    return { messages: toolResults };
  };
}

export function createHitlGraph(sessionId?: string) {
  // ★ 模型在建图时创建：Web 端修改供应商/模型后，新建会话即用新配置
  const model = createChatModel(0, { sessionId }).bindTools(tools);
  const riskAssessor = createToolRiskAssessor(createChatModel(0, { sessionId }));
  const toolsNode = createApprovalToolsNode({ tools, approvalDescriptions: demoApprovals, riskAssessor });

  // 节点「agent」：与 Demo 1 相同，让模型决定回答还是调工具
  async function agentNode(state: typeof MessagesAnnotation.State) {
    const response = await model.invoke(state.messages);
    return { messages: [response] };
  }

  // interrupt/resume 依赖 checkpointer 保存「暂停时的状态」，所以必须有
  const checkpointer = new MemorySaver();

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition)
    .addEdge("tools", "agent")
    .compile({ checkpointer });

  return graph;
}

/** 供 CLI / Web 使用：把用户的审批结果或澄清选择「喂」回被暂停的图 */
export function buildResumeCommand(value: string) {
  // Command 的泛型参数：Resume 值类型 / Update / 目标节点。
  // 纯 resume 命令不涉及 goto 路由，这里显式给三个 any 省略类型推断。
  return new Command<any, any, any>({ resume: value });
}
