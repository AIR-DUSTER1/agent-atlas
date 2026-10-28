/**
 * ============================================================
 * auth-routes.ts — 认证路由覆盖率驱动（非 CI 主测试）
 * ============================================================
 * c8 无法可靠合并 tests/helpers 中独立 node:tsx 子进程的 V8 覆盖率，因此这里
 * 在同一个进程内启动真实 HTTP 服务，依次走未登录、登录、续期、注销与失败路径，
 * 再由 c8 对 routes/auth.ts 做风险阈值检查。所有数据写系统临时目录。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "agent-auth-coverage-"));
const port = 3468;
Object.assign(process.env, {
  HOST: "127.0.0.1",
  PORT: String(port),
  API_KEY: "",
  AUTH_TOKEN: "coverage-auth-token-123456",
  SESSION_SECRET: "coverage-session-secret-with-at-least-thirty-two-characters",
  SESSION_TTL_HOURS: "1",
  COOKIE_SECURE: "false",
  LOG_LEVEL: "error",
  BEIKE_DISABLE_AUTO_INSTALL: "1",
  WEB_CONFIG_FILE: join(data, "web-config.json"),
  SESSIONS_FILE: join(data, "sessions.ndjson"),
  CHECKPOINT_FILE: join(data, "checkpoints.ndjson"),
  MEMORIES_FILE: join(data, "memories.json"),
  SKILLS_DIR: join(data, "skills"),
  AUDIT_FILE: join(data, "audit.ndjson"),
  BACKUP_DIR: join(data, "backups"),
});

await import("../../src/server/index.js");
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 80; i += 1) {
  try {
    if ((await fetch(base + "/healthz")).ok) break;
  } catch { /* 服务尚未监听 */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

let response = await fetch(base + "/api/auth/session");
assert.equal(response.status, 401);
response = await fetch(base + "/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "wrong-token" }),
});
assert.equal(response.status, 401);
response = await fetch(base + "/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{bad-json",
});
assert.equal(response.status, 400);
response = await fetch(base + "/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "coverage-auth-token-123456" }),
});
assert.equal(response.status, 200);
let cookie = (response.headers.get("set-cookie") || "").split(";")[0] || "";
assert.match(cookie, /lg_agent_session=/);
response = await fetch(base + "/api/auth/session", { headers: { Cookie: cookie } });
assert.equal(response.status, 200);
response = await fetch(base + "/api/auth/session/renew", {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(response.status, 200);
cookie = (response.headers.get("set-cookie") || "").split(";")[0] || cookie;
response = await fetch(base + "/api/auth/logout", {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(response.status, 200);
response = await fetch(base + "/api/auth/session", { headers: { Cookie: cookie } });
assert.equal(response.status, 401);

// 续期伪造 Cookie 连续失败：最后一次应从“会话过期 401”升级为 429 冷却。
for (let i = 0; i < 4; i += 1) {
  response = await fetch(base + "/api/auth/session/renew", {
    method: "POST",
    headers: { Cookie: "lg_agent_session=forged", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 401);
}
response = await fetch(base + "/api/auth/session/renew", {
  method: "POST",
  headers: { Cookie: "lg_agent_session=forged", "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(response.status, 429);
assert.ok(Number(response.headers.get("retry-after")) > 0);

// 已冷却 IP 即使提交正确引导密钥也先被入口限流拦截。
response = await fetch(base + "/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "coverage-auth-token-123456" }),
});
assert.equal(response.status, 429);

// 关闭认证后的三个无认证兼容分支。
process.env.AUTH_TOKEN = "";
response = await fetch(base + "/api/auth/session");
assert.equal(response.status, 200);
response = await fetch(base + "/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(response.status, 200);
response = await fetch(base + "/api/auth/session/renew", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(response.status, 200);

process.emit("SIGTERM");
await new Promise<void>(() => {});
