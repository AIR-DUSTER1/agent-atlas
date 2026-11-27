/**
 * routes/estate.ts — 房产 Agent（贝壳 CLI）路由：状态 / 安装 / 系统浏览器登录 / 保存 Key
 * ============================================================
 * getEstatePublic 会真正探测一次 beike --version（毫秒级），必须 await 再回 200；
 * CLI 安装是分钟级任务：POST 只启动后台任务并返回 202，GET /api/estate/install 轮询状态。
 */
import { parsedJsonOf, respondBadRequest, BodyTooLargeError } from "../http-body.js";
import { getEstatePublic, installBeike, saveBeikeKey, startBeikeLogin } from "../estate.js";
import { createBeikeInstallCoordinator } from "../estate-install-job.js";
import { readEstateExport } from "../estate-workbook.js";

const beikeInstall = createBeikeInstallCoordinator(installBeike);

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function handleGetEstate(res: import("node:http").ServerResponse): Promise<void> {
  try {
    sendJson(res, 200, { ...(await getEstatePublic()), install: beikeInstall.get() });
  } catch (err) {
    sendJson(res, 200, {
      installed: false,
      error: err instanceof Error ? err.message : String(err),
      install: beikeInstall.get(),
    });
  }
}

/** GET /api/estate/install —— 只读轮询后台安装状态，不再持有长请求。 */
export function handleGetBeikeInstall(res: import("node:http").ServerResponse): void {
  sendJson(res, 200, { ok: true, install: beikeInstall.get() });
}

/** POST /api/estate/install —— 启动后台安装并立即返回，避免反向代理 504。 */
export function handleStartBeikeInstall(res: import("node:http").ServerResponse): void {
  const job = beikeInstall.start();
  sendJson(res, 202, { ok: true, install: job });
}

export async function handleSaveBeikeKey(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): Promise<void> {
  const body = parsedJsonOf<{ apiKey?: unknown }>(req)!;
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

/** 在系统默认浏览器打开官方登录页；扫码和复制 Key 均由用户手动完成。 */
export async function handleStartBeikeLogin(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  try {
    sendJson(res, 200, await startBeikeLogin());
  } catch (err) {
    if (err instanceof BodyTooLargeError) { respondBadRequest(res, req, err); return; }
    sendJson(res, 500, { ok: false, url: "", opened: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** GET /api/estate/exports/:id —— 下载候选对比 Excel；只接受 UUID，路径由服务端固定拼接。 */
export async function handleEstateExport(
  res: import("node:http").ServerResponse,
  id: string,
): Promise<void> {
  const file = await readEstateExport(id);
  if (!file) {
    sendJson(res, 404, { error: "Excel 对比文件不存在或已清理，请重新生成" });
    return;
  }
  const asciiName = `estate-comparison-${id.slice(0, 8)}.xlsx`;
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Length": file.data.length,
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
  });
  res.end(file.data);
}
