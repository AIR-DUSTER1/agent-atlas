/**
 * ============================================================
 * routing/briefing.ts — 子代理任务交代模板（R9）
 * ============================================================
 * 职责：把一次派发渲染成「对刚走进会议室的同事交代工作」的结构化任务书，
 * 并提供解析/校验，保证关键小节不缺失。
 *
 * 设计立场：
 *  - **确定性拼装**优于让模型自由发挥：程序化路由（规则快速路径）时没有模型
 *    参与写提示词，必须由代码生成完整任务书；
 *  - 「已知事实」是最有价值的一节：它避免子代理重复执行主 Agent 已经做过的
 *    工具调用（当前实现里这是真实浪费）；
 *  - 「确定」与「不确定」分开：不确定的显式标注「未确认」，禁止把猜测写成事实；
 *  - `outOfScope` 的用法必须写进任务书 —— 这是转回机制（R7）能被正确触发的前提。
 */
import type { SubagentRouting } from "./types.js";

/** 单节内容的字符上限，避免任务书本身变成新的上下文负担。 */
const MAX_SECTION_CHARS = 1_200;
const MAX_BRIEF_CHARS = 6_000;

export interface BriefingInput {
  /** 用户原话意图（1–2 句） */
  background: string;
  /** 一句话说明要交付什么 */
  goal: string;
  /** 调过的工具结果、用户已确认的约束；没有就传空数组 */
  knownFacts?: readonly string[];
  /** 本次允许使用的工具名 */
  tools: readonly string[];
  /** 不做的事：来自 notSuitableFor 与用户明确排除项 */
  avoid?: readonly string[];
  /** 交付格式 / 长度 / 必须包含的元素 */
  deliverable?: string;
  /** 可验证的完成标准 */
  doneWhen?: string;
  /** 该子代理的路由名片（用于补齐「不要做」） */
  routing?: SubagentRouting;
}

function clip(text: string, max = MAX_SECTION_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…（已截断）` : trimmed;
}

function bulletList(items: readonly string[], empty: string): string {
  const cleaned = items.map((item) => clip(item.replace(/\s+/g, " "))).filter(Boolean);
  if (!cleaned.length) return empty;
  return cleaned.map((item) => `  - ${item}`).join("\n");
}

/**
 * 渲染任务书。输出是纯文本（不是 JSON），因为它是给人读的交代口吻，
 * 也便于直接作为子代理的专项提示词。
 */
export function renderBriefing(input: BriefingInput): string {
  const avoid = [...new Set([
    ...(input.avoid ?? []),
    ...(input.routing?.notSuitableFor ?? []),
  ].map((item) => item.trim()).filter(Boolean))];
  const tools = input.tools.filter(Boolean);

  const sections = [
    "你在接手一件已经进行中的工作。以下是全部你需要知道的信息。",
    "",
    `【背景】${clip(input.background) || "（未提供，按用户原话理解）"}`,
    "",
    `【你的目标】${clip(input.goal) || "完成本次任务并给出可交付结论"}`,
    "",
    "【已知事实】",
    bulletList(input.knownFacts ?? [], "  - 无（没有可复用的工具结果，请自行查证）"),
    "",
    "【边界】",
    `  - 只能用这些工具：${tools.length ? tools.join("、") : "无（本次只能纯推理）"}`,
    "  - 不要做：",
    avoid.length ? avoid.map((item) => `      · ${item}`).join("\n") : "      · 不要重复执行主 Agent 已经做过的工具调用",
    "  - 遇到超出范围的问题：照常完成你能做的部分，把超出部分写进结果末尾的",
    "    「【超出范围】」小节（说明缺什么能力、建议交给谁），不要猜、不要假装做过。",
    "",
    `【交付】${clip(input.deliverable ?? "结构化中文结论：先给结论，再给依据与限制；不要复述任务书，不要输出内部 JSON。")}`,
    "",
    `【完成标准】${clip(input.doneWhen ?? "覆盖目标中的每一项要求，且没有把未执行的动作描述成已完成。")}`,
  ];
  const text = sections.join("\n");
  return text.length > MAX_BRIEF_CHARS ? `${text.slice(0, MAX_BRIEF_CHARS)}\n…（任务书过长已截断）` : text;
}

/** 任务书六小节标题；缺任何一个都说明拼装出错，单测据此守门。 */
export const BRIEFING_SECTIONS = ["【背景】", "【你的目标】", "【已知事实】", "【边界】", "【交付】", "【完成标准】"] as const;

/** 校验渲染结果是否包含全部小节（单测与自检用）。 */
export function briefingSectionMissing(text: string): string[] {
  return BRIEFING_SECTIONS.filter((section) => !text.includes(section));
}

/** 子代理结果里约定的「超出范围」标记；命中即视为 R7 的转回信号。 */
export const OUT_OF_SCOPE_MARKER = "【超出范围】";

export interface OutOfScopeReport {
  reason: string;
  /** 子代理建议的目标（可能为空，由主 Agent 重新路由） */
  suggested: string[];
}

/**
 * 从子代理回答里提取「超出范围」小节。
 *
 * 只认**独立成行**的标记（允许前导空白与 Markdown 列表/引用前缀），
 * 并且取最后一个这样的行：正文里顺口提到这四个字不算，避免误触发转回。
 */
export function parseOutOfScope(text: string): OutOfScopeReport | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let index = -1;
  for (let cursor = lines.length - 1; cursor >= 0; cursor -= 1) {
    const normalized = lines[cursor]!.replace(/^\s*(?:[-*>]\s*)?/, "");
    if (normalized.startsWith(OUT_OF_SCOPE_MARKER)) {
      index = cursor;
      break;
    }
  }
  if (index < 0) return null;
  const firstLine = lines[index]!.replace(/^\s*(?:[-*>]\s*)?/, "").slice(OUT_OF_SCOPE_MARKER.length).trim();
  const tail = [firstLine, ...lines.slice(index + 1)].join("\n").trim();
  if (!tail) return null;
  const suggestedLine = tail.split(/\r?\n/).find((line) => /建议|suggest/i.test(line)) ?? "";
  const suggested = suggestedLine
    .replace(/^.*?(建议|suggest(?:ed)?)[:：]?\s*/i, "")
    .split(/[,，、;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => /^[a-z0-9][a-z0-9-]{0,63}$/i.test(item));
  return { reason: tail.slice(0, MAX_SECTION_CHARS), suggested };
}
