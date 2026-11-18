/**
 * ============================================================
 * persistence/postgres.ts — PostgreSQL 连接、迁移与 owner 事务上下文
 * ============================================================
 * 职责：集中管理 file/postgres 双后端开关、连接池、迁移和 RLS 会话变量。
 * 设计立场：
 *  - 业务代码不得直接 new Pool；所有租户查询都通过 withOwnerTransaction，
 *    由事务级 app.owner_id 交给 PostgreSQL RLS 做最后一道隔离；
 *  - DATABASE_URL 是运行时低权限角色；DATABASE_ADMIN_URL 只用于迁移/bootstrap；
 *  - file 后端保持默认，桌面端和现有本地开发不受影响。
 */
import { readFile } from "node:fs/promises";
import pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { log } from "../logging.js";

const { Pool } = pg;

export type StateBackend = "file" | "postgres";

export interface LocalOwnerIdentity {
  ownerId: string;
  role: "admin" | "member";
}

let appPool: pg.Pool | null = null;
let adminPool: pg.Pool | null = null;
let localOwner: LocalOwnerIdentity | null = null;

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function stateBackend(): StateBackend {
  const raw = envValue("STATE_BACKEND").toLowerCase();
  if (!raw || raw === "file") return "file";
  if (raw === "postgres") return "postgres";
  throw new Error("STATE_BACKEND 只能是 file 或 postgres");
}

export function isPostgresBackend(): boolean {
  return stateBackend() === "postgres";
}

function databaseUrl(): string {
  const url = envValue("DATABASE_URL");
  if (!url) throw new Error("STATE_BACKEND=postgres 时必须配置 DATABASE_URL");
  return url;
}

function adminDatabaseUrl(): string {
  return envValue("DATABASE_ADMIN_URL") || databaseUrl();
}

function poolConfig(url: string): pg.PoolConfig {
  const max = Number(envValue("DATABASE_POOL_MAX") || "10");
  const sslMode = envValue("DATABASE_SSL").toLowerCase();
  return {
    connectionString: url,
    max: Number.isSafeInteger(max) && max > 0 && max <= 100 ? max : 10,
    ...(sslMode === "require" || sslMode === "true"
      ? { ssl: { rejectUnauthorized: envValue("DATABASE_SSL_REJECT_UNAUTHORIZED").toLowerCase() !== "false" } }
      : {}),
  };
}

export function getAppPool(): pg.Pool {
  if (!appPool) appPool = new Pool(poolConfig(databaseUrl()));
  return appPool;
}

function getAdminPool(): pg.Pool {
  if (!adminPool) adminPool = new Pool(poolConfig(adminDatabaseUrl()));
  return adminPool;
}

export function setLocalOwnerIdentity(owner: LocalOwnerIdentity): void {
  localOwner = owner;
}

export function localOwnerIdentity(): LocalOwnerIdentity | null {
  return localOwner;
}

/** owner 事务：SET LOCAL 只在当前事务有效，连接归还池后不会串租户。 */
export async function withOwnerTransaction<T>(
  ownerId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!isPostgresBackend()) throw new Error("当前不是 PostgreSQL 后端");
  if (!ownerId.trim()) throw new Error("ownerId 不能为空");
  const client = await getAppPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.owner_id', $1, true)", [ownerId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function withSystemTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAdminPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
/** 认证/bootstrap/全局配置查询使用独立入口；不得暴露给普通业务路由。 */
export async function querySystem<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return getAdminPool().query<T>(sql, params);
}

export async function databaseHealth(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
  if (!isPostgresBackend()) return { ok: true, latencyMs: 0 };
  const startedAt = Date.now();
  try {
    await getAppPool().query("SELECT 1 AS ok");
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function migrationSql(version: number): Promise<string> {
  const file = new URL(`./sql/${String(version).padStart(3, "0")}_multitenant.sql`, import.meta.url);
  return readFile(file, "utf8");
}

const MIGRATIONS = [{ version: 1, name: "multitenant-rls" }] as const;

/** 启动前执行；迁移使用 DATABASE_ADMIN_URL，迁移完成后运行时走 DATABASE_URL。 */
export async function initializePostgres(): Promise<void> {
  if (!isPostgresBackend()) return;
  const client = await getAdminPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const migration of MIGRATIONS) {
      const applied = await client.query<{ version: number }>(
        "SELECT version FROM schema_migrations WHERE version = $1",
        [migration.version],
      );
      if (applied.rowCount) continue;
      await client.query("BEGIN");
      try {
        const sql = await migrationSql(migration.version);
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(version, name) VALUES ($1, $2)",
          [migration.version, migration.name],
        );
        await client.query("COMMIT");
        log("info", "database_migration_applied", { version: migration.version, name: migration.name });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

export async function closePostgres(): Promise<void> {
  const pools = [appPool, adminPool].filter(Boolean) as pg.Pool[];
  appPool = null;
  adminPool = null;
  await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
}