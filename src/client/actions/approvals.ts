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
import { renderApprovalCard, renderClarificationCard } from "../render/parts.js";
import { renderSessions } from "../views/sessions.js";
import { runResume } from "../stream/turn.js";
import type { ApprovalPart, ClarificationPart } from "../modules/types.js";

export async function decideApproval(part: ApprovalPart, status: "approved" | "rejected"): Promise<void> {
  if (state.streaming) return;
  part.status = status;
  const refs = partEls.get(part);
  if (refs) renderApprovalCard(part, refs.el);
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (s) s.pendingApproval = false;
  renderSessions();
  saveLocal();
  await runResume(
    { decision: status === "approved" ? "approve" : "reject" },
    assistantBlockContaining(transcript(state.currentId), part)
  );
}

export async function decideClarification(part: ClarificationPart, choice: string, label: string): Promise<void> {
  if (state.streaming) return;
  const value = String(choice || "").trim();
  if (!value) return;
  part.status = "answered";
  part.answer = label || value;
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
