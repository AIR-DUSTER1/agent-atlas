/**
 * scripts/clear-local-lock.ts — 清除文件模式的本地访问密码锁（U3 解锁通道）
 * ============================================================
 * 用法：npm run lock:clear
 * 前提：在本机以有权限的用户运行（锁文件在 .setting/local-user.json，0600）。
 * 忘记密码且无法登录时的最后手段；清除后重新配对或重设密码锁。
 */
import { clearLocalLock, hasLocalLock } from "../src/server/security/local-lock.js";

async function main(): Promise<void> {
  if (!(await hasLocalLock())) {
    process.stdout.write("当前未设置本地访问密码锁，无需清除。\n");
    return;
  }
  await clearLocalLock();
  process.stdout.write("✓ 已清除本地访问密码锁；重启服务或刷新页面后可重新配对。\n");
}

main().catch((error) => {
  process.stderr.write(`清除失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
