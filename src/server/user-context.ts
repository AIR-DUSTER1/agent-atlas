/**
 * ============================================================
 * user-context.ts — 单次请求的 user/device 身份上下文
 * ============================================================
 * 职责：把已认证的真实用户、设备和角色放入 AsyncLocalStorage，供数据库事务、
 * 文件授权、记忆 scope 与审计在异步链中读取，避免每个函数重复传 userId。
 *
 * 设计立场：HTTP 入口认证成功后必须 enterUserContext；CLI/测试未建立上下文时
 * 才回落到 local 单用户身份，生产 PostgreSQL 模式不得依赖隐式回落。
 *
 * 命名说明：旧实现叫 tenant-context（租户心智），用户体系改造统一为 user
 * 语义；磁盘 journal 行的 `userId` 字段是历史序列化格式，见 session-store
 * 的序列化边界注释，不要把磁盘字段名与这里的内存标识符混为一谈。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type UserRole = "admin" | "member";

export interface UserContext {
  userId: string;
  deviceId: string;
  role: UserRole;
}

const storage = new AsyncLocalStorage<UserContext>();

export function enterUserContext(context: UserContext): void {
  storage.enterWith(context);
}

export function runWithUserContext<T>(context: UserContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentUserContext(): UserContext | undefined {
  return storage.getStore();
}

/** 只用于本地单用户/CLI；PostgreSQL 请求必须先完成用户认证。 */
export function localUserContext(): UserContext {
  return { userId: "local", deviceId: "local", role: "admin" };
}

export function userContextOrLocal(): UserContext {
  return currentUserContext() ?? localUserContext();
}
