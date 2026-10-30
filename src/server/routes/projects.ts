/**
 * routes/projects.ts — 项目文件夹路由（列表 / 添加 / 切换 / 删除 / 云端刷新）
 * ============================================================
 * 删除项目时同时把该项目下的会话挪回 default（moveSessions 动态 import 已收敛为顶层）。
 */
import { readBody, respondBadRequest } from "../http-body.js";
import { listProjects, getActiveProjectId, setActiveProject, addProject, deleteProject, refreshCloudProject } from "../projects.js";
import { moveSessions } from "../sessions.js";
import { writeAudit } from "../audit.js";
import { DirectoryPickerBusyError, pickDirectory } from "../directory-picker.js";

export async function handleListProjects(res: import("node:http").ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ projects: listProjects(), activeProjectId: getActiveProjectId() }));
}

/** 打开本机系统目录选择框；仅允许本机页面触发，返回用户亲自选择的绝对路径。 */
function isLoopbackRequest(req: import("node:http").IncomingMessage): boolean {
  const address = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1";
}
export async function handlePickProjectDirectory(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  try {
    if (!isLoopbackRequest(req)) throw new Error("系统目录选择框只能从本机页面启动，请手动输入服务器绝对路径");
    const result = await pickDirectory();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
  } catch (err) {
    if (err instanceof DirectoryPickerBusyError) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message, code: err.code }));
      return;
    }
    respondBadRequest(res, req, err);
  }
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
