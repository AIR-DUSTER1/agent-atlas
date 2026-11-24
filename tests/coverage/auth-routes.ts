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
/** 满足 validatePasswordPolicy 的最小长度（MIN_PASSWORD_LENGTH = 10）。 */
const LOCK_PASSWORD = "coverage-lock-pass-1";
const NEW_PASSWORD = "coverage-lock-pass-2";
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
  TRUST_PROXY: "1",
  // 本地密码锁默认落在 <cwd>/.setting/local-lock.json —— 不指向临时目录会读到
  // 用户真实设置过的锁：assertions 会随机失败，而且测试本身会污染真实配置。
  LOCAL_LOCK_FILE: join(data, "local-lock.json"),
});

await import("../../src/server/index.js");
const base = `http://127.0.0.1:${port}`;
const remoteFetch = (path: string, init: RequestInit = {}): Promise<Response> => fetch(base + path, {
  ...init,
  headers: { ...(init.headers as Record<string, string> | undefined), "X-Forwarded-For": "198.51.100.30" },
});
for (let i = 0; i < 80; i += 1) {
  try {
    if ((await fetch(base + "/healthz")).ok) break;
  } catch { /* 服务尚未监听 */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

let response = await remoteFetch("/api/auth/session");
assert.equal(response.status, 401);
response = await remoteFetch("/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "wrong-token" }),
});
assert.equal(response.status, 401);
response = await remoteFetch("/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{bad-json",
});
assert.equal(response.status, 400);
response = await remoteFetch("/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "coverage-auth-token-123456" }),
});
assert.equal(response.status, 200);
// POST /api/auth/session 按序下发 设备Cookie、会话Cookie、再刷新设备Cookie（三条），
// set-cookie 拼接后取 [0] 是设备。必须按 Cookie 名精确挑出会话 Cookie，否则后面
// 续期/登出那一串断言都带着设备 Cookie 而拿不到会话，静默错连到设备分支。
let cookie = (response.headers.getSetCookie?.() ?? [])
  .map((item) => item.split(";")[0] ?? "")
  .find((item) => /^lg_agent_session=/.test(item)) || "";
assert.match(cookie, /lg_agent_session=/);
response = await remoteFetch("/api/auth/session", { headers: { Cookie: cookie } });
assert.equal(response.status, 200);
response = await remoteFetch("/api/auth/session/renew", {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(response.status, 200);
// 与上面一致：续期也走会话 Cookie。不能取 set-cookie[0]（那是设备）。
cookie = (response.headers.getSetCookie?.() ?? [])
  .map((item) => item.split(";")[0] ?? "")
  .find((item) => /^lg_agent_session=/.test(item)) || cookie;
response = await remoteFetch("/api/auth/logout", {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(response.status, 200);
response = await remoteFetch("/api/auth/session", { headers: { Cookie: cookie } });
assert.equal(response.status, 401);

// 续期伪造 Cookie 连续失败：最后一次应从“会话过期 401”升级为 429 冷却。
for (let i = 0; i < 4; i += 1) {
  response = await remoteFetch("/api/auth/session/renew", {
    method: "POST",
    headers: { Cookie: "lg_agent_session=forged", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 401);
}
response = await remoteFetch("/api/auth/session/renew", {
  method: "POST",
  headers: { Cookie: "lg_agent_session=forged", "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(response.status, 429);
assert.ok(Number(response.headers.get("retry-after")) > 0);

// 已冷却 IP 即使提交正确引导密钥也先被入口限流拦截。
response = await remoteFetch("/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "coverage-auth-token-123456" }),
});
assert.equal(response.status, 429);

// 关闭认证后的三个无认证兼容分支。
process.env.AUTH_TOKEN = "";
response = await remoteFetch("/api/auth/session");
assert.equal(response.status, 200);
response = await remoteFetch("/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(response.status, 200);
response = await remoteFetch("/api/auth/session/renew", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(response.status, 200);

// ---------------------------------------------------------------------------
// 用户体系（U0-U4）后新增的接口：本地密码锁 / 用户名密码登录 / 改密 / me。
// 这些是 routes/auth.ts 从 249 行扩到 666 行的主体，此前完全没覆盖，
// 导致 CI 的行覆盖率从 80%+ 掉到 38% —— 补这一段的目的是把缺口补回来。
// 文件模式（非 PG）不需要外部数据库，全部走真实 HTTP。
//
// 先恢复 AUTH_TOKEN：上一段为了覆盖"关闭认证"分支把它置空了，而 AUTH_TOKEN 为空时
// ensureDeviceIdentity 会给任何请求直接发身份（device.ts 的 authEnabled 分支），
// 密码锁与 /api/auth/me 的 401 路径就永远走不到。
process.env.AUTH_TOKEN = "coverage-auth-token-123456";
// ---------------------------------------------------------------------------

// 密码锁初始状态：未设置。这一段用独立 IP：前面已经把 198.51.100.30 打到
// 429 冷却，继续复用会让所有断言收到 429 而不是被测分支的真实结果。
//
// 但设置/清除密码锁要求「已配对设备」（requireLocalIdentity）。AUTH_TOKEN 非空时
// 带 X-Forwarded-For 的请求不算回环，拿不到自动身份，所以先在同 IP 上走一次
// /api/auth/session 拿到设备 Cookie，后续请求带上它。
const LOCK_IP = "198.51.100.77";
let deviceCookie = "";
const lockFetch = (path: string, init: RequestInit = {}): Promise<Response> => fetch(base + path, {
  ...init,
  headers: {
    // 显式传入的 Cookie 优先：覆盖测试需要构造"只带会话"或"只带设备"的场景，
    // 被默认 deviceCookie 覆盖会让这些断言失效（曾经踩过）。
    ...(deviceCookie ? { Cookie: deviceCookie } : {}),
    ...(init.headers as Record<string, string> | undefined),
    "X-Forwarded-For": LOCK_IP,
  },
});

// 用令牌建立一次会话，顺带拿到设备 Cookie（Set-Cookie 里可能有两条）。
response = await lockFetch("/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "coverage-auth-token-123456" }),
});
assert.equal(response.status, 200);
const setCookies = response.headers.getSetCookie?.() ?? [];
const devicePart = setCookies.map((item) => item.split(";")[0] ?? "").find((item) => /lg_agent_device=/.test(item));
assert.ok(devicePart, "首次会话必须下发设备 Cookie，否则后续密码锁接口没有设备身份");
deviceCookie = devicePart;

response = await lockFetch("/api/auth/local-lock");
assert.equal(response.status, 200);
assert.equal((await response.json() as { enabled: boolean }).enabled, false);

// 设置密码锁：先被密码策略拒绝，再成功。
response = await lockFetch("/api/auth/local-lock", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ newPassword: "123" }),
});
assert.equal(response.status, 400, "弱密码必须被策略拒绝");

response = await lockFetch("/api/auth/local-lock", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{bad-json",
});
assert.equal(response.status, 400, "非法 JSON 必须 400");

response = await lockFetch("/api/auth/local-lock", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ newPassword: LOCK_PASSWORD }),
});
assert.equal(response.status, 200);
assert.equal((await response.json() as { enabled: boolean }).enabled, true);

// 已设置后用错误的当前密码改密：必须拒绝。
response = await lockFetch("/api/auth/local-lock", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ currentPassword: "wrong-current", newPassword: LOCK_PASSWORD }),
});
assert.equal(response.status, 400);
assert.match(await response.text(), /当前访问密码不正确/);

// 用户名密码登录（文件模式：只需密码）。注意走 /api/auth/login 而不是
// /api/auth/session —— 后者是旧的令牌/设备静默会话入口，AUTH_TOKEN 为空时
// 会直接签发会话而不校验密码锁。
response = await lockFetch("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: "wrong-password" }),
});
assert.equal(response.status, 401, "错误密码必须 401");

response = await lockFetch("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
assert.equal(response.status, 400, "缺密码必须 400");

response = await lockFetch("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: LOCK_PASSWORD }),
});
assert.equal(response.status, 200);
const loginBody = await response.json() as { authenticated: boolean; userId: string; role: string };
assert.equal(loginBody.authenticated, true);
// 文件模式下设备身份先于密码锁建立，userId 取设备 id（identityFromDevice 的 v1 语义），
// 不是字面量 "local"；这里只断言它是非空标识且角色为 admin。
assert.ok(loginBody.userId && loginBody.userId.length > 0, "登录必须返回 userId");
assert.equal(loginBody.role, "admin");
// /api/auth/login 只下发一条会话 Cookie（不重发设备，密码路径不建新设备）。
const lockCookie = (response.headers.getSetCookie?.() ?? [])
  .map((item) => item.split(";")[0] ?? "")
  .find((item) => /^lg_agent_session=/.test(item)) || "";
assert.match(lockCookie, /lg_agent_session=/);

// /api/auth/me：带会话返回身份；完全无 Cookie 时必须 401。
// 注意不能复用 lockFetch —— 它会带上 deviceCookie，而设备身份本身就能换成用户身份，
// 那样就测不到"未登录"这条路径了。
response = await lockFetch("/api/auth/me", { headers: { Cookie: lockCookie } });
assert.equal(response.status, 200);
assert.ok((await response.json() as { userId: string }).userId, "已登录必须返回 userId");
response = await fetch(base + "/api/auth/me", {
  headers: { "X-Forwarded-For": LOCK_IP },
});
assert.equal(response.status, 401, "无任何 Cookie 必须 401");

// 改密：旧密码错 / 新密码弱 / 成功。
response = await lockFetch("/api/auth/password", {
  method: "POST",
  headers: { Cookie: lockCookie, "Content-Type": "application/json" },
  body: JSON.stringify({ currentPassword: "wrong", newPassword: NEW_PASSWORD }),
});
assert.equal(response.status, 400);

response = await lockFetch("/api/auth/password", {
  method: "POST",
  headers: { Cookie: lockCookie, "Content-Type": "application/json" },
  body: JSON.stringify({ currentPassword: LOCK_PASSWORD, newPassword: "1" }),
});
assert.equal(response.status, 400, "新密码必须过策略");

response = await lockFetch("/api/auth/password", {
  method: "POST",
  headers: { Cookie: lockCookie, "Content-Type": "application/json" },
  body: JSON.stringify({ currentPassword: LOCK_PASSWORD, newPassword: NEW_PASSWORD }),
});
assert.equal(response.status, 200);
assert.equal((await response.json() as { ok: boolean }).ok, true);

// 改密后：本次会话被显式撤销（handleAuthPassword 里 revokeSession + 清 Cookie），
// 所以旧 Cookie 的 /api/auth/me 必须 401。
// 注意：文件模式没有 PG 的 credential_epoch 门禁（assertFreshCredentials 在
// 非 PG 下直接 return true），因此"其它设备的静默会话"不会被这次改密失效 ——
// 这是已知缺口，不在这里断言成已实现。
response = await lockFetch("/api/auth/me", { headers: { Cookie: lockCookie } });
assert.equal(response.status, 401, "改密会撤销当前会话并清 Cookie");

response = await lockFetch("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: NEW_PASSWORD }),
});
assert.equal(response.status, 200);
const reLoginCookie = (response.headers.getSetCookie?.() ?? [])
  .map((item) => item.split(";")[0] ?? "")
  .find((item) => /^lg_agent_session=/.test(item)) || "";

// 清除密码锁：错误密码拒绝，正确密码成功；清完再查状态为 disabled。
response = await lockFetch("/api/auth/local-lock", {
  method: "DELETE",
  headers: { Cookie: reLoginCookie, "Content-Type": "application/json" },
  body: JSON.stringify({ currentPassword: "wrong" }),
});
assert.equal(response.status, 400);

response = await lockFetch("/api/auth/local-lock", {
  method: "DELETE",
  headers: { Cookie: reLoginCookie, "Content-Type": "application/json" },
  body: "{bad-json",
});
assert.equal(response.status, 400);

response = await lockFetch("/api/auth/local-lock", {
  method: "DELETE",
  headers: { Cookie: reLoginCookie, "Content-Type": "application/json" },
  body: JSON.stringify({ currentPassword: NEW_PASSWORD }),
});
assert.equal(response.status, 200);
assert.equal((await response.json() as { enabled: boolean }).enabled, false);

// 锁已清除后再清除：幂等返回 ok。
response = await lockFetch("/api/auth/local-lock", {
  method: "DELETE",
  headers: { Cookie: reLoginCookie, "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
assert.equal(response.status, 200);
assert.equal((await response.json() as { enabled: boolean }).enabled, false);

// ---------------------------------------------------------------------------
// 多用户（postgres）模式的早退分支：这三个接口在 PG 下直接 404，不碰数据库。
// auth.ts 现在约一半代码是 PG 专属路径，文件模式测试天然覆盖不到；
// 这里靠切换 STATE_BACKEND 触发早退分支，把「模式分流」本身覆盖掉。
// ---------------------------------------------------------------------------
process.env.STATE_BACKEND = "postgres";
for (const [method, path] of [
  ["GET", "/api/auth/local-lock"],
  ["POST", "/api/auth/local-lock"],
  ["DELETE", "/api/auth/local-lock"],
] as const) {
  response = await fetch(base + path, {
    method,
    headers: { "X-Forwarded-For": LOCK_IP, "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify({ newPassword: NEW_PASSWORD }) }),
  });
  assert.equal(response.status, 404, `PG 模式下 ${method} ${path} 必须 404`);
}
process.env.STATE_BACKEND = "file";

process.emit("SIGTERM");
await new Promise<void>(() => {});
