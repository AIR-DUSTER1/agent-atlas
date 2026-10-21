/**
 * routes/projects.ts — 项目文件夹路由（列表 / 添加 / 切换 / 删除 / 云端刷新）
 * ============================================================
 * 删除项目时同时把该项目下的会话挪回 default（moveSessions 动态 import 已收敛为顶层）。
 */
import { readBody, respondBadRequest } from "../http-body.js";
import { listProjects, getActiveProjectId, setActiveProject, addProject, deleteProject, refreshCloudProject } from "../projects.js";
import { moveSessions } from "../sessions.js";
import { writeAudit } from "../audit.js";

export async function handleListProjects(res: import("node:http").ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ projects: listProjects(), activeProjectId: getActiveProjectId() }));
}

export async function handleAddProject(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; type?: string; path?: string; url?: string };
  try {
    const project = await addProject(body);
    // 授权本地目录 / 云端仓库属于安全边界动作：只记 id 与类型，URL 可能含凭据
    writeAudit("project.authorized", { projectId: project.id, type: project.type });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, project, projects: listProjects(), activeProjectId: getActiveProjectId() }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleSetActiveProject(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { id?: string };
  try {
    setActiveProject(body.id ?? "");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, activeProjectId: getActiveProjectId() }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleDeleteProject(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage, id: string): Promise<void> {
  try {
    await deleteProject(id);
    const moved = moveSessions(id, "default");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, movedSessions: moved, projects: listProjects(), activeProjectId: getActiveProjectId() }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleRefreshProject(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage, id: string): Promise<void> {
  try {
    const p = await refreshCloudProject(id);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, project: p }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}
