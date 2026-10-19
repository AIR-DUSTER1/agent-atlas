/**
 * ============================================================
 * http-guard.ts — CSRF / Origin 防护 + 基础安全响应头（Phase 1 T1-2）
 * ============================================================
 * 职责：mutating 请求（非 GET/HEAD）必须通过「同源」检验：浏览器自动附带
 * Origin / Sec-Fetch-Site，伪造不了；恶意网页跨站 POST（哪怕 text/plain
 * 简单请求）在第二道就 403。非浏览器客户端（curl / 脚本）不带 Origin，
 * 由 auth.ts 的 Bearer 托底 —— 两层合起来：跨站变更不可行。
 *
 * 设计立场：
 *  - 不引入 CSRF token：同源校验 + Bearer 已覆盖该面（计划规则 4 的
 *    「same-origin 或 bearer」满足其或分支），避免给零依赖前端再加一套令牌流转；
 *  - 安全响应头一次性 setHeader（writeHead 会合并继承），对 HTML 也有 CSP；
 *  - OSM 地图 iframe 是唯一外部 frame 源，frame-src 白名单放行官方域名；
 *  - index.html 首屏主题切换是内联脚本，故 script-src 需要 'unsafe-inline'
 *    （本前端零构建的代价，接受；敏感操作都在 API 层另有认证/同源防线）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { UNAUTHORIZED_MSG } from "./auth.js";

/** GET/HEAD 属幂等只读，不做同源检验（页面加载/静态资源/GET API） */
function isIdempotent(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

/** 计算请求「应当来自」的合法 Origin：以 Host 头重建（服务端只关心自己对外地址） */
function expectedOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? "";
  const forwardedProto = req.headers["x-forwarded-proto"];
  // 仅信任首个 X-Forwarded-Proto（反代部署时 HTTPS 终止在前），否则按明文 HTTP
  const proto = typeof forwardedProto === "string" && forwardedProto.includes("https") ? "https" : "http";
  return `${proto}://${host}`;
}

/**
 * 同源防护判定：返回 null = 放行；返回 string = 拒绝原因（面向用户中文）。
 * 规则（依次判断）：
 *  1. 幂等方法放行；
 *  2. `Sec-Fetch-Site: cross-site` → 拒（无 Origin 的跨站表单也有这个头，ie 旧版除外）；
 *  3. 带 Origin 且 ≠ 期望源 → 拒（篡改同源请求的伪 Origin 关不掉 Sec-Fetch-Site）；
 *  4. 无 Sec-Fetch-Site 且无 Origin → 非浏览器客户端（curl/脚本/工具），放行，
 *     交给 Bearer 认证层区分合法与非法（纯本地学习模式下由 Phase 0 读性边界兜底）。
 */
export function checkSameOrigin(req: IncomingMessage): string | null {
  if (isIdempotent(req.method)) return null;
  const fetchSite = req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && /^cross-site$/i.test(fetchSite.trim())) {
    return "拒绝跨站请求：该操作必须从工作台页面自身发起";
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin && origin !== "null" && origin !== expectedOrigin(req)) {
    return "拒绝跨源请求：Origin 与服务地址不一致（如从其它网页/代理发起）";
  }
  return null;
}

/** 安全响应头的「值集合」集中在常量，便于 README/wiki 对照与 Electron 调整 */
export const SECURITY_HEADERS: Record<string, string> = {
  // 防响应被嗅探改道执行（借 XSS 面）
  "X-Content-Type-Options": "nosniff",
  // 页面跳转外站不带引用（避免内部地址/会话 id 泄露）
  "Referrer-Policy": "no-referrer",
  // 禁止被嵌入他人页面的 iframe（点击劫持）
  "X-Frame-Options": "DENY",
  // 内容来源白名单：地图 iframe 白名单放 OSM 官方域；inline 为首屏主题脚本妥协
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' https: data:; connect-src 'self'; frame-src https://www.openstreetmap.org; " +
    "base-uri 'self'; form-action 'none'",
};

/** 一次性把安全头挂到响应上（后续 writeHead 字段会与之合并，不冲突即继承） */
export function applySecurityHeaders(res: ServerResponse): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
}

/** 判断请求是否携带 body（GET 无体时绝不能触发 destroy —— 会在响应 flush 前造成 RST） */
function requestHasBody(req: IncomingMessage): boolean {
  const te = req.headers["transfer-encoding"];
  const cl = Number(req.headers["content-length"] ?? 0);
  return (typeof te === "string" && te.toLowerCase().includes("chunked")) ||
    (Number.isFinite(cl) && cl > 0);
}

/**
 * 丢弃式读掉未处理的请求体：认证/同源层常在 readBody 之前拒绝，
 * 若客户端还有 body 未发完，带着 unread-data 关闭 socket 会触发 RST，
 * 可能把已经写出的 401/403 一起冲掉（同 413 排水同理）。
 * 关键时序：挂在 res 的 flush 完成之后才启动排水——若空跑（GET 无体）直接
 * destroy 会在响应冲出去之前把连接 reset（实测 GET 带 401 直接 ECONNRESET）。
 */
const RESPONSE_BODY_DRAIN_CAP = 8_000_000; // 追加排水上限（攻击性客户端兜底）

export function shedRequestBodyAfterResponse(req: IncomingMessage, res: ServerResponse): void {
  if (!requestHasBody(req)) return; // 无 body：Connection: close 即可干净收尾，不需要排水
  res.on("finish", () => {
    let drained = 0;
    req.on("data", (c: Buffer) => {
      drained += c.length;
      if (drained > RESPONSE_BODY_DRAIN_CAP) req.socket?.destroy();
    });
    req.on("end", () => req.socket?.destroy());
    req.on("error", () => req.socket?.destroy());
    req.resume();
  });
}

/** 401 统一响应：先挂排水再写头；文案不泄露校验细节 */
export function respondUnauthorized(req: IncomingMessage, res: ServerResponse): void {
  shedRequestBodyAfterResponse(req, res);
  res.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8",
    Connection: "close",
  });
  res.end(JSON.stringify({ error: UNAUTHORIZED_MSG, authRequired: true }));
}

/** 403 拒绝响应（同源/开放无认证共享）：说明哪一环没对上 */
export function respondForbidden(
  req: IncomingMessage,
  res: ServerResponse,
  reason: string,
  authRequired = false,
): void {
  shedRequestBodyAfterResponse(req, res);
  res.writeHead(403, {
    "Content-Type": "application/json; charset=utf-8",
    Connection: "close",
  });
  res.end(JSON.stringify({ error: reason, authRequired }));
}
