/**
 * ============================================================
 * actions/approvals.ts — 审批 / 澄清的决策与续跑
 * ============================================================
 * 职责：把用户点击「批准 / 拒绝 / 选择选项」变成 /api/resume 请求，
 * 并沿用原助手块继续流式渲染。
 * 设计立场：
 *  - 「一个回合 = 一个助手块」：续跑必须传原块，否则界面上会多出一个头像；
 *  - 决策前先本地更新卡片状态（乐观 UI），失败才由流里的事件纠正；
 *  - streaming 期间不允许再次决策（防双发）。
 */

import { state, transcript } from "../core/state.js";
import { assistantBlockContaining } from "../modules/chat-flow.js";
import { partEls, saveLocal } from "../core/state.js";
import { renderApprovalCard, renderClarificationCard, clarificationAnswerLines } from "../render/parts.js";
import { renderSessions } from "../views/sessions.js";
import { toast } from "../ui/toast.js";
import { runResume } from "../stream/turn.js";
import type { ApprovalPart, ClarificationPart } from "../modules/types.js";

/**
 * 审批 / 澄清决策的统一准入检查。
 *
 * 为什么不能静默 return：原来这里直接 `return`，用户在「会话还在生成」时点
 * 「批准并执行」会完全没反应 —— 卡片不动、没有提示，看起来就是按钮坏了。
 * 现在明确告诉用户该等什么、或者可以直接点停止。
 */
function blockedReason(): string | null {
  const sid = state.currentId;
  if (!sid) return null;
  if (state.compacting[sid]) return "上下文压缩还没结束，请等它完成后再处理这条审批。";
  if (state.streams[sid]) {
    return "本会话还有一轮正在生成。请等它结束，或先点输入框右侧的停止按钮，再回来处理这条审批。";
  }
  return null;
}

export async function decideApproval(part: ApprovalPart, status: "approved" | "rejected"): Promise<void> {
  const blocked = blockedReason();
  if (blocked) {
    toast(blocked, "warning");
    return;
  }
  part.status = status;
  const refs = partEls.get(part);
  if (refs) renderApprovalCard(part, refs.el);
  clearAwaitingApproval(part.req.toolName);
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (s) s.pendingApproval = false;
  renderSessions();
  saveLocal();
  await runResume(
    { decision: status === "approved" ? "approve" : "reject" },
    assistantBlockContaining(transcript(state.currentId), part)
  );
}

/**
 * 审批决定已下：把工具卡的「待审批」标掉。
 *
 * 批准时工具即将真正执行，交回「运行中」是正确的；拒绝则由服务端不执行、
 * 直接回一条「用户拒绝」的 ToolMessage，卡片会随 tool_result 变成失败态。
 * 两种情况都不能继续挂着「待审批」——那会让用户以为还没处理。
 */
function clearAwaitingApproval(toolName: string): void {
  const blocks = transcript(state.currentId);
  for (let b = blocks.length - 1; b >= 0; b -= 1) {
    const block = blocks[b];
    if (block?.t !== "assistant" || !Array.isArray(block.parts)) continue;
    for (let i = block.parts.length - 1; i >= 0; i -= 1) {
      const part = block.parts[i];
      if (part?.p !== "tool" || part.name !== toolName || !part.awaitingApproval) continue;
      part.awaitingApproval = false;
      void import("../render/parts.js").then((m) => m.updateToolCard(part));
      return;
    }
  }
}

export async function decideClarification(part: ClarificationPart, choice: string, label: string): Promise<void> {
  const blocked = blockedReason();
  if (blocked) {
    toast(blocked, "warning");
    return;
  }
  const value = String(choice || "").trim();
  if (!value) return;
  part.status = "answered";
  part.answer = label || value;
  // 多题卡要在已答态逐题展示「问题 → 答案」；在提交前把草稿固化成 answerLines，
  // 卡片重绘与历史回放都不必再依赖 draft（draft 只服务于待答态的交互）。
  const lines = clarificationAnswerLines(part);
  if (lines) part.answerLines = lines;
  const refs = partEls.get(part);
  if (refs) {
    refs.el.className = "approval-card clarification-card done-approve";
    renderClarificationCard(part, refs.el);
  }
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (s) s.pendingApproval = false;
  renderSessions();
  saveLocal();
  await runResume({ choice: value }, assistantBlockContaining(transcript(state.currentId), part));
}
