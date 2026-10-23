/**
 * routes/files.ts — 文件上下文路由（目录浏览 / 文件读取 / 远程文件夹授权 / 本地上传）
 * ============================================================
 * 授权与内容安全都收敛在 files.ts 内（assertAuthorized / 二进制检测 / SKIPPED_DIRS）；
 * 上传单独放宽请求体到 12MB（图片走 dataURL，体积比文本大）。
 */
import { readBody, respondBadRequest } from "../http-body.js";
import { listDir, searchFiles, readFileAuthorized, openRemoteRoot, storeUpload } from "../files.js";
import { listProjects } from "../projects.js";

export async function handleFsList(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { path?: string };
  try {
    const data = await listDir(body.path);
    // roots 拼上项目信息：前端据此区分 本地💻 / 云端☁️ 样式
    const byPath = new Map(listProjects().map((p) => [p.path, p]));
    const roots = data.roots.map((r) => {
      const p = byPath.get(r.path);
      return { ...r, type: p?.type ?? "local", projectId: p?.id ?? null, url: p?.url };
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ...data, roots }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleFsSearch(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { query?: unknown };
  try {
    const data = await searchFiles(typeof body.query === "string" ? body.query : "");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleFsRead(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { path?: string };
  try {
    const data = await readFileAuthorized(body.path ?? "");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleFsOpenRemote(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { path?: string };
  try {
    const data = await openRemoteRoot(body.path ?? "");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...data }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleUpload(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  // 图片走 dataURL，体积比文本大 → 单独放宽请求体上限
  const body = JSON.parse((await readBody(req, 12_000_000)) || "{}") as {
    name?: unknown; content?: unknown; image?: unknown;
  };
  try {
    if (typeof body.name !== "string" || typeof body.content !== "string") {
      throw new Error("参数不完整（name / content）");
    }
    const data = storeUpload(body.name, body.content, body.image === true);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...data }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}
