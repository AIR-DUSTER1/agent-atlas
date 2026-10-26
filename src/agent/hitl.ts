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
import type { AIMessage, ToolMessage } from "@langchain/core/messages";
import { ToolMessage as ToolMessageCls } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createChatModel } from "../llm.js";
import { calculator, getCurrentTime, getWeather, sendEmail } from "../tools.js";
import { demoApprovals } from "./approvals.js";
import { createToolMap, type ApprovalDescriptions } from "./profile.js";
import { resolveToolPermission, readonlyDenyText, type PermissionMode } from "./permission.js";

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
}

export interface ApprovalToolsNodeOptions {
  /** 当前图允许执行的完整工具集；执行节点只认这一份。 */
  tools: StructuredToolInterface[];
  /** 需要人工审批的工具名 → 审批文案；未登记的工具直接执行。 */
  approvalDescriptions: ApprovalDescriptions;
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
  configurable?: { permission_mode?: PermissionMode };
}

export function createApprovalToolsNode(options: ApprovalToolsNodeOptions) {
  const toolMap = createToolMap(options.tools);
  for (const name of Object.keys(options.approvalDescriptions)) {
    if (!toolMap.has(name)) throw new Error(`Agent 审批项未绑定工具：${name}`);
  }

  return async function approvalToolsNode(state: typeof MessagesAnnotation.State, config?: NodeConfig) {
    // 会话级权限模式由 server 经 graph.stream({ configurable }) 传入；
    // 不传 = approve（引入权限模式之前的默认行为，demo / CLI 路径走这里）
    const permissionMode = config?.configurable?.permission_mode;
    const lastMessage = state.messages.at(-1) as AIMessage;
    const toolResults: ToolMessage[] = [];

    for (const call of lastMessage.tool_calls ?? []) {
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
      let content: ToolInvocationResult["content"];
      let status: "success" | "error" = "success";
      if (action === "deny") {
        // 只读会话：改世界操作直接拒绝，让模型转述而不是反复重试
        content = readonlyDenyText(call.name);
        status = "error";
      } else if (action === "interrupt") {
        // interrupt() 的参数会原样出现在流输出里（__interrupt__），
        // 返回值则是 CLI / Web 通过 Command({ resume }) 传回来的内容。
        const decision = interrupt<ApprovalRequest, "approve" | "reject">({
          type: "approval",
          toolName: call.name,
          description: options.approvalDescriptions[call.name](call.args as Record<string, unknown>),
          args: call.args as Record<string, unknown>,
        });
        if (decision === "approve") {
          const result = await invokeTool(toolFn, call.args);
          content = result.content;
          status = result.status;
        } else {
          content = `用户拒绝了本次 ${call.name} 操作，不要执行。`;
        }
      } else {
        // 未登记审批（只读工具）或 auto 权限：直接执行
        const result = await invokeTool(toolFn, call.args);
        content = result.content;
        status = result.status;
      }

      toolResults.push(new ToolMessageCls({
        content,
        tool_call_id: call.id ?? "",
        name: call.name,
        status,
      }));
    }

    // 把工具结果追加进消息历史，agent 下一轮才能「看到结果并总结」
    return { messages: toolResults };
  };
}

export function createHitlGraph(sessionId?: string) {
  // ★ 模型在建图时创建：Web 端修改供应商/模型后，新建会话即用新配置
  const model = createChatModel(0, { sessionId }).bindTools(tools);
  const toolsNode = createApprovalToolsNode({ tools, approvalDescriptions: demoApprovals });

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
