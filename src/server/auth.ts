/**
 * ============================================================
 * auth.ts — Web API 统一 Bearer 认证（Phase 1 T1-1）
 * ============================================================
 * 职责：AUTH_TOKEN 开启后，除静态页与 /healthz 外的所有 /api/* 都要求
 * `Authorization: Bearer <token>`；未配置 token 时本模块不拦截（本地学习
 * 模式的边界由 index.ts 的 Phase 0 规则保证：非 loopback 拒绝一切写操作）。
 *
 * 设计立场：
 *  - token 比较必须常量时间：对两侧做 sha256 归一长度后 timingSafeEqual，
 *    隐藏「长度差异 + 逐字节提前返回」两种侧信道；
 *  - 401 一律统一文案，不区分「缺头/错 token」，不回显任何输入内容；
 *  - 是安全令牌就不进 .web-config.json，也不做运行时热更（改 .env 需重启），
 *    所以这里延迟读 env 而非启动时常量（防 ESM 求值顺序早于 dotenv/config）。
 */
import { timingSafeEqual, createHash } from "node:crypto";

/** 服务端持有的访问令牌（每次调用时从 env 读取，见模块头「防 ESM 早求值」） */
function currentToken(): string {
  return (process.env.AUTH_TOKEN ?? "").trim();
}

/** 认证是否已启用：调用方在入口做一次性短路，避免每个请求都读 env */
export function isAuthEnabled(): boolean {
  return currentToken().length > 0;
}

/** 401 统一文案：说清「缺什么/怎么改」，但不包含「token 错」等具体原因细节 */
export const UNAUTHORIZED_MSG =
  "需要认证：请在请求头携带 Authorization: Bearer <AUTH_TOKEN>（与服务端 .env 中配置一致）";

/** 传入 token 与服务端 token 的常量时间比较（哈希归一长度后逐位比较） */
function tokenEquals(candidate: string): boolean {
  const expected = currentToken();
  if (!expected) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** 校验请求是否携带正确的 Bearer token；认证未开启时直接放行（本地学习模式） */
export function verifyBearer(req: import("node:http").IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? tokenEquals(match[1]) : false;
}
