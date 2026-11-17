/**
 * workflow/limits.ts — 工作流输入、输出与回合控制上限
 * ============================================================
 * 所有截断/轮次限制集中在这里，节点只消费常量，避免同一语义出现多份魔法数字。
 */
export const MAX_USER_TEXT = 8_000;
export const MAX_BRIEF_TEXT = 1_200;
export const MAX_WORKING_BRIEF = 3_500;
export const MAX_QUESTION_TEXT = 240;
export const MAX_OPTION_LABEL = 80;
export const MAX_OPTION_DESCRIPTION = 200;
export const MAX_ANSWER_TEXT = 2_000;
export const MAX_FEEDBACK_TEXT = 1_200;
export const MAX_OPTIONS = 4;
/** 一道澄清卡最多打包几道题：再多就该拆成「先问最关键的」，一次问 5 题等于逼用户放弃。 */
export const MAX_QUESTIONS = 4;
export const MAX_REVIEW_REVISIONS = 3;
/**
 * 连续模式的反思回炉保险丝：真正的停止条件是「反思通过 / 空转熔断 / 请求异常 / 用户中止」，
 * 这个数只防「永远差一点」的任务无限烧钱；按 8 小时 × 分钟级回炉周期估算取千级。
 */
export const MAX_CONTINUOUS_REVISIONS = 1_000;
/**
 * 连续模式的空转熔断：连续 N 轮「反思不通过且期间没有任何工具动作」就结束回合。
 * 任务真在推进时每轮都有工具结果，计数每轮清零；只有纯文本打转才会计满。
 */
export const MAX_IDLE_REVIEW_ROUNDS = 3;
export const RECENT_MESSAGE_COUNT = 8;
export const RECENT_MESSAGE_CHARS = 700;
export const RECENT_TOOL_RESULT_COUNT = 3;
export const MAX_TOOL_RESULT_TEXT = 600;