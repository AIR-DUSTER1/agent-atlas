/**
 * ============================================================
 * modules/session-tree.ts — 会话树的纯函数与常量
 * ============================================================
 * 职责：分组键、标签、时间文案与搜索匹配的纯计算，不碰 DOM、不碰 pinia。
 * 为什么独立成模块：这些函数同时被 legacy 桥（views/sessions.ts，在 1:1
 * 过渡树上）和 Vue store（stores/sessions.ts，含 pinia）使用。若放在 store
 * 里，legacy 桥静态 import 就会把裸包名 pinia 带进 1:1 静态图并崩掉整条
 * 浏览器模块链（M4 红线）。
 */
import { state } from "../core/state.js";
import { profileMetaForSession } from "./agent-profile.js";
import type { Session } from "./types.js";

/** 未归属项目的会话在折叠状态里用这个键，避免与真实 projectId 冲突。 */
export const ORPHAN_GROUP_KEY = "__orphan__";

const DEMO_BADGE_TEXT: Record<number, string> = {
  1: "示例 1 · 基础 ReAct", 2: "示例 2 · 对话记忆",
  3: "示例 3 · 人工审批", 4: "示例 4 · 多 Agent",
};

export function demoBadgeText(demo: number | null | undefined): string {
  return demo ? DEMO_BADGE_TEXT[demo] || `示例 ${demo}` : "示例";
}

/** 会话列表短标签：Agent profile 走元数据，demo / external 保留各自语义。 */
export function sessionTagText(session: Session): string {
  if (session.kind === "external") return "外部";
  if (session.kind === "demo") return `示例 ${session.demo}`;
  return profileMetaForSession(session)?.shortLabel ?? "未知";
}

/** 会话搜索：标题必查；本浏览器缓存的消息块（state.blocks）参与匹配，
 *  没缓存到的会话按标题兜底 —— 服务端无搜索接口，保持零开销本地过滤。 */
export function sessionMatchesSearch(s: Session, term: string): boolean {
  if (!term) return true;
  const q = term.toLowerCase();
  if ((s.title || "").toLowerCase().includes(q)) return true;
  const blocks = state.blocks?.[s.id];
  if (!blocks) return false;
  return blocks.some((b) => {
    if (b.t === "user") return b.text.toLowerCase().includes(q);
    if (b.t === "notice" || b.t === "error") return b.text.toLowerCase().includes(q);
    if (b.t === "assistant") {
      return b.parts.some((p) => p.p === "text" && p.text.toLowerCase().includes(q));
    }
    return false;
  });
}

function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function sessionTimeLabel(ts: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  const time = new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (days <= 0) return time;
  if (days === 1) return `昨天 ${time}`;
  if (days < 7) return `${days} 天前`;
  return `${new Date(ts).getMonth() + 1}/${new Date(ts).getDate()}`;
}

export function sessionDayGroup(ts: number, now = Date.now()): "今天" | "昨天" | "更早" {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  return days <= 0 ? "今天" : days === 1 ? "昨天" : "更早";
}
