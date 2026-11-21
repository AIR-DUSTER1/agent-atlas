/**
 * ============================================================
 * already-sent.ts — raw 直写响应的适配器标记（框架迁移 M1/M2 共用）
 * ============================================================
 * 门禁 / 错误映射直接写原生 ServerResponse 时，返回带本头的 Response，
 * @hono/node-server 看到它就不再向 outgoing 写任何字节（该版本没有
 * RESPONSE_ALREADY_SENT 导出，这是唯一合法的 raw 直写逃生口）。
 */
export const ALREADY_SENT = "x-hono-already-sent";

/** 构造「响应已直写」标记；中间件与路由共用。 */
export function alreadySent(): Response {
  return new Response(null, { headers: { [ALREADY_SENT]: "true" } });
}
