/**
 * routes/estate.ts — 房产 Agent（贝壳 CLI）路由：状态 / 一键安装 / 保存授权 Key
 * ============================================================
 * getEstatePublic 会真正探测一次 beike --version（毫秒级），必须 await 再回 200；
 * installBeike 是几十秒级的下载解压，失败回 500。
 */
import { readBody, respondBadRequest, BodyTooLargeError } from "../http-body.js";
import { getEstatePublic, installBeike, saveBeikeKey } from "../estate.js";

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
    res.end(JSON.stringify(r));
  } catch (err) {
    if (err instanceof BodyTooLargeError) respondBadRequest(res, req, err);
    else {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }
}
