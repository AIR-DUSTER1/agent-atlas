/**
 * ============================================================
 * general.ts — 通用 Agent（应用的默认形态）
 * ============================================================
 * 产品定位：通用 Agent 是主执行者，负责需求理解、工具调用、审批与最终回答。
 * 多 Agent 采用「主 Agent 动态赋权」模式：子代理的身份与模型来自设置页，
 * 每次委派的专项提示词与工具子集由主 Agent 决定。
 */
import { calculator, getCurrentTime, getWeather, sendEmail } from "../tools.js";
import { terminal, readFileTool, writeFileTool, listDirTool, grepSearch } from "../tools-dev.js";
import { computerTools } from "../tools-computer.js";
import { memoryTools } from "../tools-memory.js";
import { retrieveDocs } from "../tools-rag.js";
import { browserFetch } from "../tools-web.js";
import { createTeamTools } from "../tools-team.js";
import { buildDelegationCatalog } from "../delegation-catalog.js";
import { generalApprovals } from "./approvals.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentProfile, ApprovalDescriptions } from "./profile.js";
import { createWorkflowGraph } from "./workflow.js";
import type { ModelRuntimeConfig } from "../model-runtime.js";
import { isPluginEnabled } from "../plugin-state.js";

/** 不受插件开关影响的通用 Agent 基础工具。 */
const baseTools: StructuredToolInterface[] = [
  calculator, getCurrentTime, getWeather, sendEmail,
  terminal, readFileTool, writeFileTool, listDirTool, grepSearch,
  ...memoryTools,
  browserFetch,
];

/** 插件工具组：静态快照用于目录/测试，实际建图时按 enabled 状态过滤。 */
const pluginToolSets: Array<{ id: "computer" | "rag"; tools: StructuredToolInterface[] }> = [
  { id: "computer", tools: computerTools },
  { id: "rag", tools: [retrieveDocs] },
];

const SYSTEM_PROMPT = [
  "你是一个实用的中文 AI 编程助手，运行在 LangGraph.js 的 ReAct 循环上，工作目录是当前项目根。",
  "- 需要计算、查时间、查天气时调用对应工具，不要凭空编造事实",
  "- 编程任务优先使用开发工具：terminal 执行命令（构建/测试/git），read_file 读代码，grep_search 搜索代码，list_dir 看目录结构，write_file 创建或修改文件",
  "- 用户问及项目文档、需求/设计说明、团队资料等知识库内容时，调用 retrieve_docs 检索（外部 RAG 服务，只读）；片段带来源与分数，回答请标注来源，检索不到就如实说明",
  "- 需要读某个网页/在线文档/报错页面时调用 browser_fetch（只读，直接执行）；它只拿静态 HTML 正文，读不到纯 JS 渲染的页面 —— 那种情况如实说明，不要编造页面内容",
  "- read_file / list_dir / grep_search 直接执行；terminal 和 write_file 是高风险操作，系统会在你调用后自动请求用户确认，你无需额外追问",
  "- 用户附加了文件时，基于附件内容回答（在消息中以「--- 附件 N: 名 ---」标注）",
  "- 电脑控制：先 computer_screenshot 看屏幕并确认坐标，再 click/type/key/scroll 操作；这些动作是高风险操作",
  "- 多智能体协同：只有独立、可并行或需要隔离上下文的任务才使用 delegate_agent；委派时必须明确指定子代理、完整任务书、专项提示词和最小工具子集。能自己用少量工具完成的任务不要委派",
  "- 发送邮件、写文件、执行命令与电脑控制均受会话权限模式约束",
  "- 跨会话长期记忆：用户表达长期偏好、项目事实或纠正既往回答时，调用 memory_save 记录；每轮上下文已带当前 Agent 的长期记忆，发生冲突时以用户最新说法为准",
  "- 回答简洁准确，代码放在 Markdown 代码块里",
].join("\n");

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

/** 只保留当前工具 allowlist 中真实存在的审批项。 */
function boundApprovals(
  approvals: ApprovalDescriptions,
  activeTools: StructuredToolInterface[],
): ApprovalDescriptions {
  const names = new Set(activeTools.map((item) => item.name));
  return Object.fromEntries(
    Object.entries(approvals).filter(([name]) => names.has(name)),
  );
}

function activePluginTools(): StructuredToolInterface[] {
  return pluginToolSets
    .filter((entry) => isPluginEnabled(entry.id))
    .flatMap((entry) => entry.tools);
}

function promptForPlugins(): string {
  const disabled = pluginToolSets
    .filter((entry) => !isPluginEnabled(entry.id))
    .map((entry) => entry.id === "rag" ? "知识库检索" : "电脑控制");
  return disabled.length
    ? `${SYSTEM_PROMPT}\n- 当前已停用插件：${disabled.join("、")}。不要调用对应工具；用户要求时说明需在「设置 → 插件」中启用。`
    : SYSTEM_PROMPT;
}

function assembleProfile(input: {
  activeTools: StructuredToolInterface[];
  approvals: ApprovalDescriptions;
  prompt: string;
  displayName?: string;
  parentModelRuntime?: ModelRuntimeConfig;
}): AgentProfile {
  const catalog = buildDelegationCatalog({
    parentTools: input.activeTools,
    parentApprovals: input.approvals,
  });
  const teamTools = createTeamTools(catalog, { parentModelRuntime: input.parentModelRuntime });
  const tools = [...input.activeTools, ...teamTools];
  const approvals = boundApprovals(
    { ...input.approvals, delegate_agent: generalApprovals.delegate_agent },
    tools,
  );
  return {
    ...generalProfileBase,
    displayName: input.displayName ?? generalProfileBase.displayName,
    systemPrompt: input.prompt,
    tools,
    approvalDescriptions: approvals,
  };
}

const generalProfileBase: AgentProfile = {
  id: "general",
  displayName: "通用 Agent",
  systemPrompt: SYSTEM_PROMPT,
  tools: [],
  approvalDescriptions: {},
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
    maxRecentMessages: 10_000,
    maxToolResultChars: 8_000,
  },
};

/** 静态完整快照（供目录/测试使用）；运行时仍按插件状态调用下方工厂。 */
export const generalProfile: AgentProfile = assembleProfile({
  activeTools: [...baseTools, ...pluginToolSets.flatMap((entry) => entry.tools)],
  approvals: generalApprovals,
  prompt: SYSTEM_PROMPT,
});

/** 当前插件状态对应的通用 Profile。 */
export function generalProfileWithPlugins(parentModelRuntime?: ModelRuntimeConfig): AgentProfile {
  return assembleProfile({
    activeTools: [...baseTools, ...activePluginTools()],
    approvals: generalApprovals,
    prompt: promptForPlugins(),
    parentModelRuntime,
  });
}

/** 内置工具 + 已注入 MCP 工具；外部工具也可被主 Agent 分配给子代理。 */
export function generalProfileWithExternal(parentModelRuntime?: ModelRuntimeConfig): AgentProfile {
  if (!externalTools.length) return generalProfileWithPlugins(parentModelRuntime);
  const baseToolsWithExternal = [...baseTools, ...activePluginTools()];
  const names = new Set(baseToolsWithExternal.map((item) => item.name));
  for (const item of externalTools) {
    if (names.has(item.name)) throw new Error(`外部工具与内置工具重名：${item.name}`);
    if (item.name === "delegate_agent") throw new Error("外部工具不能命名为 delegate_agent");
    names.add(item.name);
  }
  return assembleProfile({
    activeTools: [...baseToolsWithExternal, ...externalTools],
    approvals: { ...generalApprovals, ...externalApprovals },
    prompt: promptForPlugins(),
    parentModelRuntime,
  });
}

export function createAgentGraph(sessionId?: string, modelRuntime?: ModelRuntimeConfig) {
  return createWorkflowGraph(generalProfileWithExternal(modelRuntime), undefined, { sessionId, modelRuntime });
}
