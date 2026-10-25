/**
 * routes/sessions.ts — 会话列表 / 新建 / 删除 / 对话记录回放路由
 * ============================================================
 * 新建会话语义：{ kind: "agent" }（默认）/ { kind: "demo", demo: 1-4 }
 * / { kind: "external", agentId } / { kind: "estate" }；兼容旧 { demo: N }。
 */
import { readBody, respondBadRequest } from "../http-body.js";
import { createSession, deleteSession, getSession, isDemo, listSessions, getTurnHistory, updatePermissionMode, type Session, type TurnRecord } from "../sessions.js";
import { getActiveProjectId } from "../projects.js";
import { compactSession } from "../compaction.js";
import { isPermissionMode, PERMISSION_MODES } from "../../agent/permission.js";
import { writeAudit } from "../audit.js";

export async function handleSessions(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(listSessions().map((s) => ({
      id: s.id, kind: s.kind, agentProfileId: s.agentProfileId, demo: s.demo, agentId: s.agentId, projectId: s.projectId, title: s.title, createdAt: s.createdAt,
      permissionMode: s.permissionMode,
      pendingApproval: Boolean(s.pendingApproval),
    }))));
    return;
  }
  if (req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}") as { kind?: unknown; demo?: unknown; projectId?: unknown; title?: string; agentId?: unknown };
    // 新逻辑：{ kind: "agent" }（默认）/ { kind: "demo", demo: 1-4 } / { kind: "external", agentId }
    //         / { kind: "estate" }（房产 Agent，贝壳工具集）
    // 兼容旧调用：只传 { demo: N } 视为示例会话
    const kind = body.kind === "demo" || body.kind === "external" || body.kind === "estate" || (!body.kind && isDemo(body.demo))
      ? (body.kind as "demo" | "external" | "estate")
      : "agent";
    const demo = isDemo(body.demo) ? body.demo : null;
    if (kind === "demo" && !demo) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "示例会话需要 demo: 1-4" }));
      return;
    }
    const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : getActiveProjectId();
    try {
      const session = createSession(kind, demo, projectId, body.title, typeof body.agentId === "string" ? body.agentId : null);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ id: session.id, kind: session.kind, agentProfileId: session.agentProfileId, demo: session.demo, agentId: session.agentId, projectId: session.projectId, title: session.title, createdAt: session.createdAt }));
    } catch (err) {
      respondBadRequest(res, req, err);
    }
    return;
  }
}

export async function handleDeleteSession(res: import("node:http").ServerResponse, id: string): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: deleteSession(id) }));
}

/** POST /api/sessions/:id/compact —— 压缩当前会话上下文（模型摘要 + 重建线程） */
export async function handleCompactSession(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage, id: string): Promise<void> {
  const session = getSession(id);
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "会话不存在或服务已重启" }));
    return;
  }
  try {
    const data = await compactSession(session);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...data }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

/** GET /api/sessions/:id/transcript —— 历史轮次回放（本地浏览器无该会话缓存时前端拉取重放） */
export async function handleTranscript(res: import("node:http").ServerResponse, id: string): Promise<void> {
  const session = getSession(id);
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "会话不存在或服务已重启" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ records: getTurnHistory(session), pendingApproval: Boolean(session.pendingApproval) }));
}

/** POST /api/sessions/:id/permission —— 切换会话权限模式（只读 / 审批 / 自动）
 *  安全边界动作：audit 记会话与模式，不落用户输入之外的敏感内容。 */
export async function handleSessionPermission(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage,
  id: string
): Promise<void> {
  const session = getSession(id);
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "会话不存在或服务已重启" }));
    return;
  }
  const body = JSON.parse((await readBody(req)) || "{}") as { mode?: unknown };
  if (!isPermissionMode(body.mode)) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: `mode 必须是 ${PERMISSION_MODES.join(" / ")} 之一` }));
    return;
  }
  updatePermissionMode(session, body.mode);
  writeAudit("permission.changed", { sessionId: session.id, mode: body.mode });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, permissionMode: session.permissionMode }));
}

// ---------------------------------------------------------------------------
// F3 归档：导出 Markdown / 批量清理
// ---------------------------------------------------------------------------

const EXPORT_TOOL_RESULT_CHARS = 300; // 导出里单条工具结果的字符上限
const EXPORT_FILENAME_MAX = 40;       // 导出文件名里标题的最大长度

/** 单轮转 Markdown：用户原话 + 助手回答（token/ai_message 拼接）+ 工具调用摘要 */
function turnToMarkdown(record: TurnRecord): string {
  const lines: string[] = [];
  const time = new Date(record.startedAt).toLocaleString("zh-CN");
  lines.push(`### 🧑 用户 · ${time}`);
  lines.push("");
  lines.push(record.user || "（空消息）");
  lines.push("");
  // 工具调用摘要：按事件顺序配对（tool_call → 运行中，tool_result 填结果）
  const toolNames = new Map<string, string>();
  for (const ev of record.events) {
    if (ev.type === "tool_call" && ev.name) toolNames.set(ev.id, ev.name);
    if (ev.type === "tool_result") {
      const name = toolNames.get(ev.id) ?? "工具";
      const brief = String(ev.content ?? "").slice(0, EXPORT_TOOL_RESULT_CHARS);
      lines.push(`> 🔧 \`${name}\`：${brief}${String(ev.content ?? "").length > EXPORT_TOOL_RESULT_CHARS ? "…" : ""}`);
    }
  }
  const ai = record.events
    .filter((ev) => ev.type === "token")
    .map((ev) => (ev as { text: string }).text)
    .join("");
  const fallback = record.events
    .filter((ev) => ev.type === "ai_message")
    .map((ev) => (ev as { content: string }).content)
    .join("\n\n");
  const answer = (ai || fallback).trim();
  if (answer) {
    lines.push("");
    lines.push("### 🤖 助手");
    lines.push("");
    lines.push(answer);
  }
  return lines.join("\n");
}

/** GET /api/sessions/:id/export —— 导出为 Markdown 附件（任何编辑器可读） */
export async function handleExportSession(
  res: import("node:http").ServerResponse,
  id: string
): Promise<void> {
  const session = getSession(id);
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "会话不存在或服务已重启" }));
    return;
  }
  const records = getTurnHistory(session);
  const created = new Date(session.createdAt).toLocaleString("zh-CN");
  const header = [
    `# ${session.title}`,
    "",
    `- 类型：${session.kind}${session.demo ? `（示例 ${session.demo}）` : ""}`,
    `- 创建时间：${created}`,
    `- 对话轮数：${records.length}`,
    `- 权限模式：${session.permissionMode}`,
    "",
    "---",
    "",
  ].join("\n");
  const body = records.map(turnToMarkdown).join("\n\n---\n\n") || "_（该会话还没有对话记录）_";
  const markdown = header + body + "\n";

  // 文件名：中文走 RFC 5987（filename*=UTF-8''…），ASCII 兜底
  const safeTitle = session.title.replace(/[\\/:*?"<>|\r\n]/g, " ").trim().slice(0, EXPORT_FILENAME_MAX) || "会话";
  const asciiName = `session-${session.id.slice(0, 8)}.md`;
  res.writeHead(200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(`${safeTitle}.md`)}`,
  });
  res.end(markdown);
}

const CLEANUP_MIN_DAYS = 1;
const CLEANUP_MAX_DAYS = 365;

/** POST /api/sessions/cleanup {daysBefore} —— 批量清理创建超过 N 天的会话。
 *  删除走 deleteSession（journal 落 delete 行 + 持久检查点线程同步清理）；
 *  audit 记条数与天数，不记会话内容。 */
export async function handleCleanupSessions(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { daysBefore?: unknown };
  const days = typeof body.daysBefore === "number" ? Math.floor(body.daysBefore) : NaN;
  if (!Number.isFinite(days) || days < CLEANUP_MIN_DAYS || days > CLEANUP_MAX_DAYS) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: `daysBefore 必须是 ${CLEANUP_MIN_DAYS}-${CLEANUP_MAX_DAYS} 之间的整数（天）` }));
    return;
  }
  const cutoff = Date.now() - days * 86_400_000;
  const victims: Session[] = listSessions().filter((s) => s.createdAt < cutoff);
  for (const s of victims) deleteSession(s.id);
  writeAudit("sessions.cleanup", { daysBefore: days, removed: victims.length });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, removed: victims.length, daysBefore: days }));
}
