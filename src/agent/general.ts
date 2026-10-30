/**
 * ============================================================
 * general.ts — 通用 Agent（应用的默认形态）
 * ============================================================
 * 产品定位：本项目不只是学习 Demo，而是一个可正常使用的 Agent 应用。
 * 这个图就是「正常使用逻辑」的合成形态，把各学习示例的能力组合到一起：
 *
 *   - ReAct 循环（示例 1）：思考 → 调用工具 → 观察结果 → 继续思考
 *   - Checkpointer 记忆（示例 2）：同一会话多轮共享上下文
 *   - 人工审批（示例 3）：send_email 等高风险工具执行前 interrupt，等用户批准
 *   - 文件上下文（files.ts）：用户 📎 附加的文件内容随消息进入上下文
 *   - 需求理解 / 澄清 / 反思（workflow.ts）：先确认需求，再执行 ReAct，最后检查结果
 *
 * 与示例的差异：示例是「拆解版」（有的故意不带 checkpointer 展示无记忆的
 * 行为差异），这里全部按真实使用的方式组装。
 */
import { calculator, getCurrentTime, getWeather, sendEmail } from "../tools.js";
import { terminal, readFileTool, writeFileTool, listDirTool, grepSearch } from "../tools-dev.js";
import { computerTools } from "../tools-computer.js";
import { teamTools } from "../tools-team.js";
import { memoryTools } from "../tools-memory.js";
import { retrieveDocs } from "../tools-rag.js";
import { browserFetch } from "../tools-web.js";
import { generalApprovals } from "./approvals.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentProfile, ApprovalDescriptions } from "./profile.js";
import { createWorkflowGraph } from "./workflow.js";
import { isPluginEnabled } from "../plugin-state.js";

/** 不受插件开关影响的通用 Agent 基础工具。 */
const baseTools: StructuredToolInterface[] = [
  // 基础工具
  calculator, getCurrentTime, getWeather, sendEmail,
  // 编程/开发工具（terminal 与 write_file 为高风险，走人工审批）
  terminal, readFileTool, writeFileTool, listDirTool, grepSearch,
  // 多智能体协同（delegate_agent：委派子 Agent 后台跑独立子任务，需审批；
  // 子 Agent 强制只读 + 不可再委派，见 subagent.ts）
  ...teamTools,
  // 跨会话长期记忆（memory_save/recall 只写本服务记忆文件，低风险直接执行）
  ...memoryTools,
  // 网页内容抓取（只读：纯 HTTP GET + 剥标签；内网默认拒，防 SSRF）
  browserFetch,
];

/** 插件工具组：静态快照用于目录/测试，实际建图时按 enabled 状态过滤。 */
const pluginToolSets: Array<{ id: "computer" | "rag"; tools: StructuredToolInterface[] }> = [
  { id: "computer", tools: computerTools },
  { id: "rag", tools: [retrieveDocs] },
];

/** 兼容旧测试与能力目录的完整工具快照；运行时请使用 generalProfileWithPlugins()。 */
const tools: StructuredToolInterface[] = [...baseTools, ...pluginToolSets.flatMap((entry) => entry.tools)];

const SYSTEM_PROMPT = [
  "你是一个实用的中文 AI 编程助手，运行在 LangGraph.js 的 ReAct 循环上，工作目录是当前项目根。",
  "- 需要计算、查时间、查天气时调用对应工具，不要凭空编造事实",
  "- 编程任务优先使用开发工具：terminal 执行命令（构建/测试/git），read_file 读代码，" +
    "grep_search 搜索代码，list_dir 看目录结构，write_file 创建或修改文件",
  "- 用户问及项目文档、需求/设计说明、团队资料等知识库内容时，调用 retrieve_docs 检索" +
    "（外部 RAG 服务，只读）；片段带来源与分数，回答请标注来源，检索不到就如实说明",
  "- 需要读某个网页/在线文档/报错页面时调用 browser_fetch（只读，直接执行）；" +
    "它只拿静态 HTML 正文，读不到纯 JS 渲染的页面 —— 那种情况如实说明，不要编造页面内容",
  "- read_file / list_dir / grep_search 直接执行；terminal 和 write_file 是高风险操作，" +
    "系统会在你调用后自动请求用户确认，你无需额外追问",
  "- 用户附加了文件时，基于附件内容回答（在消息中以「--- 附件 N: 名 ---」标注，可能超长截断）",
  "- 电脑控制：先 computer_screenshot 看屏幕并确认坐标，再 click/type/key/scroll 操作；" +
    "这些动作是高风险操作，系统会请求用户确认（会话切到只读权限时会被直接拒绝，切到自动权限则直接执行）",
  "- 多智能体协同：独立的信息收集或跨域子任务（如查房产行情）可用 delegate_agent 委派子 Agent 后台执行" +
    "（子 Agent 只读、独立上下文、结果以文本返回）；自己几个工具能完成的事不要委派",
  "- 发送邮件同样属于高风险操作，会先请求用户确认",
  "- 跨会话长期记忆：用户表达长期偏好、项目事实或纠正既往回答时（「以后都…」「记住…」），" +
    "立即调用 memory_save 记录；每轮上下文里已带【跨会话长期记忆】清单，回答时遵循它，" +
    "与当前对话冲突时以用户最新说法为准（并更新记忆）",
  "- 回答简洁准确，代码放在 Markdown 代码块里",
].join("\n");

/**
 * 外部工具槽（MCP 等）：由 server 层在启动/配置变更时注入。
 *
 * 为什么用可变的槽而不是参数：agent 层禁止 import server/*（AGENTS.md §3），
 * 所以「有哪些 MCP 工具」不能由这里去问 server。反向由 server 把工具推进来，
 * 是最小耦合的接法。读取时做快照（见 generalProfileWithExternal），
 * 避免构建图的过程中槽被并发改写。
 */
let externalTools: StructuredToolInterface[] = [];
let externalApprovals: ApprovalDescriptions = {};

export function setExternalTools(
  tools: StructuredToolInterface[],
  approvals: ApprovalDescriptions
): void {
  externalTools = tools;
  externalApprovals = approvals;
}

export function currentExternalTools(): StructuredToolInterface[] {
  return externalTools;
}

/** 通用 profile 的能力边界：只含开发 / 知识库 / 基础工具，绝不包含 house_*。 */
export const generalProfile: AgentProfile = {
  id: "general",
  displayName: "通用 Agent",
  systemPrompt: SYSTEM_PROMPT,
  tools,
  approvalDescriptions: generalApprovals,
  analystGuidance: [
    "通用编程任务补充规则：",
    "- 能通过搜索、列目录或读文件定位目标时先执行工具，不要先问用户。",
    "- 用户明确要求「只分析 / 不要修改」时，禁止把 write_file 或会改文件的 terminal 动作视为可执行默认值。",
    "- 缺少目标对象、修改范围冲突或验证方式会实质改变结果时，才请求澄清。",
  ].join("\n"),
  reviewerGuidance: [
    "通用编程任务补充检查：",
    "- 是否直接回答了用户目标，并覆盖所有明确要求。",
    "- 是否把未执行的工具、未运行的测试或未验证的结论说成已完成。",
    "- 涉及代码修改时，是否说明改了什么、如何验证、还有哪些风险。",
  ].join("\n"),
  contextPolicy: {
    // 历史条数只做极端防线；实际装多少由当前模型窗口的 token 预算决定。
    maxRecentMessages: 10_000,
    maxToolResultChars: 8_000,
  },
};

/** 只保留当前工具 allowlist 中真实存在的审批项，避免禁用插件后装配期报错。 */
function boundApprovals(
  approvals: ApprovalDescriptions,
  activeTools: StructuredToolInterface[],
): ApprovalDescriptions {
  const names = new Set(activeTools.map((tool) => tool.name));
  return Object.fromEntries(
    Object.entries(approvals).filter(([name]) => names.has(name)),
  );
}

/** 当前插件状态对应的内置工具；开关变化后下一次建图自动生效。 */
function activePluginTools(): StructuredToolInterface[] {
  return pluginToolSets
    .filter((entry) => isPluginEnabled(entry.id))
    .flatMap((entry) => entry.tools);
}

/** 动态系统提示：关闭的插件明确告知模型不可调用，避免提示词与工具表互相矛盾。 */
function promptForPlugins(): string {
  const disabled = pluginToolSets
    .filter((entry) => !isPluginEnabled(entry.id))
    .map((entry) => entry.id === "rag" ? "知识库检索" : "电脑控制");
  return disabled.length
    ? `${SYSTEM_PROMPT}\n- 当前已停用插件：${disabled.join("、")}。不要调用对应工具；用户要求时说明需在「设置 → 插件」中启用。`
    : SYSTEM_PROMPT;
}

/** 运行时可用的通用 profile：基础工具 + 已启用插件 + 已注入 MCP 工具。 */
export function generalProfileWithPlugins(): AgentProfile {
  const activeTools = [...baseTools, ...activePluginTools()];
  return {
    ...generalProfile,
    systemPrompt: promptForPlugins(),
    tools: activeTools,
    approvalDescriptions: boundApprovals(generalApprovals, activeTools),
  };
}

/**
 * 取「当前生效」的 profile：内置工具 + 已注入的外部工具（MCP）。
 * 每次建图都重新拼，这样新接入的 MCP server 在下一条消息就生效。
 * 外部工具名重复时直接抛错（装配期失败，不静默覆盖内置工具）。
 */
export function generalProfileWithExternal(): AgentProfile {
  const base = generalProfileWithPlugins();
  if (!externalTools.length) return base;
  const names = new Set(base.tools.map((t) => t.name));
  for (const t of externalTools) {
    if (names.has(t.name)) throw new Error(`外部工具与内置工具重名：${t.name}`);
    names.add(t.name);
  }
  return {
    ...base,
    tools: [...base.tools, ...externalTools],
    approvalDescriptions: { ...base.approvalDescriptions, ...externalApprovals },
  };
}

export function createAgentGraph(sessionId?: string) {
  // 模型与 checkpointer 都在建图时创建；换配置后由 sessions.rebuildIfStale 重建。
  // sessionId 会变成 OpenCode 等网关的路由头，不能所有会话复用同一个值。
  return createWorkflowGraph(generalProfileWithExternal(), undefined, { sessionId });
}
