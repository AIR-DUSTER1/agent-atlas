/**
 * ============================================================
 * security/auth-mode.ts — 「是否必须认证」的唯一判定
 * ============================================================
 * 职责：把「认证是否开启」收敛成一个谓词，供 auth.ts（API 门禁）与
 * security/device.ts（设备静默身份）共用，避免两处各算一套而分裂。
 *
 * 设计立场：
 *  - 文件模式：AUTH_TOKEN 为空即视为无认证（本机单用户免登，保持既有行为）；
 *  - 数据库模式：用户来自 users 表，**与 AUTH_TOKEN 无关**，永远要求登录。
 *    此前两条路径都只看 AUTH_TOKEN，导致 PG 模式漏配 AUTH_TOKEN 时
 *    整个 API 免认证、任何远端都能拿到 admin 身份 —— 属于认证绕过。
 */
import { isPostgresBackend } from "../persistence/postgres.js";

export function authRequired(): boolean {
  if (isPostgresBackend()) return true;
  return (process.env.AUTH_TOKEN ?? "").trim().length > 0;
}
