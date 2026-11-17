/**
 * workflow/nodes/clarify.ts — 澄清卡与 interrupt() 恢复节点
 * ============================================================
 * 该节点只处理用户选择，不执行有副作用的外部动作；无头模式自动采用首个选项继续。
 */
import { interrupt, type LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  MAX_ANSWER_TEXT,
  MAX_WORKING_BRIEF,
} from "../limits.js";
import { defaultAssumption } from "../parsing.js";
import type { WorkflowStateType } from "../state.js";
import type { ClarificationRequest } from "../types.js";

export function createClarifyNode() {
  return async function clarifyNode(state: WorkflowStateType, nodeConfig?: LangGraphRunnableConfig) {
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
  };
}