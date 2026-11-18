/**
 * scripts/create-user.ts — PostgreSQL 多用户模式的管理员用户创建器
 * ============================================================
 * 用法：
 *   npm run user:create -- --name "Alice" [--email alice@example.com] [--role member|admin]
 *
 * 输出只打印一次访问令牌；管理员应通过安全渠道交给用户，不写入日志或仓库。
 */
import { closePostgres, initializePostgres, isPostgresBackend } from "../src/server/persistence/postgres.js";
import { createUserWithToken } from "../src/server/persistence/accounts.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1]?.trim();
}

async function main(): Promise<void> {
  if (!isPostgresBackend()) throw new Error("请先设置 STATE_BACKEND=postgres 和 DATABASE_URL");
  await initializePostgres();
  const name = arg("name");
  if (!name) throw new Error("缺少 --name，例如 npm run user:create -- --name Alice");
  const role = arg("role") === "admin" ? "admin" : "member";
  const created = await createUserWithToken({
    displayName: name,
    email: arg("email"),
    role,
  });
  process.stdout.write(JSON.stringify({
    ownerId: created.ownerId,
    displayName: created.displayName,
    role: created.role,
    accessToken: created.token,
    note: "访问令牌只显示一次；请通过安全渠道交给用户。",
  }, null, 2) + "\n");
}

main()
  .catch((error) => {
    process.stderr.write(`创建用户失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgres();
  });