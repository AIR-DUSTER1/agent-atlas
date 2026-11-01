/**
 * render/clarify-card.ts — 需求澄清卡片（一次可问多题）
 * ============================================================
 * 职责：把 ClarificationRequest 画成「逐题选择 + 一次性提交」的卡片，
 * 并把历史回放里的已答状态画成只读摘要。
 * 设计立场：
 *  - 单题卡片保持旧交互：点选项即提交（一次点击搞定，不需要再点确认）；
 *  - 多题卡片必须显式提交，且全部答完才亮按钮 —— 半答提交等于把半个问题丢回给模型；
 *  - 旧 journal 的「顶层 question + options」单问载荷由 modules/clarify 归一化，
 *    这里只认归一化结果，不在渲染层写第二套兼容分支。
 */
import { decideClarification } from "../actions/approvals.js";
import { saveLocal } from "../core/state.js";
import {
  answeredCount, answerLinesOf, buildClarifySubmission, normalizeClarify, summarizeClarify,
  type ClarifyAnswer,
} from "../modules/clarify.js";
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";
import type { ClarificationPart } from "../modules/types.js";
import type { ClarificationQuestion } from "../modules/types.js";

/** 自定义输入上限：与 user 消息上限同量级即可，再长就不该塞进澄清卡。 */
const MAX_CUSTOM_CHARS = 500;

export function renderClarificationCard(part: ClarificationPart, el: HTMLElement): void {
  const questions = normalizeClarify(part.req);
  el.classList.add("clarify-card");
  el.classList.toggle("clarify-multi", questions.length > 1);
  if (part.status !== "pending") {
    renderAnswered(part, el);
    return;
  }
  if (!questions.length) {
    renderUnavailable(el);
    return;
  }
  renderPending(part, el, questions);
}

// ---------------------------------------------------------------------------
// 待作答
// ---------------------------------------------------------------------------

function renderPending(part: ClarificationPart, el: HTMLElement, questions: ClarificationQuestion[]): void {
  const multi = questions.length > 1;
  const answers = part.draft ?? (part.draft = {});

  const progress = h("span", { class: "clarify-progress" });
  const hint = h("span", { class: "clarify-hint" });
  const submit = h("button", { type: "button", class: "btn btn-approve clarify-submit" },
    multi ? "提交答复" : "提交");

  el.replaceChildren(
    h("div", { class: "clarify-head" },
      h("span", { class: "clarify-head-icon" }, icon("CircleHelp", { size: 15 })),
      h("div", { class: "clarify-head-copy" },
        h("div", { class: "clarify-head-title" }, "需求澄清"),
        h("div", { class: "clarify-head-note" },
          multi
            ? `一次答完这 ${questions.length} 个问题，Agent 就能接着做`
            : "选一个方向，Agent 会按它继续"),
      ),
      progress,
    ),
    h("div", { class: "clarify-list" }),
    h("div", { class: "clarify-foot" },
      hint,
      submit,
    ),
  );

  const list = el.querySelector(".clarify-list");
  for (const [index, question] of questions.entries()) {
    list?.appendChild(renderQuestion(part, question, index, questions, answers, multi, () => { refreshFoot(); }));
  }

  function refreshFoot(): void {
    const done = answeredCount(questions, answers);
    progress.textContent = `${done}/${questions.length}`;
    progress.classList.toggle("ok", done === questions.length);
    const ready = multi ? done === questions.length : Boolean(answers[questions[0]!.id]);
    submit.disabled = !ready;
    if (!multi) {
      // 单题：选中选项后点「提交」（也可以点「自己填写」改成自由输入）。
      // 提示必须随状态变化，否则选完仍显示「也可以直接输入」会让人以为没记录。
      hint.textContent = answers[questions[0]!.id]
        ? "点「提交」把这个回答发给 Agent"
        : "选一项，或点「自己填写」直接输入";
    } else {
      const missing = questions.length - done;
      hint.textContent = missing > 0 ? `还差 ${missing} 题` : "已全部回答";
    }
  }

  submit.addEventListener("click", () => {
    if (part.status !== "pending") return;
    const submission = buildClarifySubmission(questions, answers);
    if (!submission) return;
    void decideClarification(part, submission, summarizeClarify(questions, answers));
  });

  refreshFoot();
}

function renderQuestion(
  part: ClarificationPart,
  question: ClarificationQuestion,
  index: number,
  questions: ClarificationQuestion[],
  answers: Record<string, ClarifyAnswer | undefined>,
  multi: boolean,
  onDraftChange: () => void,
): HTMLElement {
  const item = h("div", { class: "clarify-item" });
  item.append(
    h("div", { class: "clarify-q" },
      h("span", { class: "clarify-q-index", "aria-hidden": "true" }, String(index + 1)),
      h("span", { class: "clarify-q-text" }, question.question),
    ),
  );

  const choices = h("div", { class: "clarify-choices", role: "group", "aria-label": question.question });
  /** 就地刷新本题选中态：不整卡重绘，否则会丢其它题输入框的焦点与光标位置。 */
  function syncSelection(): void {
    const chosen = answers[question.id]?.optionId ?? null;
    for (const button of choices.querySelectorAll<HTMLButtonElement>(".clarify-choice")) {
      const isSelected = button.dataset.optionId === chosen;
      button.classList.toggle("selected", isSelected);
      button.setAttribute("aria-pressed", String(isSelected));
    }
  }

  for (const option of question.options) {
    const selected = answers[question.id]?.optionId === option.id;
    const button = h("button", {
      type: "button",
      class: "clarify-choice" + (selected ? " selected" : ""),
      "aria-pressed": String(selected),
      dataset: { optionId: option.id },
    },
      h("span", { class: "clarify-key", "aria-hidden": "true" }, option.id),
      h("span", { class: "clarify-choice-copy" },
        h("span", { class: "clarify-choice-label" }, option.label),
        option.description ? h("span", { class: "clarify-choice-desc" }, option.description) : null,
      ),
      h("span", { class: "clarify-choice-check", "aria-hidden": "true" }, icon("Check", { size: 13 })),
    );
    button.addEventListener("click", () => {
      if (part.status !== "pending") return;
      const answer: ClarifyAnswer = {
        optionId: option.id,
        label: option.label,
        ...(option.description ? { detail: option.description } : {}),
      };
      answers[question.id] = answer;
      // 选了选项就清空本题的自定义输入，避免「选了 A 但输入框里还有旧文本」的歧义。
      const custom = item.querySelector<HTMLInputElement>(".clarify-input");
      if (custom) custom.value = "";
      syncSelection();
      saveLocal();
      // 单题点选即提交：沿用旧交互，少一次点击；多题只记录选择，等用户逐题答完再提交。
      if (!multi) {
        void decideClarification(part, buildClarifySubmission(questions, answers), summarizeClarify(questions, answers));
        return;
      }
      onDraftChange();
    });
    choices.appendChild(button);
  }
  item.appendChild(choices);

  if (question.allowCustom !== false) {
    const current = answers[question.id];
    // 输入框按需展开：3-4 题的卡如果每题都常驻一个输入框，卡片会高到需要滚动，
    // 而绝大多数用户只点选项。展开后焦点自动进入，再点一次收起。
    const customWrap = h("div", { class: "clarify-custom hidden" });
    const input = h("input", {
      type: "text",
      class: "clarify-input",
      maxlength: String(MAX_CUSTOM_CHARS),
      placeholder: "直接输入这一题的答案…",
      "aria-label": `第 ${index + 1} 题的自定义回答：${question.question}`,
    });
    if (current && current.optionId === null) input.value = current.label;
    input.addEventListener("input", () => {
      if (part.status !== "pending") return;
      const value = input.value.trim();
      if (value) answers[question.id] = { optionId: null, label: value };
      else delete answers[question.id];
      saveLocal();
      // 输入自定义答案时取消本题的选项高亮：两者互斥，同时显示会让人以为答了两遍。
      syncSelection();
      // 输入时不重绘：重绘会丢焦点与光标位置，只刷新底部提示与按钮可用性。
      onDraftChange();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (part.status !== "pending") return;
      const submission = buildClarifySubmission(questions, answers);
      if (submission) void decideClarification(part, submission, summarizeClarify(questions, answers));
    });
    customWrap.appendChild(input);

    const toggle = h("button", {
      type: "button",
      class: "clarify-custom-toggle",
      "aria-expanded": "false",
    }, icon("Pencil", { size: 11 }), "自己填写");
    toggle.addEventListener("click", () => {
      if (part.status !== "pending") return;
      const open = customWrap.classList.toggle("hidden") === false;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.classList.toggle("open", open);
      if (open) input.focus();
      else if (answers[question.id]?.optionId === null) {
        // 收起时放弃未提交的自定义答案，回到「未答」状态，避免看不见的答案被提交
        delete answers[question.id];
        saveLocal();
        onDraftChange();
      }
    });
    // 已在该题写自定义答案时默认展开，用户看得见自己填了什么
    if (current && current.optionId === null) {
      customWrap.classList.remove("hidden");
      toggle.setAttribute("aria-expanded", "true");
      toggle.classList.add("open");
    }
    item.appendChild(h("div", { class: "clarify-custom-row" }, customWrap, toggle));
  }

  return item;
}

// ---------------------------------------------------------------------------
// 已作答 / 不可用
// ---------------------------------------------------------------------------

function renderAnswered(part: ClarificationPart, el: HTMLElement): void {
  const lines = part.answerLines?.length
    ? part.answerLines
    : part.answer
      ? [{ question: "", answer: part.answer }]
      : [];
  el.replaceChildren(
    h("div", { class: "clarify-head done" },
      h("span", { class: "clarify-head-icon done" }, icon("CircleCheck", { size: 15 })),
      h("div", { class: "clarify-head-copy" },
        h("div", { class: "clarify-head-title" }, "需求澄清"),
        h("div", { class: "clarify-head-note" }, lines.length ? "已按你的回答继续" : "此前已处理"),
      ),
      h("span", { class: "clarify-progress ok" }, "已答复"),
    ),
    h("div", { class: "clarify-answers" },
      ...lines.map((line) => h("div", { class: "clarify-answer" },
        line.question ? h("span", { class: "clarify-answer-q" }, line.question) : null,
        h("span", { class: "clarify-answer-a" }, line.answer),
      )),
    ),
  );
}

function renderUnavailable(el: HTMLElement): void {
  el.replaceChildren(
    h("div", { class: "clarify-head" },
      h("span", { class: "clarify-head-icon" }, icon("CircleAlert", { size: 15 })),
      h("div", { class: "clarify-head-copy" },
        h("div", { class: "clarify-head-title" }, "需求澄清"),
        h("div", { class: "clarify-head-note" }, "这张卡没有可选项，请直接重新发起请求"),
      ),
    ),
  );
}

/** 供 actions/approvals 记录「已答摘要」：多题逐题列出，单题沿用旧的一行文案。 */
export function clarificationAnswerLines(part: ClarificationPart): Array<{ question: string; answer: string }> | null {
  const questions = normalizeClarify(part.req);
  if (questions.length <= 1) return null;
  return answerLinesOf(questions, part.draft ?? {});
}
