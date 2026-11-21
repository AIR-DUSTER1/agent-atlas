/**
 * ============================================================
 * validation.ts — 请求体 schema 校验（框架迁移 M2）
 * ============================================================
 * 设计立场：zValidator 的 json 目标走 hono 的 `c.req.json()`，**没有体积上限**，
 * 直接用会把 readBody 的 2MB 防线（BodyTooLargeError → 413 + 排水断开）静默绕过。
 * 所以 M2 的路由校验用本模块的 `jsonBody(schema)`：仍从原生 incoming 读体
 * （413 / SyntaxError 两条错误路径与平移前逐字一致），再用 zod safeParse。
 * API 形状对齐 zValidator（schema 声明在路由上），hono 侧支持流式限额后可机械替换。
 *
 * 坏 JSON（SyntaxError）不在本模块拦截：向上抛给 app.onError → 400
 * 「请求体不是合法的 JSON」，与平移前 handler 里的 JSON.parse 行为一致。
 */
import type { Context } from "hono";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ZodType } from "zod";
import { BODY_MAX_BYTES, readBody, BodyTooLargeError } from "./http-body.js";
import { ALREADY_SENT } from "./already-sent.js";

export interface JsonBodyOptions {
  /** 坏 JSON 以外的校验失败提示；默认取第一条 zod issue 的中文消息 */
  message?: string;
}

/** 从上下文取 jsonBody 中间件解析后的请求体（未经过 jsonBody 的路由返回 undefined）。 */
export function jsonBodyOf<T>(c: Context): T | undefined {
  return c.get("jsonBody") as T | undefined;
}

/**
 * JSON 请求体校验中间件：readBody（2MB 上限 + 排水）→ JSON.parse → zod safeParse。
 * 校验失败直接 400（中文契约），成功后把解析值放进 c.get("jsonBody")。
 */
export function jsonBody<T>(schema: ZodType<T>, options: JsonBodyOptions = {}) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | undefined> => {
    const req = c.env.incoming as IncomingMessage;
    const res = c.env.outgoing as ServerResponse;
    const raw = await readBody(req);
    const parsed: unknown = JSON.parse(raw || "{}");
    const result = schema.safeParseAsync(parsed);
    const checked = await result;
    if (!checked.success) {
      const issue = options.message ?? checked.error.issues[0]?.message ?? "请求参数不合法";
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: issue }));
      return new Response(null, { headers: { [ALREADY_SENT]: "true" } });
    }
    c.set("jsonBody", checked.data);
    await next();
    return undefined;
  };
}

/** readBody 的体积上限重导出：调用方按路由覆盖（文件上传 12MB 白名单另行处理）。 */
export { BODY_MAX_BYTES };
