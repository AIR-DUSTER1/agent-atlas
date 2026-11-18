/**
 * postgres.test.ts — 多租户 PostgreSQL RLS 集成测试（需要真实数据库）
 * ============================================================
 * 运行：
 *   TEST_DATABASE_URL=postgres://app_user:...@host/db \
 *   TEST_DATABASE_ADMIN_URL=postgres://admin:...@host/db \
 *   npm run test:postgres
 *
 * 应用角色必须是普通角色（NOBYPASSRLS），否则本测试会明确失败——这正是生产要求。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const enabled = Boolean(databaseUrl && adminUrl);
const previous = {
  STATE_BACKEND: process.env.STATE_BACKEND,
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
};

test("PostgreSQL ownerId + RLS：跨 owner 查询不可见，事务变量不串租户", { skip: !enabled }, async () => {
  process.env.STATE_BACKEND = "postgres";
  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_ADMIN_URL = adminUrl;
  const { closePostgres, initializePostgres, querySystem, withOwnerTransaction } = await import("../../src/server/persistence/postgres.js");
  const { createUserWithToken } = await import("../../src/server/persistence/accounts.js");
  const created: string[] = [];
  try {
    await initializePostgres();
    const a = await createUserWithToken({ displayName: `rls-a-${randomUUID()}` });
    const b = await createUserWithToken({ displayName: `rls-b-${randomUUID()}` });
    created.push(a.ownerId, b.ownerId);
    await withOwnerTransaction(a.ownerId, (client) => client.query(
      "INSERT INTO session_journal_events(owner_id, event) VALUES ($1, $2)",
      [a.ownerId, { ev: "session", ownerId: a.ownerId, id: "rls-only-a" }],
    ));
    const visibleA = await withOwnerTransaction(a.ownerId, (client) => client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM session_journal_events",
    ));
    const visibleB = await withOwnerTransaction(b.ownerId, (client) => client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM session_journal_events",
    ));
    assert.equal(visibleA.rows[0]?.count, "1");
    assert.equal(visibleB.rows[0]?.count, "0");
  } finally {
    if (created.length) {
      await querySystem("DELETE FROM users WHERE id = ANY($1::uuid[])", [created]).catch(() => {});
    }
    await closePostgres();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});