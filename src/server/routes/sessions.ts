/**
 * routes/sessions.ts — 会话列表 / 新建 / 删除 / 对话记录回放路由
 * ============================================================
 * 新建会话语义：{ kind: "agent" }（默认）/ { kind: "demo", demo: 1-4 }
 * / { kind: "external", agentId } / { kind: "estate" }；兼容旧 { demo: N }。
 */
import { readBody, respondBadRequest } from "../http-body.js";
import { createSession, deleteSession, getSession, isDemo, listSessions, getTurnHistory } from "../sessions.js";
import { getActiveProjectId } from "../projects.js";
import { compactSession } from "../compaction.js";

export async function handleSessions(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(listSessions().map((s) => ({
      id: s.id, kind: s.kind, agentProfileId: s.agentProfileId, demo: s.demo, agentId: s.agentId, projectId: s.projectId, title: s.title, createdAt: s.createdAt,
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
