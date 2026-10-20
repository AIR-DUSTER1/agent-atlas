/**
 * ============================================================
 * session-store.ts — 会话 journal（NDJSON append-only + 启动回放 + compact）
 * ============================================================
 * T2-2 会话持久化 / T2-3 审批持久化 / T2-4 历史注入，共用的存储层。
 * 数据落 `.setting/sessions.ndjson`（gitignore —— 对话内容不入库）。
 *
 * journal 事件（一行一 JSON）：
 *   session   会话创建 / 元数据全量（upsert 形）
 *   rename    标题变更
 *   project   项目归属变更
 *   approval  人工审批进入 pending（payload 全量）
 *   decided   审批已由用户做出（approve / reject）—— 之后不再改写
 *   delete    会话删除（回放时丢弃，同样也允许 compact 时省空间）
 *   turn      一轮对话的完整事件流（user 消息 + events 数组）
 *
 * 约束：
 * - 运行中写入 fire-and-forget 自吞异常（历史持久化失败绝不能打断回答流）；
 * - journal 超过 JOURNAL_MAX_BYTES 时触发 compact：把当前状态全量快照重写，
 *   避免 delete/turn 历史无限增长；truncate 前旧内容轮转 .1 备份；
 * - 回放时坏行跳过并告警（NDJSON 单行损坏不影响其它行）；
 * - 会话数上限 SESSIONS_MAX，compact 时按 createdAt 保留最新的。
 *
 * 坑（T2-3）：审批状态机的一次性 —— approval→decided 只允许一次转移，
 * 回放时 resolved 状态以 joined decided行 为准，之后重复 approve 不再执行。
 */
import { readFile, writeFile, rename, appendFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const JOURNAL_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".setting", "sessions.ndjson");
/** journal 大小上限：超过触发 compact（按当前在内存的会话快照重写） */
const JOURNAL_MAX_BYTES = 2_000_000;
/** 回放/快照 时保留的会话数上限（超出按 createdAt 丢最旧） */
const SESSIONS_MAX = 300;

export interface ApprovalSnapshot {
  toolName: string;
  payload: unknown;
  status: "pending" | "approved" | "rejected";
}

export interface SessionRecord {
  id: string;
  kind: "agent" | "estate" | "demo" | "external";
  demo: 1 | 2 | 3 | 4 | null;
  agentId: string | null;
  projectId: string;
  title: string;
  createdAt: number;
  threadId: string;
  pendingApproval: ApprovalSnapshot | null;
  /** 累计轮数（由回放统计而来，新创建为 0） */
  turns: number;
  /** 回放出的对话轮（user + events），与 sessions.ts 的 TurnRecord 同形 */
  turnHistory: Array<{ user: string; files?: Array<{ name: string; source: string; image: boolean }>; events: unknown[] }>;
}

/** journal 内存视角（回放后的状态），也是 compact 的快照来源 */
const state = new Map<string, SessionRecord>();
let loaded = false;

// ---------------------------------------------------------------------------
// journal 写入（fire-and-forget）
// ---------------------------------------------------------------------------

async function appendJournal(line: unknown): Promise<void> {
  await appendFile(JOURNAL_FILE, JSON.stringify(line) + "\n", "utf8");
}

/** 所有写入都是后台任务：失败只告警，绝不向上抛（聊天流不能因此中断） */
function journalWrite(ev: Record<string, unknown>): void {
  void appendJournal(ev).catch((err) => {
    console.error("[session-store] journal 写入失败（服务重启后该轮可能丢失）：", err instanceof Error ? err.message : String(err));
  });
}

export function journalSession(rec: {
  id: string; kind: "agent" | "estate" | "demo" | "external"; demo: 1 | 2 | 3 | 4 | null;
  agentId: string | null; projectId: string; title: string; createdAt: number; threadId: string;
}): void {
  journalWrite({ ts: Date.now(), ev: "session", session: rec });
}

export function journalRename(id: string, title: string): void {
  journalWrite({ ts: Date.now(), ev: "rename", id, title });
}

export function journalProject(id: string, projectId: string): void {
  journalWrite({ ts: Date.now(), ev: "project", id, projectId });
}

export function journalDelete(id: string): void {
  journalWrite({ ts: Date.now(), ev: "delete", id });
}

export function journalApproval(id: string, toolName: string, payload: unknown): void {
  journalWrite({ ts: Date.now(), ev: "approval", id, toolName, payload });
}

export function journalDecided(id: string, status: "approved" | "rejected"): void {
  journalWrite({ ts: Date.now(), ev: "decided", id, status });
}

export function journalTurn(id: string, user: string, files: Array<{ name: string; source: string; image: boolean }> | undefined, events: unknown[]): void {
  journalWrite({ ts: Date.now(), ev: "turn", id, user, files, events });
}

// ---------------------------------------------------------------------------
// 回放 / compact
// ---------------------------------------------------------------------------

/** 启动时有一次调用；把 journal 变成内存 state */
export async function replaySessions(): Promise<void> {
  let raw = "";
  try {
    raw = await readFile(JOURNAL_FILE, "utf8");
    loaded = true;
  } catch {
    loaded = true; // 文件不存在 = 全新启动
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // 单行损坏：跳过并告警（NDJSON 语义允许）
      console.error("[session-store] journal 有一行损坏，已跳过（不影响其它行）");
      continue;
    }
    applyEvent(ev);
  }
  enforceCap();
}

function applyEvent(ev: Record<string, unknown>): void {
  const evName = ev.ev;
  if (evName === "session") {
    const s = ev.session as Partial<SessionRecord> | undefined;
    if (!s || typeof s.id !== "string") return;
    const base = findOrMake(s.id);
    Object.assign(base, {
      kind: s.kind ?? base.kind,
      demo: s.demo ?? null,
      agentId: s.agentId ?? null,
      projectId: s.projectId ?? "default",
      title: s.title ?? base.title,
      createdAt: typeof s.createdAt === "number" ? s.createdAt : base.createdAt,
      threadId: s.threadId ?? base.threadId,
    });
  } else if (evName === "rename") {
    const base = findOrMake(String(ev.id ?? ""));
    if (typeof ev.title === "string") base.title = ev.title;
  } else if (evName === "project") {
    const base = findOrMake(String(ev.id ?? ""));
    if (typeof ev.projectId === "string") base.projectId = ev.projectId;
  } else if (evName === "approval") {
    const base = findOrMake(String(ev.id ?? ""));
    base.pendingApproval = {
      toolName: typeof ev.toolName === "string" ? ev.toolName : "unknown",
      payload: ev.payload ?? null,
      status: "pending",
    };
  } else if (evName === "decided") {
    const base = state.get(String(ev.id ?? ""));
    if (base?.pendingApproval) {
      base.pendingApproval.status = ev.status === "approved" ? "approved" : "rejected";
    }
  } else if (evName === "delete") {
    state.delete(String(ev.id ?? ""));
  } else if (evName === "turn") {
    const id = String(ev.id ?? "");
    // 已被 delete 的会话不再记账
    if (!state.has(id)) return;
    const base = findOrMake(id);
    base.turns += 1;
    base.turnHistory.push({
      user: typeof ev.user === "string" ? ev.user : "",
      files: Array.isArray(ev.files) ? (ev.files as SessionRecord["turnHistory"][0]["files"]) : undefined,
      events: Array.isArray(ev.events) ? ev.events : [],
    });
  }
}

function findOrMake(id: string): SessionRecord {
  let rec = state.get(id);
  if (!rec) {
    rec = {
      id, kind: "agent", demo: null, agentId: null, projectId: "default",
      title: "", createdAt: Date.now(), threadId: "", pendingApproval: null, turns: 0, turnHistory: [],
    };
    state.set(id, rec);
  }
  return rec;
}

function enforceCap(): void {
  if (state.size <= SESSIONS_MAX) return;
  const entries = [...state.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const rec of entries.slice(0, state.size - SESSIONS_MAX)) state.delete(rec.id);
}

export function journalSnapshot(): SessionRecord[] {
  return [...state.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** compact：快照重写 journal（rotating 老文件为 .1） */
async function compactJournal(): Promise<void> {
  const snapshot = journalSnapshot();
  const lines: string[] = [];
  for (const rec of snapshot) {
    lines.push(JSON.stringify({ ts: rec.createdAt, ev: "session", session: { id: rec.id, kind: rec.kind, demo: rec.demo, agentId: rec.agentId, projectId: rec.projectId, title: rec.title, createdAt: rec.createdAt, threadId: rec.threadId } }));
    if (rec.pendingApproval && rec.pendingApproval.status === "pending") {
      lines.push(JSON.stringify({ ts: rec.createdAt, ev: "approval", id: rec.id, toolName: rec.pendingApproval.toolName, payload: rec.pendingApproval.payload }));
    }
    for (const t of rec.turnHistory) {
      lines.push(JSON.stringify({ ts: Date.now(), ev: "turn", id: rec.id, user: t.user, files: t.files, events: t.events }));
    }
  }
  const body = lines.join("\n") + "\n";
  try {
    await rename(JOURNAL_FILE, JOURNAL_FILE + ".1").catch(() => {});
    await writeFile(JOURNAL_FILE, body, "utf8");
  } catch (err) {
    console.error("[session-store] journal compact 失败（继续用追加模式）:", err instanceof Error ? err.message : String(err));
  }
}

/** 定期探 compact 时机：超过阈值触发（被 sessions.ts 调用） */
export async function maybeCompactJournal(): Promise<void> {
  try {
    const s = await stat(JOURNAL_FILE);
    if (s.size > JOURNAL_MAX_BYTES) await compactJournal();
  } catch { /* 无文件时静默 */ }
}

/** journal 文件路径（测试/健康检查用） */
export function journalPath(): string { return JOURNAL_FILE; }

export function journalLoaded(): boolean { return loaded; }
