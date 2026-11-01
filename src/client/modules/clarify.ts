/**
 * modules/clarify.ts — 澄清载荷归一化与答案拼装
 * ============================================================
 * 职责：把服务端（新）或历史 journal（旧）的澄清载荷统一成「若干道题」，
 * 并把用户的逐题作答拼成一条可读的恢复文本。
 * 设计立场：
 *  - 纯函数、零 DOM：单测直接调，渲染层只负责画；
 *  - 新旧两种载荷在这里收敛成一种形状，渲染与恢复都只认归一化后的结果，
 *    否则每加一处渲染判断都要同时兼容两种形状，早晚漏一处。
 */

import type {
  ClarificationOption, ClarificationPayload, ClarificationQuestion,
} from "./types.js";

/** 一张卡最多渲染几道题；与服务端 MAX_QUESTIONS 对齐（防御旧 journal 或第三方构造）。 */
export const MAX_CLARIFY_QUESTIONS = 4;

/**
 * 提交文本上限，与 /api/resume 的 2000 字截断一致。
 * 不做这个收口，4 题各填 500 字就可能超限，服务端静默 slice 会把最后一题切半
 * —— 模型看到半截答案比看到「截断标记」更糟。这里按题数均分预算。
 */
export const MAX_SUBMISSION_CHARS = 2_000;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptions(value: unknown): ClarificationOption[] {
  if (!Array.isArray(value)) return [];
  const options: ClarificationOption[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; label?: unknown; description?: unknown };
    const label = asText(record.label);
    if (!label) continue;
    const suggested = asText(record.id).toUpperCase();
    const id = /^[A-Z]$/.test(suggested) ? suggested : String.fromCharCode(65 + options.length);
    if (seen.has(id)) continue;
    seen.add(id);
    const description = asText(record.description);
    options.push(description ? { id, label, description } : { id, label });
    if (options.length >= 4) break;
  }
  return options;
}

/**
 * 归一化澄清载荷。
 *
 * 两种来源都要吃得下：
 *   - 新载荷：questions 数组（可多题）；
 *   - 旧载荷 / 历史 journal：顶层 question + options + allowCustom（单题）。
 * 只有一道题且没有选项时返回空数组 —— 没选项的题无法作答，画出来只会卡住用户。
 */
export function normalizeClarify(payload: ClarificationPayload | null | undefined): ClarificationQuestion[] {
  if (!payload) return [];
  const questions: ClarificationQuestion[] = [];
  const seen = new Set<string>();

  for (const item of Array.isArray(payload.questions) ? payload.questions : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<ClarificationQuestion>;
    const text = asText(record.question);
    const options = normalizeOptions(record.options);
    if (!text || options.length < 2) continue;
    const suggestedId = asText(record.id).toLowerCase();
    const id = /^[a-z0-9_-]{1,24}$/.test(suggestedId) ? suggestedId : `q${questions.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    questions.push({ id, question: text, options, allowCustom: record.allowCustom !== false });
    if (questions.length >= MAX_CLARIFY_QUESTIONS) break;
  }

  if (!questions.length) {
    const legacyText = asText(payload.question);
    const legacyOptions = normalizeOptions(payload.options);
    if (legacyText && legacyOptions.length >= 2) {
      questions.push({
        id: "q1",
        question: legacyText,
        options: legacyOptions,
        allowCustom: payload.allowCustom !== false,
      });
    }
  }
  return questions;
}

/** 用户对一道题的选择：选项答案（id 用于单题协议回传，label 用于展示与拼装）。 */
export interface ClarifyAnswer {
  /** 选项 id；自定义输入时为 null */
  optionId: string | null;
  /** 展示用文本（选项 label 或用户输入的原文） */
  label: string;
  /** 选项自带的补充说明，仅选项作答时有值 */
  detail?: string;
}

/** 把一道题的作答渲染成「选项标题（说明）」；自定义输入直接返回原文。 */
export function answerText(answer: ClarifyAnswer): string {
  const label = answer.label.trim();
  if (!label) return "";
  const detail = answer.detail?.trim();
  return detail ? `${label}（${detail}）` : label;
}

/**
 * 拼装提交给 /api/resume 的文本。
 *
 * 单题保持只回传答案本身：服务端 clarifyNode 仍能把选项 id 映射成可读标签，
 * 历史回放与「（需求澄清：北京）」这类旧记录因此保持同形，不必迁移。
 * 多题必须带上题面 —— 否则模型只看到「青岛；前端；15-20K」不知道每项对应什么。
 * 结果超过 MAX_SUBMISSION_CHARS 时按题均分预算逐题截断，保证每道题都有内容且不切坏最后一题。
 */
export function buildClarifySubmission(
  questions: ClarificationQuestion[],
  answers: Record<string, ClarifyAnswer | undefined>
): string {
  if (!questions.length) return "";
  if (questions.length === 1) {
    const one = answers[questions[0]!.id];
    if (!one) return "";
    // 选项作答回传 id，让服务端走原有的「id → 可读标签」映射；自定义输入回传原文。
    const text = one.optionId ?? one.label.trim();
    return text.slice(0, MAX_SUBMISSION_CHARS);
  }
  const lines: string[] = [];
  for (const question of questions) {
    const answer = answers[question.id];
    const text = answer ? answerText(answer) : "";
    if (!text) continue;
    lines.push(`${question.question}：${text}`);
  }
  if (!lines.length) return "";
  const joined = lines.join("；");
  if (joined.length <= MAX_SUBMISSION_CHARS) return joined;
  // 超限：按题均分预算（扣掉题面与分隔符），逐题截断后重拼
  const overhead = lines.reduce((sum, line) => sum + line.indexOf("：") + 1, 0) + (lines.length - 1);
  const perAnswer = Math.max(40, Math.floor((MAX_SUBMISSION_CHARS - overhead) / lines.length));
  return lines
    .map((line) => {
      const split = line.indexOf("：");
      if (split < 0) return line.slice(0, perAnswer);
      const head = line.slice(0, split + 1);
      const body = line.slice(split + 1);
      return body.length > perAnswer ? `${head}${body.slice(0, perAnswer)}…` : line;
    })
    .join("；")
    .slice(0, MAX_SUBMISSION_CHARS);
}

/** 落盘到卡片的「已选择」摘要：多题时逐题列出，单题就是答案本身。 */
export function summarizeClarify(
  questions: ClarificationQuestion[],
  answers: Record<string, ClarifyAnswer | undefined>
): string {
  if (questions.length <= 1) {
    const one = questions[0] ? answers[questions[0].id] : undefined;
    return one ? answerText(one) : "";
  }
  return answerLinesOf(questions, answers)
    .map((line) => `${line.question}：${line.answer}`)
    .join("；");
}

/** 逐题答案列表：已答的题各占一行，供已答卡与历史回放渲染。 */
export function answerLinesOf(
  questions: ClarificationQuestion[],
  answers: Record<string, ClarifyAnswer | undefined>
): Array<{ question: string; answer: string }> {
  const lines: Array<{ question: string; answer: string }> = [];
  for (const question of questions) {
    const answer = answers[question.id];
    const text = answer ? answerText(answer) : "";
    if (text) lines.push({ question: question.question, answer: text });
  }
  return lines;
}

/** 已答完几题（用于进度提示与提交按钮可用性）。 */
export function answeredCount(
  questions: ClarificationQuestion[],
  answers: Record<string, ClarifyAnswer | undefined>
): number {
  let count = 0;
  for (const question of questions) {
    const answer = answers[question.id];
    if (answer && answerText(answer)) count += 1;
  }
  return count;
}
