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
 *   permission 会话权限模式变更（readonly / approve / autonomous / auto）
 *   approval  人工审批 / 需求澄清进入 pending（payload 全量）
 *   decided   用户已做出决定（approve / reject / answered）—— 之后不再改写
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
 * 坑（T2-3）：审批/澄清状态机的一次性 —— approval→decided 只允许一次转移，
 * 回放时 resolved 状态以 joined decided行 为准，之后重复 approve 不再执行。
 */
import { readFile, writeFile, rename, appendFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { profileIdForKind, type AgentProfileId } from "../agent/profile.js";
import { isPermissionMode, type PermissionMode } from "../agent/permission.js";
import { log } from "./logging.js";

// 测试钩子：e2e 用临时 journal（tests/helpers 注入 SESSIONS_FILE），
// 避免跑测试把假会话写进开发者真实的 .setting/sessions.ndjson。
// 用函数而非常量：resetJournalStore 换 env 后要能重新绑定文件。
function resolveJournalFile(): string {
  return process.env.SESSIONS_FILE
    || join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".setting", "sessions.ndjson");
}
let JOURNAL_FILE = resolveJournalFile();
/** journal 大小上限：超过触发 compact（按当前在内存的会话快照重写） */
const JOURNAL_MAX_BYTES = 2_000_000;
/** 回放/快照 时保留的会话数上限（超出按 createdAt 丢最旧） */
const SESSIONS_MAX = 300;

export interface ApprovalSnapshot {
  toolName: string;
  payload: unknown;
  status: "pending" | "approved" | "rejected" | "answered";
}

export interface SessionRecord {
  id: string;
  kind: SessionKind;
  /** 旧 journal 可能没有该字段；回放时按 kind 派生 */
  agentProfileId: AgentProfileId | null;
  demo: 1 | 2 | 3 | 4 | null;
  agentId: string | null;
  projectId: string;
  title: string;
  createdAt: number;
  threadId: string;
  pendingApproval: ApprovalSnapshot | null;
  /** 会话权限模式；旧 journal 没有该字段时按默认 approve 处理 */
  permissionMode?: PermissionMode;
  /** 累计轮数（由回放统计而来，新创建为 0） */
  turns: number;
  /** 回放出的对话轮（user + events），与 sessions.ts 的 TurnRecord 同形 */
  turnHistory: Array<{
    turnId?: string;
    agentProfileId?: AgentProfileId | null;
    user: string;
    /** 审批 / 澄清恢复记录：前端回放时并入上一助手块，不新起头像。 */
    continuation?: boolean;
    files?: Array<{ name: string; source: string; image: boolean }>;
    events: unknown[];
    startedAt?: number;
    finishedAt?: number;
    durationMs?: number;
  }>;
}

export type SessionKind = "agent" | "estate" | "demo" | "external";

function isSessionKind(value: unknown): value is SessionKind {
  return value === "agent" || value === "estate" || value === "demo" || value === "external";
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

/** 在途写入集合：优雅退出前用 flushJournal() 等它们落盘 */
const pendingWrites = new Set<Promise<void>>();

/** 所有写入都是后台任务：失败只告警，绝不向上抛（聊天流不能因此中断） */
function journalWrite(ev: Record<string, unknown>): void {
  let task: Promise<void>;
  task = appendJournal(ev)
    .catch((err) => {
      log("error", "journal_write_failed", { message: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => pendingWrites.delete(task));
  pendingWrites.add(task);
}

/**
 * 等待 journal 待写队列清空（Phase 4 优雅退出用）。
 * 循环等待：flush 期间还可能产生新写入（例如 close 事件里的 turn 落盘）。
 */
export async function flushJournal(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }
}

export function journalSession(rec: {
  id: string; kind: SessionKind;
  demo: 1 | 2 | 3 | 4 | null;
  agentId: string | null; projectId: string; title: string; createdAt: number; threadId: string;
  permissionMode?: PermissionMode;
}): void {
  // profile identity 只由服务端从 kind 派生，不接受调用方注入。
  journalWrite({
    ts: Date.now(),
    ev: "session",
    session: { ...rec, agentProfileId: profileIdForKind(rec.kind) },
  });
}

export function journalRename(id: string, title: string): void {
  journalWrite({ ts: Date.now(), ev: "rename", id, title });
}

export function journalProject(id: string, projectId: string): void {
  journalWrite({ ts: Date.now(), ev: "project", id, projectId });
}

export function journalPermission(id: string, permissionMode: PermissionMode): void {
  journalWrite({ ts: Date.now(), ev: "permission", id, permissionMode });
}

export function journalDelete(id: string): void {
  journalWrite({ ts: Date.now(), ev: "delete", id });
}

export function journalApproval(id: string, toolName: string, payload: unknown): void {
  journalWrite({ ts: Date.now(), ev: "approval", id, toolName, payload });
}

export function journalDecided(id: string, status: "approved" | "rejected" | "answered"): void {
  journalWrite({ ts: Date.now(), ev: "decided", id, status });
}

export function journalTurn(
  id: string,
  kind: SessionKind,
  turnId: string,
  startedAt: number,
  durationMs: number,
  user: string,
  files: Array<{ name: string; source: string; image: boolean }> | undefined,
  events: unknown[],
  continuation?: boolean
): void {
  // 轮次身份同样由 kind 派生，避免 journal 中的伪造字段把执行域改到另一个 Agent。
  journalWrite({
    ts: Date.now(),
    ev: "turn",
    id,
    turnId,
    agentProfileId: profileIdForKind(kind),
    startedAt,
    finishedAt: startedAt + durationMs,
    durationMs,
    user,
    ...(continuation ? { continuation: true } : {}),
    files,
    events,
  });
}

// ---------------------------------------------------------------------------
// 回放 / compact
// ---------------------------------------------------------------------------

/** 测试专用：丢弃内存回放态并重读 SESSIONS_FILE，让下一个用例能换 journal 重新回放 */
export function resetJournalStore(): void {
  state.clear();
  loaded = false;
  JOURNAL_FILE = resolveJournalFile();
}

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
      log("warn", "journal_bad_line", { action: "skipped" });
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
    if (s.kind !== undefined && !isSessionKind(s.kind)) {
      log("warn", "journal_bad_session_kind", { action: "skipped" });
      return;
    }
    const base = findOrMake(s.id);
    const kind = isSessionKind(s.kind) ? s.kind : base.kind;
    Object.assign(base, {
      kind,
      // 不接受 journal 自报 profile；kind 是唯一权威，避免跨域身份伪造。
      agentProfileId: profileIdForKind(kind),
      demo: s.demo ?? null,
      agentId: s.agentId ?? null,
      projectId: s.projectId ?? "default",
      title: s.title ?? base.title,
      createdAt: typeof s.createdAt === "number" ? s.createdAt : base.createdAt,
      threadId: s.threadId ?? base.threadId,
      permissionMode: isPermissionMode(s.permissionMode) ? s.permissionMode : "approve",
    });
  } else if (evName === "rename") {
    const base = findOrMake(String(ev.id ?? ""));
    if (typeof ev.title === "string") base.title = ev.title;
  } else if (evName === "project") {
    const base = findOrMake(String(ev.id ?? ""));
    if (typeof ev.projectId === "string") base.projectId = ev.projectId;
  } else if (evName === "permission") {
    const base = findOrMake(String(ev.id ?? ""));
    if (isPermissionMode(ev.permissionMode)) base.permissionMode = ev.permissionMode;
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
      base.pendingApproval.status =
        ev.status === "approved" ? "approved" : ev.status === "rejected" ? "rejected" : "answered";
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
      turnId: typeof ev.turnId === "string" ? ev.turnId : undefined,
      agentProfileId: profileIdForKind(base.kind),
      user: typeof ev.user === "string" ? ev.user : "",
      continuation: ev.continuation === true,
      files: Array.isArray(ev.files) ? (ev.files as SessionRecord["turnHistory"][0]["files"]) : undefined,
      events: Array.isArray(ev.events) ? ev.events : [],
      startedAt: typeof ev.startedAt === "number" ? ev.startedAt : undefined,
      finishedAt: typeof ev.finishedAt === "number" ? ev.finishedAt : undefined,
      durationMs: typeof ev.durationMs === "number" ? ev.durationMs : undefined,
    });
  }
}

function findOrMake(id: string): SessionRecord {
  let rec = state.get(id);
  if (!rec) {
    rec = {
      id, kind: "agent", agentProfileId: null, demo: null, agentId: null, projectId: "default",
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
    lines.push(JSON.stringify({ ts: rec.createdAt, ev: "session", session: { id: rec.id, kind: rec.kind, agentProfileId: rec.agentProfileId, demo: rec.demo, agentId: rec.agentId, projectId: rec.projectId, title: rec.title, createdAt: rec.createdAt, threadId: rec.threadId, permissionMode: rec.permissionMode ?? "approve" } }));
    if (rec.pendingApproval && rec.pendingApproval.status === "pending") {
      lines.push(JSON.stringify({ ts: rec.createdAt, ev: "approval", id: rec.id, toolName: rec.pendingApproval.toolName, payload: rec.pendingApproval.payload }));
    }
    for (const t of rec.turnHistory) {
      lines.push(JSON.stringify({
        ts: Date.now(), ev: "turn", id: rec.id, turnId: t.turnId,
        user: t.user, ...(t.continuation ? { continuation: true } : {}),
        files: t.files, events: t.events,
        agentProfileId: t.agentProfileId ?? rec.agentProfileId,
        startedAt: t.startedAt, finishedAt: t.finishedAt, durationMs: t.durationMs,
      }));
    }
  }
  const body = lines.join("\n") + "\n";
  try {
    await rename(JOURNAL_FILE, JOURNAL_FILE + ".1").catch(() => {});
    await writeFile(JOURNAL_FILE, body, "utf8");
  } catch (err) {
    log("error", "journal_compact_failed", { message: err instanceof Error ? err.message : String(err) });
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
