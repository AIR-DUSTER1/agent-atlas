/**
 * routes/estate.ts — 房产 Agent（贝壳 CLI）路由：状态 / 安装 / 登录页 / 回调救援 / 保存 Key
 * ============================================================
 * getEstatePublic 会真正探测一次 beike --version（毫秒级），必须 await 再回 200；
 * installBeike 是几十秒级的下载解压，失败回 500。
 */
import { readBody, respondBadRequest, BodyTooLargeError } from "../http-body.js";
import { getEstatePublic, installBeike, recoverBeikeLogin, saveBeikeKey, startBeikeLogin } from "../estate.js";

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function handleGetEstate(res: import("node:http").ServerResponse): Promise<void> {
  try {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(await getEstatePublic()));
  } catch (err) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ installed: false, error: err instanceof Error ? err.message : String(err) }));
  }
}

export async function handleInstallBeike(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  await readBody(req); // 消费掉可能为空的请求体，参数无关紧要
  try {
    const status = await installBeike(); // 下载 ~32MB + 解压，可能要几十秒
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...status }));
  } catch (err) {
    if (err instanceof BodyTooLargeError) respondBadRequest(res, req, err);
    else {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }
}

export async function handleSaveBeikeKey(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { apiKey?: unknown };
  try {
    if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
      throw new Error("apiKey 不能为空：登录贝壳获取页面显示的完整凭证后粘贴");
    }
    // beike auth --save：Key 只进 CLI 本地凭证，agentatlas 不落盘不回显
    const r = await saveBeikeKey(body.apiKey);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    // 兼容旧前端读取 error 字段；新前端优先使用完整 message。
    res.end(JSON.stringify(r.ok ? r : { ...r, error: r.message }));
  } catch (err) {
    if (err instanceof BodyTooLargeError) respondBadRequest(res, req, err);
    else {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }
}

/** 官方 /auth/callback 404 时，用用户刚复制的完整回调地址完成换票并保存 Key。 */
export async function handleRecoverBeikeLogin(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as { callbackUrl?: unknown };
    if (typeof body.callbackUrl !== "string" || !body.callbackUrl.trim()) {
      throw new Error("callbackUrl 不能为空：请粘贴出现 Not Found 的完整地址");
    }
    const result = await recoverBeikeLogin(body.callbackUrl);
    sendJson(res, 200, result.ok ? result : { ...result, error: result.message });
  } catch (err) {
    if (err instanceof BodyTooLargeError) { respondBadRequest(res, req, err); return; }
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** 打开官方登录页；即使系统浏览器拉起失败也返回 URL，前端可提供手动入口。 */
export async function handleStartBeikeLogin(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  try {
    await readBody(req);
    sendJson(res, 200, await startBeikeLogin());
  } catch (err) {
    if (err instanceof BodyTooLargeError) { respondBadRequest(res, req, err); return; }
    sendJson(res, 500, { ok: false, url: "", opened: false, error: err instanceof Error ? err.message : String(err) });
  }
}
