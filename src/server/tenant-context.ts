/**
 * ============================================================
 * tenant-context.ts — 单次请求的 owner/device 身份上下文
 * ============================================================
 * 职责：把已认证的真实用户、设备和角色放入 AsyncLocalStorage，供数据库事务、
 * 文件授权、记忆 scope 与审计在异步链中读取，避免每个函数重复传 ownerId。
 *
 * 设计立场：HTTP 入口认证成功后必须 enterTenantContext；CLI/测试未建立上下文时
 * 才回落到 local 单用户身份，生产 PostgreSQL 模式不得依赖隐式回落。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type TenantRole = "admin" | "member";

export interface TenantContext {
  ownerId: string;
  deviceId: string;
  role: TenantRole;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function enterTenantContext(context: TenantContext): void {
  storage.enterWith(context);
}

export function runWithTenantContext<T>(context: TenantContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/** 只用于本地单用户/CLI；PostgreSQL 请求必须先完成用户认证。 */
export function localTenantContext(): TenantContext {
  return { ownerId: "local", deviceId: "local", role: "admin" };
}

export function tenantContextOrLocal(): TenantContext {
  return currentTenantContext() ?? localTenantContext();
}