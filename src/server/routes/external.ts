/**
 * routes/external.ts — 外部 Agent 接入路由（列表 / 接入 / 更新 / 删除）
 * ============================================================
 * 高危变更全部走 audit（external.* 在 external.ts 内落审计），本路由只管回包。
 */
import { readBody, respondBadRequest } from "../http-body.js";
import { listExternalAgents, addExternalAgent, updateExternalAgent, deleteExternalAgent } from "../external.js";

export async function handleListExternalAgents(res: import("node:http").ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ agents: listExternalAgents() }));
}

export async function handleAddExternalAgent(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as {
    url?: string; name?: string; command?: string; args?: unknown; passCredentials?: unknown;
  };
  try {
    const r = await addExternalAgent(body);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...r, agents: listExternalAgents() }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleUpdateExternalAgent(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage, id: string): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as {
    name?: string; command?: string; args?: unknown; passCredentials?: unknown;
  };
  try {
    const agent = await updateExternalAgent(id, body);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, agent }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleDeleteExternalAgent(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage, id: string): Promise<void> {
  try {
    await deleteExternalAgent(id);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, agents: listExternalAgents() }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}
