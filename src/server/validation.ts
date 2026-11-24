/**
 * ============================================================
 * validation.ts — 请求体 schema 校验（框架迁移 M2）
 * ============================================================
 * 设计立场：先用 readBody 保住 2MB 上限与排水语义，再把已读取的 body 交给官方
 * `zValidator`。schema 在路由注册处声明，handler 仍通过 parsedJsonOf(req) 读取缓存。
 */
import type { Context } from "hono";
import type { IncomingMessage } from "node:http";
import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";
import { BODY_MAX_BYTES, readBody, cacheParsedJson } from "./http-body.js";

export interface JsonBodyOptions {
  /** 坏 JSON 以外的校验失败提示；默认取第一条 zod issue 的中文消息 */
  message?: string;
}

/** 从上下文取 jsonBody 中间件解析后的请求体（未经过 jsonBody 的路由返回 undefined）。 */
export function jsonBodyOf<T>(c: Context): T | undefined {
  return c.get("jsonBody") as T | undefined;
}

/**
 * JSON 请求体校验中间件：先用 readBody 保留 2MB 上限和排水语义，再把已限额的 body
 * 交给官方 zValidator 做 schema 校验；成功后缓存到原生 IncomingMessage。
 */
export function jsonBody<T>(schema: ZodType<T>, options: JsonBodyOptions = {}) {
  const validate = zValidator("json", schema, (result, c) => {
    if (!result.success) {
      const issue = options.message ?? result.error.issues[0]?.message ?? "请求参数不合法";
      return c.json({ error: issue }, 400);
    }
    const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
    if (incoming) cacheParsedJson(incoming, result.data);
    return undefined;
  });

  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const req = (c.env as { incoming: IncomingMessage }).incoming;
    const raw = await readBody(req);
    // zValidator 读取 c.req.raw.body；用已限额的原生 body 替换，避免再次触碰流。
    c.req.raw = new Request(c.req.raw.url, {
      method: c.req.method,
      headers: new Headers(c.req.raw.headers),
      body: raw || "{}",
    });
    return validate(c, next);
  };
}

/** readBody 的体积上限重导出：调用方按路由覆盖（文件上传 12MB 白名单另行处理）。 */
export { BODY_MAX_BYTES };
