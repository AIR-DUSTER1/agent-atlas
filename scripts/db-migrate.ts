/**
 * scripts/db-migrate.ts — PostgreSQL schema 迁移入口
 * 使用 DATABASE_ADMIN_URL（缺省回落 DATABASE_URL）执行幂等迁移，然后关闭连接池。
 */
import { closePostgres, initializePostgres, isPostgresBackend } from "../src/server/persistence/postgres.js";

async function main(): Promise<void> {
  if (!isPostgresBackend()) throw new Error("请设置 STATE_BACKEND=postgres 后再执行迁移");
  await initializePostgres();
  process.stdout.write("PostgreSQL migrations applied\n");
}

main()
  .catch((error) => {
    process.stderr.write(`迁移失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgres();
  });