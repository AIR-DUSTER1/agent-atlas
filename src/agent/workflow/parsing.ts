/**
 * workflow/parsing.ts — 模型 JSON 宽容解析与澄清载荷归一化
 * ============================================================
 * 模型输出永远按不可信文本处理：坏 JSON 默认继续执行，避免格式问题拖死聊天。
 */
import { normalizeWorkflowPlanDraft } from "../../workflow-plan.js";
import {
  MAX_ANSWER_TEXT,
  MAX_BRIEF_TEXT,
  MAX_FEEDBACK_TEXT,
  MAX_OPTION_DESCRIPTION,
  MAX_OPTION_LABEL,
  MAX_OPTIONS,
  MAX_QUESTION_TEXT,
  MAX_QUESTIONS,
} from "./limits.js";
import type {
  ClarificationOption,
  ClarificationQuestion,
  ClarificationRequest,
  RequirementAnalysis,
  ReviewResult,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
    label: parts.map((part) => part.answer).join("；").slice(0, MAX_ANSWER_TEXT),
    note: parts.map((part) => `问：${part.question}\n假设：${part.answer}`).join("\n").slice(0, MAX_ANSWER_TEXT),
  };
}