/**
 * ============================================================
 * workflow.ts — 产品级 Agent 编排：需求理解 → 澄清 → ReAct → 反思
 * ============================================================
 * 这里承载 general / estate 共用的「执行前理解、执行后检查」逻辑：
 *   analyze  用一次独立模型调用判断最新请求是否足够明确；
 *   clarify  interrupt() 生成 2-4 个选项，用户选择后继续；
 *   route    按规则 / 向量 / 决策模型挑子代理，必要时转成澄清询问（默认关闭）；
 *   agent    原有 ReAct 节点（工具循环与人工审批完全复用 hitl.ts）；
 *   review   最终回答不满意时带反馈回炉，最多修订三次防止死循环；
 *            连续工作模式（请求级 continuous）改为「任务完成闸」：不完成就一直
 *            回炉，只受空转熔断（连续无工具动作）、保险丝上限与异常/中止约束。
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
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import { createChatModel } from "../llm.js";
import { config } from "../config.js";
import { invokeWithModelRetry } from "../model-retry.js";
import { getCheckpointSaver } from "../checkpoint.js";
import { memorySlot } from "../memory/slot.js";
import { memoryScope } from "../memory/scope.js";
import { skillNoteForMessage } from "../skills.js";
import { buildAgentContext } from "./context-builder.js";
import { sanitizeCheckpointMessage } from "./checkpoint-sanitize.js";
import { rememberHistoryReasoning } from "../reasoning-passthrough.js";
import { createApprovalToolsNode } from "./hitl.js";
import { createToolRiskAssessor, type ToolRiskAssessor } from "./tool-risk.js";
import { permissionModeNote, type PermissionMode } from "./permission.js";
import type { AgentProfile } from "./profile.js";
import type { ModelRuntimeConfig } from "../model-runtime.js";
import { defaultModelRuntime } from "../model-runtime.js";
import { isRoutingEnabled, getRoutingSettings } from "../routing/state.js";
import { runRouteStep, routingAppliesTo, shouldDispatch } from "../routing/route-step.js";
import { findSubagent } from "../subagent-state.js";
import { buildDelegationCatalog } from "../delegation-catalog.js";
import { dispatchToAgent } from "../tools-team.js";
import { renderBriefing, parseOutOfScope, OUT_OF_SCOPE_MARKER } from "../routing/briefing.js";
import type { RouteDecision } from "../routing/types.js";
import { toolResultsStopTurn } from "./turn-stop.js";
import {
  applyWorkflowPlanToolInput,
  createWorkflowPlanFromDraft,
  finalizeWorkflowPlan,
  normalizeWorkflowPlanDraft,
  workflowPlanPrompt,
  workflowPlanSummary,
  WORKFLOW_PLAN_TOOL_NAME,
  type WorkflowPlanDraft,
  type WorkflowPlanSnapshot,
} from "../workflow-plan.js";
import { updateWorkflowPlanTool } from "../tools-plan.js";

const MAX_USER_TEXT = 8_000;
const MAX_BRIEF_TEXT = 1_200;
const MAX_WORKING_BRIEF = 3_500;
const MAX_QUESTION_TEXT = 240;
const MAX_OPTION_LABEL = 80;
const MAX_OPTION_DESCRIPTION = 200;
const MAX_ANSWER_TEXT = 2_000;
const MAX_FEEDBACK_TEXT = 1_200;
const MAX_OPTIONS = 4;
/** 一道澄清卡最多打包几道题：再多就该拆成「先问最关键的」，一次问 5 题等于逼用户放弃。 */
const MAX_QUESTIONS = 4;
const MAX_REVIEW_REVISIONS = 3;
/**
 * 连续模式的反思回炉保险丝：真正的停止条件是「反思通过 / 空转熔断 / 请求异常 / 用户中止」，
 * 这个数只防「永远差一点」的任务无限烧钱；按 8 小时 × 分钟级回炉周期估算取千级。
 */
const MAX_CONTINUOUS_REVISIONS = 1_000;
/**
 * 连续模式的空转熔断：连续 N 轮「反思不通过且期间没有任何工具动作」就结束回合。
 * 任务真在推进时每轮都有工具结果，计数每轮清零；只有纯文本打转才会计满。
 */
const MAX_IDLE_REVIEW_ROUNDS = 3;
const RECENT_MESSAGE_COUNT = 8;
const RECENT_MESSAGE_CHARS = 700;
const RECENT_TOOL_RESULT_COUNT = 3;
const MAX_TOOL_RESULT_TEXT = 600;

export interface ClarificationOption {
  id: string;
  label: string;
  description?: string;
}

/** 一道澄清题。选项 id 只在本题内唯一（A/B/C…），跨题重复没有意义。 */
export interface ClarificationQuestion {
  id: string;
  question: string;
  options: ClarificationOption[];
  allowCustom: boolean;
}

/**
 * interrupt() 的澄清载荷：与 server/events.ts 独立声明同构类型，避免 agent 反向依赖 server。
 *
 * 一次追问可以打包多道题（如求职同时缺城市/方向/薪资/年限）。原来一次只问一题，
 * 用户要连点四轮才能补全信息；现在一张卡全部答完再提交，减少来回。
 * 载荷不再带顶层 question/options —— 旧 journal 里的单问形状由前端归一化兼容。
 */
export interface ClarificationRequest {
  type: "clarification";
  questions: ClarificationQuestion[];
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
  questions: ClarificationQuestion[];
  plan: WorkflowPlanDraft | null;
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
  /** 本轮执行流程；analyze 每轮先清空，简单问答保持 null，前端据此隐藏流程窗体。 */
  workflowPlan: Annotation<WorkflowPlanSnapshot | null>({
    reducer: (_previous, next) => next,
    default: () => null,
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
  /**
   * 无头模式下自动采用的假设（有值 = 本轮本该澄清但无人可问）。
   * 只用于把假设告诉调用方与模型，不参与后续路由判断。
   */
  headlessAssumption: Annotation<string>({
    reducer: (_previous, next) => next ?? "",
    default: () => "",
  }),
  /** 本轮路由决策（dispatch / ask / main），供流层产出 route_decision 事件 */
  routeDecision: Annotation<RouteDecision | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  /** 本轮已转回次数（R7 硬约束 ≤ maxHandoffs，计数只能由节点代码改） */
  handoffCount: Annotation<number>({
    reducer: (_previous, next) => next ?? 0,
    default: () => 0,
  }),
  /** 已尝试过的子代理 id，防止 A→B→A 绕圈 */
  routeHistory: Annotation<string[]>({
    reducer: (_previous, next) => next ?? [],
    default: () => [],
  }),
  /**
   * 程序化派发布展出的任务书：路由节点生成，agent 节点作为前置事实注入。
   * 只在本轮内有效，不参与跨轮记忆。
   */
  dispatchBrief: Annotation<string>({
    reducer: (_previous, next) => next ?? "",
    default: () => "",
  }),
  /**
   * 连续工作模式（回合内有效）：反思不通过就持续回炉执行，直到反思通过 /
   * 空转熔断 / 请求异常 / 用户中止。在 analyze 从请求 configurable 读一次后写入
   * 图状态 —— 审批 resume 走同一线程检查点，状态还在，前端无需重传该标记。
   */
  continuousMode: Annotation<boolean>({
    reducer: (_previous, next) => next ?? false,
    default: () => false,
  }),
  /** 连续模式：上一次反思执行时的消息总数，用来计算「这轮回炉期间有没有新的工具动作」。 */
  lastReviewMessageCount: Annotation<number>({
    reducer: (_previous, next) => next ?? 0,
    default: () => 0,
  }),
  /** 连续模式：连续「反思不通过且期间无工具动作」的轮数；出现工具动作即清零。 */
  idleReviewRounds: Annotation<number>({
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
  "3. 缺多项信息时**一次问全**：把彼此独立的缺口放进同一个 questions 数组，最多 4 道题。用户一次答完比来回追问四轮体验好得多。",
  "4. 能相互推断的缺口合并成一道题；后一道题依赖前一道答案时不要并列（那时只问前一题）。",
  "5. 能从最近对话或当前消息推断的信息不要重复询问；用户说「随便」「你决定」时按可执行默认值继续。",
  "6. 每道题给 2-4 个互斥选项，选项必须有 id（A/B/C/D）、简短 label 和一句 description；选项 id 只在本道题内唯一。",
  "7. 不要生成「其它」选项，前端支持用户自定义输入。",
  "8. 「上一轮澄清」是用户此前做出的选择；当前请求依赖它时沿用，不要重复询问。",
  "9. 需求已明确且任务需要两个以上可验证步骤、多次工具调用或依赖顺序时，同时给出 plan；简单问答、单次查询、纯计算给 null，不要为了展示而硬造流程。",
  "10. plan.steps 必须 2-8 步，id 用 step-1、step-2 这类稳定短 id；每步只描述一个可验证动作，不写空泛的「分析一下」。",
  "只输出一个 JSON 对象，不要 Markdown，不要解释。不需要澄清时：",
  '{"understood":true,"brief":"一句话复述你的理解","questions":[],"plan":null}',
  "需要执行流程时：",
  '{"understood":true,"brief":"一句话复述你的理解","questions":[],"plan":{"goal":"一句话目标","steps":[{"id":"step-1","title":"先完成什么","detail":"可选执行说明"},{"id":"step-2","title":"再完成什么"}]}}',
  "需要澄清时（plan 固定为 null，questions 里每道题都有题面与选项）：",
  '{"understood":false,"brief":"一句话复述已知信息","questions":[{"id":"q1","question":"需要用户确认的问题","options":[{"id":"A","label":"选项标题","description":"选项说明"},{"id":"B","label":"另一选项","description":"选项说明"}]},{"id":"q2","question":"第二道问题","options":[{"id":"A","label":"选项标题"},{"id":"B","label":"另一选项"}]}],"plan":null}',
  "questions 数组顺序即提问顺序，前端按这个顺序渲染。",
].join("\n");

const REVIEW_PROMPT = [
  "你是结果反思节点，负责检查助手最新回答是否真正满足用户本轮需求。",
  "只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。格式：",
  '{"passes":true,"reason":"通过原因","feedback":""}',
  "或：",
  '{"passes":false,"reason":"未通过原因","feedback":"给助手的具体修订指令"}',
  "判定失败仅限：没有回答核心问题、遗漏用户明确要求、与工具结果或需求理解矛盾、信息已足够却继续追问。",
  "执行流程中存在 pending / in_progress / failed 步骤时不得判定通过；completed 必须有工具结果或明确产出作为证据。",
  "不要因为文风、长度、措辞或个人偏好判定失败；没有明显问题时一律 passes=true。",
].join("\n");

/**
 * 连续模式的反思判据从「回答是否够好」换成「任务是否真正完成」：
 * 回炉指令必须是下一步行动（还差什么、如何验证），而不是文风建议。
 */
const CONTINUOUS_REVIEW_PROMPT = [
  "你是连续工作模式的任务完成检查节点，负责判断本轮任务是否已经真正完成。",
  "只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。格式：",
  '{"passes":true,"reason":"判定完成的依据","feedback":""}',
  "或：",
  '{"passes":false,"reason":"未完成的原因","feedback":"下一步行动指令"}',
  "判定失败仅限：目标动作没有执行完、执行了但没有验证（构建/测试没跑或没通过）、遗漏用户明确要求、与工具结果矛盾、声称完成但工具结果里没有证据。",
  "passes=true 仅当：目标已达成且有工具结果佐证；或用户请求本身是纯问答且回答已经完整。",
  "执行流程中存在 pending / in_progress / failed 步骤时不得判定完成；completed 必须有工具结果或明确产出作为证据。",
  "不要因为文风、长度或措辞判定失败。feedback 必须是「下一步做什么」的具体指令（还差什么、如何验证）。",
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

/** 一道题至少要两个选项才值得问；只有一个选项等于替用户做决定。 */
function normalizeQuestions(value: unknown): ClarificationQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: ClarificationQuestion[] = [];
  const seenIds = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    // 兼容模型把字段写成 text / title 的方言
    const text = asText(record?.question ?? record?.text ?? record?.title ?? item).slice(0, MAX_QUESTION_TEXT);
    const options = normalizeOptions(record?.options);
    if (!text || options.length < 2) continue;
    const suggestedId = asText(record?.id).toLowerCase();
    const id = /^[a-z0-9_-]{1,24}$/.test(suggestedId) ? suggestedId : `q${questions.length + 1}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    questions.push({ id, question: text, options, allowCustom: record?.allowCustom !== false });
    if (questions.length >= MAX_QUESTIONS) break;
  }
  return questions;
}

/**
 * 解析需求分析 JSON。解析失败时宁可继续执行，也不要让坏输出卡住聊天。
 *
 * 两种载荷都接受：
 *   - 新格式 questions: [...]（可一次问多题）；
 *   - 旧格式 question + options（单题），统一提升成一道题，避免旧提示词/旧模型输出失效。
 */
export function parseRequirementAnalysis(raw: string): RequirementAnalysis {
  const record = asRecord(extractJson(raw));
  if (!record) return { understood: true, brief: "", questions: [], plan: null };

  const brief = asText(record.brief).slice(0, MAX_BRIEF_TEXT);
  let questions = normalizeQuestions(record.questions);
  if (!questions.length) {
    // 旧形状：顶层 question + options
    const legacyQuestion = asText(record.question).slice(0, MAX_QUESTION_TEXT);
    const legacyOptions = normalizeOptions(record.options);
    if (legacyQuestion && legacyOptions.length >= 2) {
      questions = [{ id: "q1", question: legacyQuestion, options: legacyOptions, allowCustom: record.allowCustom !== false }];
    }
  }

  const explicitPass = record.understood === true || record.needsClarification === false;
  const needsClarification =
    record.understood === false ||
    record.needsClarification === true ||
    (!explicitPass && questions.length > 0);

  if (needsClarification && questions.length) {
    return { understood: false, brief, questions, plan: null };
  }
  return {
    understood: true,
    brief,
    questions: [],
    plan: normalizeWorkflowPlanDraft(record.plan),
  };
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

/**
 * 无头模式的默认假设：每道题取第一个选项。
 *
 * 为什么是第一个而不是「最保守的」：选项顺序由分析模型按「最常见 / 最可能」排，
 * 且这条路径的意义是「不要让任务掉在地上」，而不是替用户做不可逆决定 ——
 * 任何真正高风险的动作仍会走 HITL 审批（clarify 只决定执行方向）。
 * 多题时逐题取第一个，返回「题面 → 假设」的对应关系，保证台账里能看出每题假设了什么。
 */
export function defaultAssumption(request: ClarificationRequest): { label: string; note: string } {
  const parts = request.questions.map((question) => {
    const first = question.options[0];
    const label = first ? first.label : "按最合理的默认方式继续";
    const detail = first?.description ? `（${first.description}）` : "";
    return { question: question.question, answer: `${label}${detail}` };
  });
  if (!parts.length) return { label: "按最合理的默认方式继续", note: "" };
  return {
    label: parts.map((part) => part.answer).join("；"),
    note: parts.map((part) => `问：${part.question}\n假设：${part.answer}`).join("\n"),
  };
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

/** 标记默认生产模型：只有它自动重试；测试注入的确定性假模型保持原语义。 */
const RETRYING_MODEL = Symbol("retrying-model");
type RetryingChatModel = WorkflowChatModel & { [RETRYING_MODEL]: true };

/** 包装默认生产模型：每次尝试重新生成请求超时，退避只响应父级取消信号。 */
function withModelRetries(model: WorkflowChatModel, sessionId: string | undefined): WorkflowChatModel {
  const wrapped: WorkflowChatModel = {
    invoke: (input, options) => invokeWithModelRetry(
      (signal) => model.invoke(input, { signal: requestSignal(signal) }),
      { sessionId, parentSignal: options?.signal }
    ),
  };
  return Object.assign(wrapped, { [RETRYING_MODEL]: true as const });
}

/** 测试模型沿用原一次性调用；生产包装模型内部负责重试与每次请求的超时。 */
async function invokeModel(
  model: WorkflowChatModel,
  input: unknown,
  parentSignal: AbortSignal | undefined,
  sessionId: string | undefined
): Promise<AIMessage> {
  if (RETRYING_MODEL in model) return model.invoke(input, { signal: parentSignal });
  return model.invoke(input, { signal: requestSignal(parentSignal) });
}


/**
 * 构建带需求理解与反思的 ReAct 图。
 * general / estate 只提供 profile（提示词 + 工具 allowlist + 审批策略），
 * 避免两套编排逻辑各自漂移；工具执行节点在建图时绑定 profile-local map。
 */
export function createWorkflowGraph(
  profile: AgentProfile,
  models?: WorkflowModels,
  options?: {
    checkpointer?: MemorySaver;
    sessionId?: string;
    riskAssessor?: ToolRiskAssessor;
    /** 子代理可使用独立「供应商 × 模型」快照；主图不传时走全局当前模型。 */
    modelRuntime?: ModelRuntimeConfig;
    /** 观测每次模型响应；回调异常不得影响主图。 */
    onModelUsage?: (node: "analyze" | "agent" | "review", response: AIMessage) => void;
    /**
     * 路由派发执行器；生产省略（固定走 runSubagent）。
     * 单测注入假执行器即可覆盖「派发 → 回填 → 收尾」全链路，不碰真实网关。
     */
    dispatchRunner?: typeof dispatchToAgent;
    /** 主 Agent 默认启用可见执行流程；后台子 Agent 传 false，避免无消费者时浪费 token。 */
    enablePlanning?: boolean;
  }
) {
  const planningEnabled = options?.enablePlanning !== false;
  const hasPlanTool = profile.tools.some((item) => item.name === WORKFLOW_PLAN_TOOL_NAME);
  const tools = planningEnabled && !hasPlanTool
    ? [...profile.tools, updateWorkflowPlanTool]
    : profile.tools;
  const modelOptions = { sessionId: options?.sessionId, runtime: options?.modelRuntime };
  const agentModel = models?.agent
    ?? withModelRetries(createChatModel(0, modelOptions).bindTools(tools) as unknown as WorkflowChatModel, options?.sessionId);
  const analystModel = models?.analyst
    ?? withModelRetries(createChatModel(0, modelOptions) as unknown as WorkflowChatModel, options?.sessionId);
  const reviewerModel = models?.reviewer
    ?? withModelRetries(createChatModel(0, modelOptions) as unknown as WorkflowChatModel, options?.sessionId);
  const riskAssessor = options?.riskAssessor
    ?? createToolRiskAssessor(createChatModel(0, modelOptions), options?.sessionId);
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
  const continuousReviewPrompt = profile.reviewerGuidance
    ? `${CONTINUOUS_REVIEW_PROMPT}\n${profile.reviewerGuidance}`
    : CONTINUOUS_REVIEW_PROMPT;

  function observeModel(node: "analyze" | "agent" | "review", response: AIMessage): void {
    try {
      options?.onModelUsage?.(node, response);
    } catch { /* usage 观测失败不能中断业务 */ }
  }

  async function analyzeNode(state: WorkflowStateType, nodeConfig?: {
    signal?: AbortSignal;
    configurable?: { continuous?: boolean };
  }) {
    const userText = lastHumanText(state.messages).slice(0, MAX_USER_TEXT);
    const history = state.clarificationHistory
      ? `上一轮澄清（仅在相关时参考）：${state.clarificationHistory}`
      : "";
    const fallback = {
      requirementBrief: [userText, history].filter(Boolean).join("\n").slice(0, MAX_BRIEF_TEXT),
      workflowPlan: null,
      clarification: null,
      reviewFeedback: "",
      reviewAttempts: 0,
      // 连续模式标记只由本轮请求决定，不跨回合残留；空转计数同理归零
      continuousMode: nodeConfig?.configurable?.continuous === true,
      idleReviewRounds: 0,
      lastReviewMessageCount: 0,
    };
    if (!userText.trim()) return fallback;

    try {
      const response = await invokeModel(analystModel, [
        { role: "system", content: analyzePrompt },
        {
          role: "user",
          content:
            `上一轮澄清（仅在相关时参考）：\n${state.clarificationHistory || "（无）"}\n\n` +
            `最近对话：\n${recentContext(state.messages) || "（无）"}\n\n当前请求：\n${userText}`,
        },
      ], nodeConfig?.signal, options?.sessionId);
      observeModel("analyze", response);
      const analysis = parseRequirementAnalysis(contentText(response.content));
      const brief = (analysis.brief || userText).slice(0, MAX_BRIEF_TEXT);
      if (analysis.understood) {
        return {
          ...fallback,
          requirementBrief: brief,
          workflowPlan: analysis.plan ? createWorkflowPlanFromDraft(analysis.plan) : null,
        };
      }
      return {
        ...fallback,
        requirementBrief: brief,
        clarification: {
          type: "clarification" as const,
          questions: analysis.questions,
        },
      };
    } catch {
      return fallback;
    }
  }

  async function clarifyNode(state: WorkflowStateType, nodeConfig?: LangGraphRunnableConfig) {
    const request = state.clarification;
    if (!request || !request.questions.length) return {};
    // 无头模式（REQUEST_HEADLESS / 请求级 headless:true）：没有人能回答，挂起等于
    // 任务被丢。改为采用默认假设继续，并把「本来要问什么、假设了什么」记进台账
    // 与 clarificationHistory，让模型和调用方都能看到这个决定。
    if (nodeConfig?.configurable?.headless === true) {
      const assumed = defaultAssumption(request);
      const answerText = assumed.label.slice(0, MAX_ANSWER_TEXT);
      const note = assumed.note.slice(0, MAX_ANSWER_TEXT);
      return {
        requirementBrief: `${state.requirementBrief}\n【无头模式自动假设】${note}`.slice(0, MAX_WORKING_BRIEF),
        clarification: null,
        clarificationHistory: answerText,
        headlessAssumption: note,
      };
    }
    const answer = interrupt<ClarificationRequest, string>(request);
    const raw = typeof answer === "string" ? answer.trim() : String(answer ?? "").trim();
    // 单题卡沿用「回传选项 id」的老协议，在这里映射成可读标签；
    // 多题卡的前端直接回传拼好的「题面：答案」文本，原样采纳即可。
    const single = request.questions.length === 1 ? request.questions[0] : null;
    const option = single ? single.options.find((item) => item.id === raw) : undefined;
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

  // ── 路由层（默认关闭）：规则 → 向量 → 决策模型 → 守卫 ────────────────
  // 拆成 route / routeAsk / dispatch 三个节点，原因：
  //   1. interrupt() 会让节点在 resume 时「从头重跑」，所以必须把「询问」与
  //      「派发子代理」放在不同节点，否则用户点一次选项会跑两遍子代理；
  //   2. dispatch 有副作用（多轮模型调用），绝不能和 interrupt 同节点。
  async function routeNode(state: WorkflowStateType, nodeConfig?: {
    signal?: AbortSignal;
    configurable?: { headless?: boolean };
  }) {
    if (!isRoutingEnabled()) return { routeDecision: null };
    const userText = lastHumanText(state.messages).slice(0, MAX_USER_TEXT);
    if (!userText.trim()) return { routeDecision: null };

    const result = await runRouteStep({
      text: userText,
      sessionKind: profile.id === "estate" ? "estate" : "agent",
      handoffCount: state.handoffCount,
      exclude: state.routeHistory,
      signal: nodeConfig?.signal,
    });
    const decision = result.decision;
    // 无头模式没人能回答询问：退化成当前 agent 处理，不留悬挂。
    if (decision.kind === "ask" && nodeConfig?.configurable?.headless === true) {
      return {
        routeDecision: {
          ...decision,
          kind: "main" as const,
          reason: `${decision.reason}（无头模式无人确认，改由当前 Agent 处理）`,
        },
      };
    }
    return { routeDecision: decision };
  }

  /**
   * 询问节点：把路由候选做成本轮澄清卡。
   * 复用 clarify 的 ClarificationRequest 形状，前端无需新组件。
   * 用户选择后写进 routeDecision.agentId，再交给 dispatch（不重新路由，避免来回问）。
   */
  async function routeAskNode(state: WorkflowStateType) {
    const decision = state.routeDecision;
    if (!decision || decision.kind !== "ask") return {};
    const top = decision.candidates.slice(0, 3);
    const options = [
      ...top.map((candidate, index) => ({
        id: String.fromCharCode(65 + index),
        label: `交给「${candidate.name}」`,
        description: `按该子代理的专项能力处理（匹配分 ${candidate.score.toFixed(2)}）`,
      })),
      { id: String.fromCharCode(65 + Math.min(top.length, 3)), label: "由当前 Agent 直接处理", description: "不使用子代理" },
    ];
    const request: ClarificationRequest = {
      type: "clarification",
      questions: [{
        id: "route",
        question: `路由：${decision.reason}`.slice(0, MAX_QUESTION_TEXT + 20),
        options,
        allowCustom: true,
      }],
    };
    const answer = interrupt<ClarificationRequest, string>(request);
    const raw = typeof answer === "string" ? answer.trim() : String(answer ?? "").trim();
    const picked = options.find((option) => option.id === raw);
    const index = picked ? options.indexOf(picked) : -1;
    const chosen = index >= 0 && index < top.length ? top[index] : null;
    return {
      routeDecision: {
        ...decision,
        kind: "dispatch" as const,
        layer: "fallback" as const,
        ...(chosen ? { agentId: chosen.agentId, agentName: chosen.name } : {}),
        reason: chosen
          ? `用户选择「${chosen.name}」。`
          : `用户选择由当前 Agent 处理（自定义输入：${raw.slice(0, 200)}）`,
      },
      // 用户自己指定了方向，就不再让路由层二次猜测。
      routeHistory: [...state.routeHistory],
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
        context_window?: number;
        personalization_context?: string;
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
      personalizationContext: config?.configurable?.personalization_context,
      memoryNote: (await memorySlot.note({
        scope: memoryScope(profile.id),
        query: lastUserText,
      })) ?? undefined,
      workflowPlanNote: planningEnabled ? workflowPlanPrompt(state.workflowPlan) : undefined,
      skillNote: skillNote ?? undefined,
      dispatchBrief: state.dispatchBrief
        ? `【子代理已完成的工作（作为你的已知事实，不要重复调用相同工具）】\n${state.dispatchBrief}`
        : undefined,
      taskLedger: config?.configurable?.task_ledger,
      budgetNote: config?.configurable?.task_budget_note,
      contextWindow: config?.configurable?.context_window,
    });
    // 思考型网关要求把历史 assistant 的 reasoning_content 原样回传；先从
    // checkpoint 消息里重新登记一次（服务重启后内存记录为空，靠这一步自愈），
    // 出站补字段由 llm.ts 的 fetch 封装完成。
    rememberHistoryReasoning(options?.sessionId, context.messages);
    const response = await invokeModel(agentModel, context.messages, config?.signal, options?.sessionId);
    observeModel("agent", response);
    // 网关回显的 tools/output 与 dataURL 会原样进入 checkpoint；先投影再入状态。
    return { messages: [sanitizeCheckpointMessage(response)] };
  }

  /**
   * 流程状态迁移节点：只读上一批工具调用，把 update_workflow_plan 的参数写回图状态。
   * 独立成节点而不是在 agentNode 里扫描历史，保证审批 resume 重放时仍按当前批次幂等应用。
   */
  async function planProgressNode(state: WorkflowStateType) {
    if (!planningEnabled) return {};
    let cursor = state.messages.length - 1;
    while (cursor >= 0 && state.messages[cursor]?.getType() === "tool") cursor -= 1;
    const lastAi = cursor >= 0 && state.messages[cursor]?.getType() === "ai"
      ? state.messages[cursor] as AIMessage
      : undefined;
    const calls = (lastAi?.tool_calls ?? []).filter((call) => call.name === WORKFLOW_PLAN_TOOL_NAME);
    let plan = state.workflowPlan;
    let changed = false;
    for (const call of calls) {
      const next = applyWorkflowPlanToolInput(plan, call.args);
      if (next !== plan) changed = true;
      plan = next;
    }
    // 工具结果已经标记 stopAgent 时不再回模型；若已有流程，把当前状态显式收口为失败，
    // 避免窗体永远停在一个“进行中”的假进度。
    if (plan && toolResultsStopTurn(state.messages)) {
      const finalized = finalizeWorkflowPlan(plan, "failed");
      if (finalized !== plan) changed = true;
      plan = finalized;
    }
    return changed ? { workflowPlan: plan } : {};
  }

  async function reviewNode(state: WorkflowStateType, nodeConfig?: { signal?: AbortSignal }) {
    const last = state.messages.at(-1);
    const lastAi = last?.getType() === "ai" ? (last as AIMessage) : undefined;
    const answer = contentText(lastAi?.content).slice(0, MAX_USER_TEXT);
    const attempts = state.reviewAttempts;
    // 空转检测：两次反思之间没有任何新工具消息 = 助手在纯文本打转。
    // 首次反思以整回合为基准（lastReviewMessageCount 为 0 → 取全部消息）。
    const sinceLastReview = state.lastReviewMessageCount > 0
      ? state.messages.slice(state.lastReviewMessageCount)
      : state.messages;
    const hadToolWork = sinceLastReview.some((message) => message.getType() === "tool");
    const bookkeeping = {
      idleReviewRounds: hadToolWork ? 0 : state.idleReviewRounds + 1,
      lastReviewMessageCount: state.messages.length,
    };
    const continuous = state.continuousMode;
    const plan = state.workflowPlan;
    const planSummary = workflowPlanSummary(plan);
    const unfinishedPlanSteps = plan?.steps.filter(
      (step) => step.status !== "completed" && step.status !== "skipped",
    ) ?? [];
    // 回炉上限：普通模式 3 次防死循环；连续模式放宽到保险丝级，靠空转熔断与异常兜底
    const cap = continuous ? MAX_CONTINUOUS_REVISIONS : MAX_REVIEW_REVISIONS;
    const finishPlan = (status: "completed" | "failed") => finalizeWorkflowPlan(plan, status);
    try {
      const response = await invokeModel(reviewerModel, [
        { role: "system", content: continuous ? continuousReviewPrompt : reviewPrompt },
        {
          role: "user",
          content:
            `用户本轮需求/理解：\n${state.requirementBrief || "（无）"}\n\n` +
            `上一轮澄清（仅在相关时参考）：\n${state.clarificationHistory || "（无）"}\n\n` +
            `执行流程：\n${planSummary}\n\n` +
            `最近工具结果：\n${recentToolResults(state.messages) || "（无）"}\n\n` +
            `助手最新回答：\n${answer || "（空回答）"}`,
        },
      ], nodeConfig?.signal, options?.sessionId);
      observeModel("review", response);
      const review = parseReviewResult(contentText(response.content));
      // 计划是可见承诺：有未完成/失败步骤时，即使模型说 passes 也不能提前收尾。
      if (review.passes && unfinishedPlanSteps.length && attempts < cap) {
        const names = unfinishedPlanSteps.slice(0, 6).map((step) => step.title).join("、");
        return {
          reviewFeedback: `执行流程仍有未完成或失败的步骤：${names}。请继续执行，并用 update_workflow_plan 同步证据；无法完成的步骤标记 failed 或 skipped 并说明原因。`,
          reviewAttempts: attempts + 1,
          ...bookkeeping,
        };
      }
      if (review.passes || attempts >= cap) {
        return {
          reviewFeedback: "",
          reviewAttempts: attempts + 1,
          ...bookkeeping,
          ...(plan ? { workflowPlan: finishPlan(unfinishedPlanSteps.length ? "failed" : "completed") } : {}),
        };
      }
      // 连续模式空转熔断：反思连续多轮不通过且期间没有任何工具动作，
      // 继续回炉只是烧钱；把控制权交还用户比第 N 次换措辞重说更有价值。
      if (continuous && bookkeeping.idleReviewRounds >= MAX_IDLE_REVIEW_ROUNDS) {
        return {
          reviewFeedback: "",
          reviewAttempts: attempts + 1,
          ...bookkeeping,
          ...(plan ? { workflowPlan: finishPlan("failed") } : {}),
        };
      }
      const feedback = (review.feedback || review.reason || "回答没有完全满足需求，请检查遗漏并补齐。")
        .slice(0, MAX_FEEDBACK_TEXT);
      return { reviewFeedback: feedback, reviewAttempts: attempts + 1, ...bookkeeping };
    } catch {
      return {
        reviewFeedback: "",
        reviewAttempts: attempts + 1,
        ...bookkeeping,
        ...(plan ? { workflowPlan: finishPlan(unfinishedPlanSteps.length ? "failed" : "completed") } : {}),
      };
    }
  }

  /**
   * 派发节点（有副作用，必须独立于 interrupt）。
   *
   * 安全边界：程序化派发**只授予只读工具**（没有审批文案的那些）。
   * 原因：`delegate_agent` 这条路径的「委派本身」就是审批项，用户批准时才放行；
   * 路由派发没有这一步，如果连 write_file / terminal 一起下放，等于绕过 §5.4。
   * 需要写操作时子代理会把需求写进「超出范围」，由主 Agent 走审批流程完成。
   */
  async function dispatchNode(state: WorkflowStateType, nodeConfig?: { signal?: AbortSignal }) {
    const decision = state.routeDecision;
    if (!decision || decision.kind !== "dispatch" || !decision.agentId) return {};
    const agent = findSubagent(decision.agentId);
    if (!agent || !agent.enabled) {
      return {
        routeDecision: {
          ...decision,
          kind: "main" as const,
          layer: "fallback" as const,
          reason: `目标子代理「${decision.agentId}」已不存在或已停用，由当前 Agent 处理。`,
        },
      };
    }

    const catalog = buildDelegationCatalog({
      parentTools: profile.tools,
      parentApprovals: profile.approvalDescriptions,
      // 房产会话本身已经绑了 house_*，再补一次会触发重名保护。
      includeEstateTools: profile.id !== "estate",
    });
    const readonlyEntries = catalog.filter((entry) => !entry.approvalDescription);

    const userText = lastHumanText(state.messages).slice(0, MAX_USER_TEXT);
    const briefing = renderBriefing({
      background: userText.slice(0, MAX_BRIEF_TEXT),
      goal: userText.slice(0, MAX_BRIEF_TEXT),
      tools: readonlyEntries.map((entry) => entry.tool.name),
      routing: agent.routing,
    });

    const result = await (options?.dispatchRunner ?? dispatchToAgent)({
      agent,
      task: userText,
      prompt: briefing,
      tools: readonlyEntries.map((entry) => entry.tool.name),
      entries: readonlyEntries,
      modelRuntime: options?.modelRuntime ?? defaultModelRuntime(),
      ...(nodeConfig?.signal ? { signal: nodeConfig.signal } : {}),
    });

    const outOfScope = parseOutOfScope(result.text);
    // handoffCount 记的是「转回次数」，不是「派发次数」：
    // 第一次派发不算转回（routeHistory 当时还是空的），之后的派发都算一次转回。
    const isReroute = state.routeHistory.length > 0;
    const nextHandoff = isReroute ? state.handoffCount + 1 : state.handoffCount;
    const history = state.routeHistory.includes(agent.id)
      ? state.routeHistory
      : [...state.routeHistory, agent.id];

    return {
      routeHistory: history,
      handoffCount: nextHandoff,
      // 子代理结论作为「已知事实」交给主 Agent 收尾，而不是直接当最终回答：
      // 主 Agent 还要校验、补齐、组织语言（R7 的「主 agent 收尾」）。
      dispatchBrief: [
        `【已派发给子代理「${agent.name}」】`,
        result.ok ? result.text : `子代理执行失败：${result.text}`,
        outOfScope ? "（该子代理声明了超出范围的部分，见上）" : "",
        `（用时 ${Math.round(result.durationMs / 1000)} 秒，用到工具：${result.toolsUsed.join("、") || "无"}）`,
      ].filter(Boolean).join("\n").slice(0, MAX_WORKING_BRIEF),
    };
  }

  /**
   * 派发后：还能转回就回到 route（排除已试过的 agent），否则交主 Agent 收尾。
   *
   * 判定只看「本轮是否出现过超出范围」+「转回额度」：
   * dispatchBrief 里有 outOfScope 段落才代表子代理明确说「我做不了」，
   * 普通成功不需要重新路由。
   */
  function afterDispatch(state: WorkflowStateType): "route" | "agent" {
    if (!state.dispatchBrief.includes(OUT_OF_SCOPE_MARKER)) return "agent";
    const limit = getRoutingSettings().limits.maxHandoffs;
    return state.handoffCount < limit ? "route" : "agent";
  }

  function afterRoute(state: WorkflowStateType): "routeAsk" | "dispatch" | "agent" {
    const decision = state.routeDecision;
    if (!decision) return "agent";
    if (decision.kind === "ask") return "routeAsk";
    if (shouldDispatch(decision)) return "dispatch";
    return "agent";
  }

  function afterAnalyze(state: WorkflowStateType): "clarify" | "route" | "agent" {
    // 路由未启用时直接进 agent：不产出空的 route 节点徽章，行为与引入前一致。
    if (!isRoutingEnabled()) return state.clarification ? "clarify" : "agent";
    return state.clarification ? "clarify" : "route";
  }

  /** 澄清之后同样按开关决定进不进路由节点，避免关闭时多一个空节点徽章。 */
  function afterClarify(): "route" | "agent" {
    return isRoutingEnabled() ? "route" : "agent";
  }

  function afterAgent(state: WorkflowStateType): "tools" | "review" {
    const last = state.messages.at(-1) as AIMessage | undefined;
    return last?.tool_calls?.length ? "tools" : "review";
  }

  function afterPlanProgress(state: WorkflowStateType): "agent" | typeof END {
    return toolResultsStopTurn(state.messages) ? END : "agent";
  }

  function afterReview(state: WorkflowStateType): "agent" | typeof END {
    return state.reviewFeedback ? "agent" : END;
  }

  let graph = new StateGraph(WorkflowState)
    .addNode("analyze", analyzeNode)
    .addNode("clarify", clarifyNode)
    .addNode("route", routeNode)
    .addNode("routeAsk", routeAskNode)
    .addNode("dispatch", dispatchNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addNode("planProgress", planProgressNode)
    .addNode("review", reviewNode)
    .addEdge(START, "analyze")
    .addConditionalEdges("analyze", afterAnalyze)
    .addConditionalEdges("clarify", afterClarify)
    .addConditionalEdges("route", afterRoute)
    .addEdge("routeAsk", "dispatch")
    .addConditionalEdges("dispatch", afterDispatch)
    .addConditionalEdges("agent", afterAgent)
    .addEdge("tools", "planProgress")
    .addConditionalEdges("planProgress", afterPlanProgress);

  return graph
    .addConditionalEdges("review", afterReview)
    .compile({
      // 默认挂共享持久检查点（重启续命，见 src/checkpoint.ts）；
      // 子 Agent / 单测可传自建 MemorySaver 保持一次性内存态。
      checkpointer: options?.checkpointer ?? getCheckpointSaver(),
    });
}
