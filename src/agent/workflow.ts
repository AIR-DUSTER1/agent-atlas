/**
 * ============================================================
 * workflow.ts — 产品级 Agent 编排：需求理解 → 澄清 → ReAct → 反思
 * ============================================================
 * 这里承载 general / estate 共用的「执行前理解、执行后检查」逻辑：
 *   analyze  用一次独立模型调用判断最新请求是否足够明确；
 *   clarify  interrupt() 生成 2-4 个选项，用户选择后继续；
 *   agent    原有 ReAct 节点（工具循环与人工审批完全复用 hitl.ts）；
 *   review   最终回答不满意时带反馈回炉，最多修订三次防止死循环。
 *
 * 约束：本文件属于 agent 层，只依赖 src 顶层与 @langchain/*，不得 import server/*。
 * 关键坑：分析/反思发生在图节点里，但它们的模型 token 不属于用户回答，
 * 由 stream.ts 按节点名过滤（analyze / clarify / review），不能在这里改成
 * 返回 messages，否则内部 JSON 会混进对话正文。
 */
import {
  Annotation,
  END,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import { createChatModel } from "../llm.js";
import { config } from "../config.js";
import { getCheckpointSaver } from "../checkpoint.js";
import { memoryNoteForPrompt } from "../memory-store.js";
import { skillNoteForMessage } from "../skills.js";
import { buildAgentContext } from "./context-builder.js";
import { sanitizeCheckpointMessage } from "./checkpoint-sanitize.js";
import { createApprovalToolsNode } from "./hitl.js";
import { createToolRiskAssessor, type ToolRiskAssessor } from "./tool-risk.js";
import { permissionModeNote, type PermissionMode } from "./permission.js";
import type { AgentProfile } from "./profile.js";

const MAX_USER_TEXT = 8_000;
const MAX_BRIEF_TEXT = 1_200;
const MAX_WORKING_BRIEF = 3_500;
const MAX_QUESTION_TEXT = 240;
const MAX_OPTION_LABEL = 80;
const MAX_OPTION_DESCRIPTION = 200;
const MAX_ANSWER_TEXT = 2_000;
const MAX_FEEDBACK_TEXT = 1_200;
const MAX_OPTIONS = 4;
const MAX_REVIEW_REVISIONS = 3;
const RECENT_MESSAGE_COUNT = 8;
const RECENT_MESSAGE_CHARS = 700;
const RECENT_TOOL_RESULT_COUNT = 3;
const MAX_TOOL_RESULT_TEXT = 600;

export interface ClarificationOption {
  id: string;
  label: string;
  description?: string;
}

/** interrupt() 的澄清载荷：与 server/events.ts 独立声明同构类型，避免 agent 反向依赖 server。 */
export interface ClarificationRequest {
  type: "clarification";
  question: string;
  options: ClarificationOption[];
  allowCustom: boolean;
}

/** 可注入的模型壳：生产用 createChatModel，测试可用 FakeListChatModel 验证整图流转。 */
export interface WorkflowChatModel {
  invoke(input: unknown, options?: { signal?: AbortSignal }): Promise<AIMessage>;
}

export interface WorkflowModels {
  agent: WorkflowChatModel;
  analyst: WorkflowChatModel;
  reviewer: WorkflowChatModel;
}

interface RequirementAnalysis {
  understood: boolean;
  brief: string;
  question: string;
  options: ClarificationOption[];
}

interface ReviewResult {
  passes: boolean;
  reason: string;
  feedback: string;
}

const WorkflowState = Annotation.Root({
  ...MessagesAnnotation.spec,
  requirementBrief: Annotation<string>({
    reducer: (_previous, next) => next ?? "",
    default: () => "",
  }),
  clarification: Annotation<ClarificationRequest | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  clarificationHistory: Annotation<string>({
    reducer: (_previous, next) => next ?? "",
    default: () => "",
  }),
  reviewFeedback: Annotation<string>({
    reducer: (_previous, next) => next ?? "",
    default: () => "",
  }),
  reviewAttempts: Annotation<number>({
    reducer: (_previous, next) => next ?? 0,
    default: () => 0,
  }),
});

type WorkflowStateType = typeof WorkflowState.State;

const ANALYZE_PROMPT = [
  "你是需求理解节点，只负责判断最新一条用户请求是否已经足够明确。",
  "判定规则：",
  "1. 寒暄、事实问答，以及已经给出明确对象/动作/约束的任务，直接判定 understood=true，不要为了多问而多问。",
  "2. 只有缺少会实质改变执行结果的关键信息时才请求澄清，例如目标对象不明、动作范围冲突、必须二选一才能继续。",
  "3. 能从最近对话或当前消息推断的信息不要重复询问；用户说「随便」「你决定」时按可执行默认值继续。",
  "4. 需要澄清时给 2-4 个互斥选项，每个选项必须有 id（A/B/C/D）、简短 label 和一句 description。",
  "5. 不要生成「其它」选项，前端支持用户自定义输入。",
  "6. 「上一轮澄清」是用户此前做出的选择；当前请求依赖它时沿用，不要重复询问。",
  "只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。格式：",
  '{"understood":true,"brief":"一句话复述你的理解","question":"","options":[]}',
  "或：",
  '{"understood":false,"brief":"一句话复述已知信息","question":"需要用户确认的问题","options":[{"id":"A","label":"选项标题","description":"选项说明"}]}',
].join("\n");

const REVIEW_PROMPT = [
  "你是结果反思节点，负责检查助手最新回答是否真正满足用户本轮需求。",
  "只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。格式：",
  '{"passes":true,"reason":"通过原因","feedback":""}',
  "或：",
  '{"passes":false,"reason":"未通过原因","feedback":"给助手的具体修订指令"}',
  "判定失败仅限：没有回答核心问题、遗漏用户明确要求、与工具结果或需求理解矛盾、信息已足够却继续追问。",
  "不要因为文风、长度、措辞或个人偏好判定失败；没有明显问题时一律 passes=true。",
].join("\n");

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text: unknown }).text ?? "");
      }
      return "";
    })
    .join("");
}

function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeOptions(value: unknown): ClarificationOption[] {
  if (!Array.isArray(value)) return [];
  const options: ClarificationOption[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    const label = asText(record?.label ?? item).slice(0, MAX_OPTION_LABEL);
    if (!label) continue;
    const suggestedId = asText(record?.id).toUpperCase();
    const id = /^[A-Z]$/.test(suggestedId) ? suggestedId : String.fromCharCode(65 + options.length);
    if (seen.has(id)) continue;
    seen.add(id);
    const description = asText(record?.description).slice(0, MAX_OPTION_DESCRIPTION);
    options.push(description ? { id, label, description } : { id, label });
    if (options.length >= MAX_OPTIONS) break;
  }
  return options;
}

/** 解析需求分析 JSON。解析失败时宁可继续执行，也不要让坏输出卡住聊天。 */
export function parseRequirementAnalysis(raw: string): RequirementAnalysis {
  const record = asRecord(extractJson(raw));
  if (!record) return { understood: true, brief: "", question: "", options: [] };

  const brief = asText(record.brief).slice(0, MAX_BRIEF_TEXT);
  const question = asText(record.question).slice(0, MAX_QUESTION_TEXT);
  const options = normalizeOptions(record.options);
  const explicitPass = record.understood === true || record.needsClarification === false;
  const needsClarification =
    record.understood === false ||
    record.needsClarification === true ||
    (!explicitPass && Boolean(question) && options.length >= 2);

  if (needsClarification && question && options.length >= 2) {
    return { understood: false, brief, question, options };
  }
  return { understood: true, brief, question: "", options: [] };
}

/** 解析反思 JSON。解析失败时默认通过，避免把网关的坏格式变成无限回炉。 */
export function parseReviewResult(raw: string): ReviewResult {
  const record = asRecord(extractJson(raw));
  if (!record) return { passes: true, reason: "", feedback: "" };

  const explicitFail = record.passes === false || record.pass === false || record.ok === false;
  const explicitPass = record.passes === true || record.pass === true || record.ok === true;
  const reason = asText(record.reason).slice(0, MAX_FEEDBACK_TEXT);
  const feedback = asText(record.feedback).slice(0, MAX_FEEDBACK_TEXT);
  return { passes: explicitPass || !explicitFail, reason, feedback };
}

function lastHumanText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message instanceof HumanMessage) return contentText(message.content);
  }
  return "";
}

function recentContext(messages: BaseMessage[]): string {
  return messages
    .slice(-RECENT_MESSAGE_COUNT)
    .map((message) => {
      const text = contentText(message.content).replace(/\s+/g, " ").trim();
      if (!text) return "";
      return `${message.getType()}: ${text.slice(0, RECENT_MESSAGE_CHARS)}`;
    })
    .filter(Boolean)
    .join("\n");
}

/** 反思需要对照本轮工具结果，否则「与工具结果矛盾」这条判定无从谈起；只取最近几条并截断。 */
function recentToolResults(messages: BaseMessage[]): string {
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] instanceof HumanMessage) {
      turnStart = i + 1;
      break;
    }
  }
  return messages
    .slice(turnStart)
    .filter((message) => message.getType() === "tool")
    .slice(-RECENT_TOOL_RESULT_COUNT)
    .map((message) => contentText(message.content).replace(/\s+/g, " ").trim().slice(0, MAX_TOOL_RESULT_TEXT))
    .filter(Boolean)
    .join("\n");
}

function requestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(config.modelRequestTimeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/**
 * 构建带需求理解与反思的 ReAct 图。
 * general / estate 只提供 profile（提示词 + 工具 allowlist + 审批策略），
 * 避免两套编排逻辑各自漂移；工具执行节点在建图时绑定 profile-local map。
 */
export function createWorkflowGraph(
  profile: AgentProfile,
  models?: WorkflowModels,
  options?: { checkpointer?: MemorySaver; sessionId?: string; riskAssessor?: ToolRiskAssessor }
) {
  const tools = profile.tools;
  const modelOptions = { sessionId: options?.sessionId };
  const agentModel = models?.agent
    ?? (createChatModel(0, modelOptions).bindTools(tools) as unknown as WorkflowChatModel);
  const analystModel = models?.analyst
    ?? (createChatModel(0, modelOptions) as unknown as WorkflowChatModel);
  const reviewerModel = models?.reviewer
    ?? (createChatModel(0, modelOptions) as unknown as WorkflowChatModel);
  const riskAssessor = options?.riskAssessor
    ?? createToolRiskAssessor(createChatModel(0, modelOptions));
  const toolsNode = createApprovalToolsNode({
    tools,
    approvalDescriptions: profile.approvalDescriptions,
    riskAssessor,
    profileId: profile.id,
  });
  const analyzePrompt = profile.analystGuidance
    ? `${ANALYZE_PROMPT}\n${profile.analystGuidance}`
    : ANALYZE_PROMPT;
  const reviewPrompt = profile.reviewerGuidance
    ? `${REVIEW_PROMPT}\n${profile.reviewerGuidance}`
    : REVIEW_PROMPT;

  async function analyzeNode(state: WorkflowStateType, nodeConfig?: { signal?: AbortSignal }) {
    const userText = lastHumanText(state.messages).slice(0, MAX_USER_TEXT);
    const history = state.clarificationHistory
      ? `上一轮澄清（仅在相关时参考）：${state.clarificationHistory}`
      : "";
    const fallback = {
      requirementBrief: [userText, history].filter(Boolean).join("\n").slice(0, MAX_BRIEF_TEXT),
      clarification: null,
      reviewFeedback: "",
      reviewAttempts: 0,
    };
    if (!userText.trim()) return fallback;

    try {
      const response = await analystModel.invoke([
        { role: "system", content: analyzePrompt },
        {
          role: "user",
          content:
            `上一轮澄清（仅在相关时参考）：\n${state.clarificationHistory || "（无）"}\n\n` +
            `最近对话：\n${recentContext(state.messages) || "（无）"}\n\n当前请求：\n${userText}`,
        },
      ], { signal: requestSignal(nodeConfig?.signal) });
      const analysis = parseRequirementAnalysis(contentText(response.content));
      const brief = (analysis.brief || userText).slice(0, MAX_BRIEF_TEXT);
      if (analysis.understood) {
        return { ...fallback, requirementBrief: brief };
      }
      return {
        ...fallback,
        requirementBrief: brief,
        clarification: {
          type: "clarification" as const,
          question: analysis.question,
          options: analysis.options,
          allowCustom: true,
        },
      };
    } catch {
      return fallback;
    }
  }

  async function clarifyNode(state: WorkflowStateType) {
    const request = state.clarification;
    if (!request) return {};
    const answer = interrupt<ClarificationRequest, string>(request);
    const raw = typeof answer === "string" ? answer.trim() : String(answer ?? "").trim();
    const option = request.options.find((item) => item.id === raw);
    const answerText = (option
      ? `${option.label}${option.description ? `（${option.description}）` : ""}`
      : raw
    ).slice(0, MAX_ANSWER_TEXT);
    if (!answerText) throw new Error("没有收到澄清选项，请重新发起这个请求");

    return {
      requirementBrief: `${state.requirementBrief}\n用户澄清：${answerText}`.slice(0, MAX_WORKING_BRIEF),
      clarification: null,
      clarificationHistory: answerText,
    };
  }

  async function agentNode(
    state: WorkflowStateType,
    config?: {
      signal?: AbortSignal;
      configurable?: {
        permission_mode?: PermissionMode;
        task_ledger?: string;
        task_budget_note?: string;
      };
    }
  ) {
    // 上下文投影 + 内部注记统一走 context-builder：需求 brief / 历史澄清 /
    // 反思反馈 / 权限模式 / 跨会话长期记忆在这里组装成稳定 system，
    // 消息窗口与工具结果按预算裁剪。记忆注记每轮动态拼（不落 checkpoint），
    // 新会话、甚至服务重启后的第一轮就能看到全部记忆。
    // 技能：只匹配「最近一条用户消息」（不看整段历史，避免旧话题的关键词
    // 每轮都把技能拽进来）。未命中返回 null，上下文里不会多出任何内容。
    const lastUserText = lastHumanText(state.messages);
    const skillNote = await skillNoteForMessage(lastUserText);
    const context = buildAgentContext({
      profile,
      messages: state.messages,
      requirementBrief: state.requirementBrief,
      clarificationHistory: state.clarificationHistory,
      reviewFeedback: state.reviewFeedback,
      permissionNote: permissionModeNote(config?.configurable?.permission_mode),
      memoryNote: memoryNoteForPrompt() ?? undefined,
      skillNote: skillNote ?? undefined,
      taskLedger: config?.configurable?.task_ledger,
      budgetNote: config?.configurable?.task_budget_note,
    });
    const response = await agentModel.invoke(context.messages, { signal: requestSignal(config?.signal) });
    // 网关回显的 tools/output 与 dataURL 会原样进入 checkpoint；先投影再入状态。
    return { messages: [sanitizeCheckpointMessage(response)] };
  }

  async function reviewNode(state: WorkflowStateType, nodeConfig?: { signal?: AbortSignal }) {
    const last = state.messages.at(-1);
    const lastAi = last?.getType() === "ai" ? (last as AIMessage) : undefined;
    const answer = contentText(lastAi?.content).slice(0, MAX_USER_TEXT);
    const attempts = state.reviewAttempts;
    try {
      const response = await reviewerModel.invoke([
        { role: "system", content: reviewPrompt },
        {
          role: "user",
          content:
            `用户本轮需求/理解：\n${state.requirementBrief || "（无）"}\n\n` +
            `上一轮澄清（仅在相关时参考）：\n${state.clarificationHistory || "（无）"}\n\n` +
            `最近工具结果：\n${recentToolResults(state.messages) || "（无）"}\n\n` +
            `助手最新回答：\n${answer || "（空回答）"}`,
        },
      ], { signal: requestSignal(nodeConfig?.signal) });
      const review = parseReviewResult(contentText(response.content));
      if (review.passes || attempts >= MAX_REVIEW_REVISIONS) {
        return { reviewFeedback: "", reviewAttempts: attempts + 1 };
      }
      const feedback = (review.feedback || review.reason || "回答没有完全满足需求，请检查遗漏并补齐。")
        .slice(0, MAX_FEEDBACK_TEXT);
      return { reviewFeedback: feedback, reviewAttempts: attempts + 1 };
    } catch {
      return { reviewFeedback: "", reviewAttempts: attempts + 1 };
    }
  }

  function afterAnalyze(state: WorkflowStateType): "clarify" | "agent" {
    return state.clarification ? "clarify" : "agent";
  }

  function afterAgent(state: WorkflowStateType): "tools" | "review" {
    const last = state.messages.at(-1) as AIMessage | undefined;
    return last?.tool_calls?.length ? "tools" : "review";
  }

  function afterReview(state: WorkflowStateType): "agent" | typeof END {
    return state.reviewFeedback ? "agent" : END;
  }

  return new StateGraph(WorkflowState)
    .addNode("analyze", analyzeNode)
    .addNode("clarify", clarifyNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addNode("review", reviewNode)
    .addEdge(START, "analyze")
    .addConditionalEdges("analyze", afterAnalyze)
    .addEdge("clarify", "agent")
    .addConditionalEdges("agent", afterAgent)
    .addEdge("tools", "agent")
    .addConditionalEdges("review", afterReview)
    .compile({
      // 默认挂共享持久检查点（重启续命，见 src/checkpoint.ts）；
      // 子 Agent / 单测可传自建 MemorySaver 保持一次性内存态。
      checkpointer: options?.checkpointer ?? getCheckpointSaver(),
    });
}
