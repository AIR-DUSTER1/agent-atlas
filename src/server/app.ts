/**
 * ============================================================
 * app.ts — Hono 应用外壳（框架迁移 M1：行为不变）
 * ============================================================
 * 职责：把 index.ts 平移前的请求处理拆成「Hono 中间件栈 + legacy 分发」。
 *  - 横切层逐个包成 middleware（rawGate：门禁函数仍直接写原生 res，返回 false
 *    表示已应答，外壳以 x-hono-already-sent 标记让适配器不再写响应）；
 *  - 认证端点与 /metrics 提前挂载（顺序语义：它们豁免 verifyRequestAuth 门禁）；
 *  - catch-all 分两段：GET 非 /api 走静态文件，其余原样透传给 dispatchApi。
 * 迁移纪律：M1 只换挂载点、不改任何门禁逻辑与响应形状；M2 起逐批把门禁与路由
 * 原生化（zValidator + Hono Response），每批以 server.test.ts 不改断言直绿为门。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { HttpBindings } from "@hono/node-server";
import {
  assertFreshCredentials, assertPasswordChangeAllowed, handleAuthLogin, handleAuthLogout,
  handleAuthMe, handleAuthPassword, handleAuthRenew, handleAuthStatus, handleClearLocalLock,
  handleLocalLockStatus, handlePasswordLogin, handleSetLocalLock,
} from "./routes/auth.js";
import { verifyMetricsAuth, verifyRequestAuth } from "./auth.js";
import { authFailureLimiter, clientIp } from "./security/rate-limit.js";
import {
  adoptBearerIdentity, ensureDeviceIdentity, ensureDeviceSession, isAdminRequest,
  requireDeviceIdentity, userIdentityForRequest,
} from "./security/device.js";
import { applySecurityHeaders, checkSameOrigin, respondForbidden, respondUnauthorized } from "./http-guard.js";
import { writeAudit } from "./audit.js";
import { log, newRequestId } from "./logging.js";
import { handleHealthz, handleReadyz } from "./health.js";
import { handleClientError, handleDiagnostics, handleMetrics, handleVersion } from "./routes/observability.js";
import { handleStats } from "./routes/stats.js";
import { isPostgresBackend } from "./persistence/postgres.js";
import { ensureProjectsLoaded } from "./projects.js";
import { ensureUserSessions, getSessionByThreadForUser } from "./sessions.js";
import { enterUserContext, localUserContext } from "./user-context.js";
import { incCounter, incGauge, metricPath, observeHistogram } from "./observability/metrics.js";
import { lifecycle } from "./lifecycle.js";
import { BodyTooLargeError, respondBadRequest } from "./http-body.js";
import { serveStatic } from "./static.js";
import { dispatchApi } from "./dispatch.js";
import {
  handleActivate, handleAddModel, handleAddProvider, handleDeleteModel, handleDeleteProvider,
  handleGetApiConfig, handleModels, handleSetReasoning, handleUpdateModel, handleUpdateProvider,
} from "./routes/config.js";
import { handleGetTracing, handleSaveTracing } from "./routes/tracing.js";
import {
  handleDeleteCommand, handleListCommands, handleSaveCommand, handleUpdateCommand,
} from "./routes/commands.js";
import {
  handleDeleteSkill, handleImportSkills, handleListSkills, handleSaveSkill, handleSetSkillEnabled,
} from "./routes/skills.js";
import {
  handleDeleteMcp, handleImportMcp, handleListMcp, handleSaveMcp, handleSetMcpEnabled,
  handleTestMcp, handleUpdateMcp,
} from "./routes/mcp.js";
import { refreshMcpTools } from "./dispatch.js";
import { handleCreateBackup, handleListBackups, handleRestoreBackup } from "./routes/backup.js";
import {
  handleCreateUser, handleCreateUserToken, handleDeleteUser, handleListUserTokens,
  handleListUsers, handleResetUserPassword, handleRevokeUserToken, handleUpdateUser,
} from "./routes/users.js";
import {
  handleCleanupSessions, handleCompactSession, handleDeleteSession, handleExportSession,
  handleSessionPermission, handleSessions, handleTranscript,
} from "./routes/sessions.js";
import { handleListPlugins, handleSetPluginEnabled } from "./routes/plugins.js";
import { handleGetRouting, handleSaveRouting, handleTestRouting } from "./routes/routing.js";
import {
  handleCreateSubagent, handleDeleteSubagent, handleListSubagents, handleUpdateSubagent,
} from "./routes/subagents.js";
import {
  handleAddProject, handleDeleteProject, handleListProjects, handlePickProjectDirectory,
  handleRefreshProject, handleSetActiveProject,
} from "./routes/projects.js";
import { handleFsList, handleFsOpenRemote, handleFsRead, handleFsSearch, handleUpload } from "./routes/files.js";
import {
  handleClearRag, handleDeleteRagDoc, handleGetRag, handleIngest, handleRagSearch,
  handleSaveRagConfig, handleTestRag,
} from "./routes/rag.js";
import { handleEstateExport, handleGetEstate, handleInstallBeike, handleSaveBeikeKey, handleStartBeikeLogin } from "./routes/estate.js";
import { handleGetJob, handleJobDiagnose, handleJobDoctor, handleJobLogin, handleSaveJob } from "./routes/job.js";
import {
  handleBrowserClose, handleBrowserScreenshot, handleBrowserState, handleBrowserStatus,
} from "./routes/browser-use.js";
import { BODY_MAX_BYTES, cacheParsedJson, readBody } from "./http-body.js";
import {
  handleGetMemoryConfig, handleMemoryStatus, handleReindexMemory, handleTestEmbeddingMemory,
  handleTestMemory, handleUpdateMemoryConfig,
} from "./routes/memory.js";
import {
  handleConfirmMemory, handleDeleteMemory, handleExportMemories, handleImportMemories,
  handleListMemories, handleListMemoryCandidates, handleRejectMemory,
} from "./routes/memories.js";
import { AUTH_ENABLED, EXPOSED_NOAUTH_ERR, LOOPBACK_HOST, PORT } from "./http-context.js";

// 「响应已直写」标记统一在 already-sent.ts（M2 的 validation.ts 也要用）。
import { alreadySent } from "./already-sent.js";

type RawGate = (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean | Promise<boolean>;

/**
 * 把「(req, res) => boolean | Promise<boolean>」形态的既有门禁包成 Hono middleware。
 * 返回 false = 门禁已写响应（4xx/503），链路短路；true = 继续 next()。
 */
function rawGate(gate: RawGate): MiddlewareHandler {
  return async (c, next) => {
    const pathname = c.req.path;
    const ok = await gate(c.env.incoming, c.env.outgoing, pathname);
    if (!ok) return alreadySent();
    await next();
  };
}

/** 控制面（全局供应商/插件/MCP/技能/备份/用户管理/诊断）只允许管理员操作。 */
function isAdminOnlyApi(pathname: string, method: string | undefined): boolean {
  if (pathname.startsWith("/api/users")) return true;
  if (method === "GET" || method === "HEAD") {
    return pathname === "/api/models"
      || pathname.startsWith("/api/memory/config")
      || pathname.startsWith("/api/backup")
      || pathname === "/api/tracing"
      || pathname.startsWith("/api/diagnostics");
  }
  return pathname === "/api/models"
    || pathname === "/api/fs/open-remote"
    || pathname === "/api/projects/pick-directory"
    || pathname.startsWith("/api/config/")
    || pathname.startsWith("/api/plugins/")
    || pathname.startsWith("/api/subagents/")
    || pathname.startsWith("/api/routing/")
    || pathname.startsWith("/api/memory/config")
    || pathname.startsWith("/api/memory/test")
    || pathname.startsWith("/api/memory/embedding")
    || pathname.startsWith("/api/memory/reindex")
    || pathname.startsWith("/api/rag/")
    || pathname.startsWith("/api/external-agents/")
    || pathname.startsWith("/api/backup")
    || pathname === "/api/tracing"
    || pathname.startsWith("/api/diagnostics");
}

interface RequestLogState {
  requestId: string;
  startedAt: number;
  tracked: boolean;
  sessionId?: string;
  /** app.onError 写响应时记录的真实状态码；finally 记账用它（raw res 尚未 writeHead） */
  errorStatus?: number;
}

type AppEnv = { Bindings: HttpBindings; Variables: { requestLog: RequestLogState } };
type AppContext = Context<AppEnv>;

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ── 1. 请求上下文：X-Request-Id、计时、错误映射、记账（最外层 try/catch/finally）──
  app.use("*", async (c, next) => {
    const req = c.env.incoming;
    const res = c.env.outgoing;
    const requestId = newRequestId();
    res.setHeader("X-Request-Id", requestId);
    const startedAt = Date.now();
    const pathname = c.req.path;
    const state: RequestLogState = { requestId, startedAt, tracked: false };
    c.set("requestLog", state);
    // 注意：Hono 的 compose 会把 handler / 门禁抛出的错误直接交给 app.onError，
    // 不会穿透中间件的 try/catch；错误映射全部在 onError（见下方），这里只做记账。
    await next();
    {
      // 在中间件链完全退出后记账（而不是 res 的 close）：SSE 被 shutdown abort 时，
      // close 可能早于 streamToClient 的 finally 落 journal，会让优雅退出提前 flush。
      const durationMs = Date.now() - startedAt;
      const status = state.errorStatus ?? res.statusCode;
      incCounter("agent_http_requests_total", {
        method: req.method ?? "UNKNOWN",
        status,
        path: metricPath(pathname),
      });
      observeHistogram("agent_http_request_duration_milliseconds", durationMs, {
        method: req.method ?? "UNKNOWN",
        status,
        path: metricPath(pathname),
      });
      if (state.tracked) {
        lifecycle.endRequest();
        incGauge("agent_http_inflight_requests", {}, -1);
        log(pathname.startsWith("/api/") ? "info" : "debug", "http_request", {
          requestId,
          method: req.method,
          path: pathname,
          status,
          durationMs,
          sessionId: state.sessionId,
        });
      }
    }
  });

  // ── 1b. 错误映射（app.onError）：与平移前 handler 的 catch 语义逐字一致 ──
  // 请求体超限 → 413；坏 JSON → 400；其余 → 500 JSON。响应直写原生 res。
  app.onError((err, c) => {
    const req = c.env.incoming;
    const res = c.env.outgoing;
    const state = c.get("requestLog");
    // 请求体超限：统一 413 + 断开连接（readBody 已 pause 数据流，不会有残留累积）
    if (err instanceof BodyTooLargeError) {
      respondBadRequest(res, req, err);
      state.errorStatus = res.statusCode;
      return alreadySent();
    }
    // 请求体不是合法 JSON（各路由直接 JSON.parse(readBody)）：客户端问题 → 400，
    // 不应落到 500（500 会误导「服务端故障」，也让压测把坏请求算成服务错误）
    if (err instanceof SyntaxError) {
      if (!res.headersSent) respondBadRequest(res, req, new Error("请求体不是合法的 JSON"));
      else res.end();
      state.errorStatus = res.statusCode;
      return alreadySent();
    }
    const message = err instanceof Error ? err.message : String(err);
    log("error", "request_failed", { requestId: state.requestId, method: req.method, path: c.req.path, message });
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: message }));
    state.errorStatus = 500;
    return alreadySent();
  });

  // ── 2. 安全响应头 + API 禁缓存 ──
  app.use("*", async (c, next) => {
    const res = c.env.outgoing;
    // API 响应一律禁缓存（GET /api/config 等被浏览器缓存会造成状态不同步）
    if (c.req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    // Phase 1 安全响应头（nosniff / no-referrer / DENY 嵌入 / CSP），对所有路径生效
    applySecurityHeaders(res);
    await next();
  });

  // ── 3. 健康检查（免认证：部署探针无凭据可达；只回版本/布尔值，无路径与 Key）──
  // 平移前位于 lifecycle 门禁之前，且 beginRequest 不计数（tracked=false 只记指标）。
  app.get("/healthz", async (c) => {
    await handleHealthz(c.env.outgoing);
    return alreadySent();
  });
  app.get("/readyz", async (c) => {
    await handleReadyz(c.env.outgoing);
    return alreadySent();
  });

  // ── 4. 优雅退出门禁：不再接新业务（探针除外），明确 503 ──
  app.use("*", async (c, next) => {
    if (!lifecycle.beginRequest()) {
      const res = c.env.outgoing;
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
      res.end(JSON.stringify({ error: "服务正在关闭，请稍后重试" }));
      log("warn", "request_rejected", { requestId: c.get("requestLog").requestId, method: c.env.incoming.method, path: c.req.path });
      return alreadySent();
    }
    c.get("requestLog").tracked = true;
    incGauge("agent_http_inflight_requests");
    await next();
  });

  // ── 5. 同源检查（仅 /api/*；登录页也必须只允许从本站发起）──
  app.use("/api/*", rawGate((req, res) => {
    const originReject = checkSameOrigin(req);
    if (originReject) { respondForbidden(req, res, originReject); return false; }
    return true;
  }));

  // ── 6. 设备身份：认证端点前解析身份，其余端点直接换静默会话 ──
  app.use("/api/*", rawGate((req, res, pathname) => {
    if (pathname.startsWith("/api/auth/")) ensureDeviceIdentity(req, res);
    else ensureDeviceSession(req, res);
    return true;
  }));

  // ── 7. 认证端点（豁免 verifyRequestAuth：登录/续期/注销/密码锁自身不能要求已登录）──
  const raw = (handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void) =>
    async (c: { env: { incoming: IncomingMessage; outgoing: ServerResponse } }) => {
      await handler(c.env.incoming, c.env.outgoing);
      return alreadySent();
    };
  app.get("/api/auth/session", raw(handleAuthStatus));
  app.post("/api/auth/session", raw(handleAuthLogin));
  app.post("/api/auth/session/renew", raw(handleAuthRenew));
  app.post("/api/auth/logout", raw(handleAuthLogout));
  // 用户名密码登录（U1）与自助改密；登录入口必须在凭据纪元门禁之前。
  app.post("/api/auth/login", raw(handlePasswordLogin));
  app.get("/api/auth/me", raw(handleAuthMe));
  app.post("/api/auth/password", raw(handleAuthPassword));
  // 本地访问密码锁（U3，仅文件模式）
  app.get("/api/auth/local-lock", raw(handleLocalLockStatus));
  app.post("/api/auth/local-lock", raw(handleSetLocalLock));
  app.delete("/api/auth/local-lock", raw(handleClearLocalLock));

  // ── 8. Prometheus 指标（不是 /api/*，但同样需要认证；静态页匿名无法读取）──
  app.get("/metrics", async (c) => {
    const req = c.env.incoming;
    const res = c.env.outgoing;
    if (!verifyMetricsAuth(req)) {
      const decision = authFailureLimiter.recordFailure(clientIp(req));
      if (!decision.allowed) {
        res.writeHead(429, { "Content-Type": "application/json; charset=utf-8", "Retry-After": String(decision.retryAfterSeconds) });
        res.end(JSON.stringify({ error: `认证失败次数过多，请在 ${decision.retryAfterSeconds} 秒后重试` }));
      } else {
        respondUnauthorized(req, res);
      }
      return alreadySent();
    }
    handleMetrics(res);
    return alreadySent();
  });

  // ── 9. 认证门禁：除认证端点、静态页与探针外，全部 /api/* 都需要有效会话 Cookie ──
  app.use("/api/*", async (c, next) => {
    const req = c.env.incoming;
    const res = c.env.outgoing;
    if (verifyRequestAuth(req)) { await next(); return; }
    const ip = clientIp(req);
    const decision = authFailureLimiter.recordFailure(ip);
    writeAudit("auth_rejected", { requestId: c.get("requestLog").requestId, method: req.method, path: c.req.path });
    if (!decision.allowed) {
      res.writeHead(429, {
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": String(decision.retryAfterSeconds),
      });
      res.end(JSON.stringify({ error: `认证失败次数过多，请在 ${decision.retryAfterSeconds} 秒后重试` }));
    } else {
      respondUnauthorized(req, res);
    }
    return alreadySent();
  });

  // ── 10. 旧 Bearer 兼容：脚本请求也必须获得稳定的设备归属 ──
  app.use("/api/*", rawGate((req, res) => {
    adoptBearerIdentity(req, res);
    return true;
  }));

  // ── 11. 凭据纪元门禁（U1）：改密后旧会话/旧设备静默会话 401，强制重登 ──
  app.use("/api/*", rawGate((req, res) => assertFreshCredentials(req, res)));

  // ── 12. 用户上下文：数据库 RLS、文件授权和记忆 scope 都从这里取用户 ──
  app.use("/api/*", rawGate(async (req, res, pathname) => {
    if (pathname.startsWith("/api/auth/")) return true;
    const identity = userIdentityForRequest(req);
    if (isPostgresBackend() && !identity) {
      respondUnauthorized(req, res);
      return false;
    }
    const context = identity
      ? { userId: identity.userId, deviceId: identity.deviceId, role: identity.role }
      : localUserContext();
    enterUserContext(context);
    if (isPostgresBackend()) await ensureUserSessions(context.userId);
    if (isPostgresBackend()) await ensureProjectsLoaded(context.userId);
    return true;
  }));

  // ── 13. 首登强制改密（U1）：除 /api/auth/* 外全部 403 ──
  app.use("/api/*", rawGate((req, res, pathname) => assertPasswordChangeAllowed(req, res, pathname)));

  // ── 14. 管理员门禁（仅 pg 后端）──
  app.use("/api/*", rawGate((req, res, pathname) => {
    if (!isPostgresBackend() || !isAdminOnlyApi(pathname, req.method) || isAdminRequest(req)) return true;
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "该配置仅管理员可操作", code: "admin_required" }));
    return false;
  }));

  // ── 15. Phase 0 止血：非 loopback 且未认证 → 所有写请求拒绝（方法级防线）──
  app.use("*", rawGate((req, res) => {
    if (!(!LOOPBACK_HOST && !AUTH_ENABLED && req.method !== "GET" && req.method !== "HEAD")) return true;
    // authRequired=true：提示设置 AUTH_TOKEN 后携带 Bearer 即可放开
    respondForbidden(req, res, EXPOSED_NOAUTH_ERR, true);
    return false;
  }));

  // ── 15b. M2 批次 1（探针与运维）：原生挂载；dispatch.ts 对应分支已摘除 ──
  // 均无请求体：直接复用既有 handler（写原生 res）。认证/管理员门禁由上方中间件覆盖。
  // handleVersion / handleDiagnostics 只收 res：单独 lambda 标注参数序
  app.get("/api/version", async (c) => { handleVersion(c.env.outgoing); return alreadySent(); });
  app.get("/api/diagnostics", async (c) => { await handleDiagnostics(c.env.outgoing); return alreadySent(); });
  app.get("/api/stats", async (c) => {
    // handleStats 的参数序是 (res, req)，与 raw() 的 (req, res) 相反，单独写清楚
    await handleStats(c.env.outgoing, c.env.incoming);
    return alreadySent();
  });
  app.post("/api/client-errors", async (c) => {
    await handleClientError(c.env.incoming, c.env.outgoing, c.get("requestLog").requestId);
    return alreadySent();
  });

  // ── 15c. M2 批次 3（模型配置域）：原生挂载；dispatch.ts 对应分支已摘除 ──
  // jsonRaw：路由层统一 readBody + JSON.parse（413 / SyntaxError 语义不变，经 app.onError），
  // handler 用 parsedJsonOf(req) 取解析值。服务层（settings-crud）仍是带测试的中文校验边界，
  // 路由层不重复 schema，避免消息漂移；zod schema 化随服务层校验合并推进（agent-wiki M2 记录）。
  const jsonRawFor = (maxBytes?: number): MiddlewareHandler<AppEnv> => async (c, next) => {
    // 路由层统一 readBody + JSON.parse（413 / SyntaxError 语义不变，经 app.onError）
    const rawBody = await readBody(c.env.incoming, maxBytes);
    cacheParsedJson(c.env.incoming, JSON.parse(rawBody || "{}"));
    await next();
  };
  const jsonRaw = jsonRawFor();
  // config 域 handler 的参数序是 (res, req[, id, mid])，与 raw() 的 (req, res) 相反，全部用 lambda 显式写。
  const withBody = (fn: (c: AppContext) => Promise<void>) => async (c: AppContext) => {
    await fn(c);
    return alreadySent();
  };
  app.get("/api/config", withBody(async (c) => { await handleGetApiConfig(c.env.outgoing); }));
  app.post("/api/config/providers", jsonRaw, withBody(async (c) => { await handleAddProvider(c.env.outgoing, c.env.incoming); }));
  app.post("/api/config/providers/:id", jsonRaw, withBody(async (c) => { await handleUpdateProvider(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.delete("/api/config/providers/:id", withBody(async (c) => { await handleDeleteProvider(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.post("/api/config/providers/:id/models", jsonRaw, withBody(async (c) => { await handleAddModel(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.post("/api/config/providers/:id/models/:mid", jsonRaw, withBody(async (c) => { await handleUpdateModel(c.env.outgoing, c.env.incoming, c.req.param("id") as string, c.req.param("mid") as string); }));
  app.delete("/api/config/providers/:id/models/:mid", withBody(async (c) => { await handleDeleteModel(c.env.outgoing, c.env.incoming, c.req.param("id") as string, c.req.param("mid") as string); }));
  app.post("/api/config/reasoning", jsonRaw, withBody(async (c) => { await handleSetReasoning(c.env.outgoing, c.env.incoming); }));
  app.post("/api/config/activate", jsonRaw, withBody(async (c) => { await handleActivate(c.env.outgoing, c.env.incoming); }));
  app.post("/api/models", jsonRaw, withBody(async (c) => { await handleModels(c.env.outgoing, c.env.incoming); }));
  app.get("/api/tracing", withBody(async (c) => { handleGetTracing(c.env.outgoing); }));
  app.put("/api/tracing", jsonRaw, withBody(async (c) => { await handleSaveTracing(c.env.outgoing, c.env.incoming); }));

  // ── 15d. M2 批次 4（记忆域）：原生挂载；dispatch.ts 对应分支已摘除 ──
  // 校验边界在 memory-slot / memory-config 服务层（同批 3 理由，路由层不重复 schema）。
  // 查询参数 profileId / history 与平移前 searchParams 语义一致（缺失 = 默认 general）。
  app.get("/api/memory/config", withBody(async (c) => { await handleGetMemoryConfig(c.env.outgoing); }));
  app.put("/api/memory/config", jsonRaw, withBody(async (c) => { await handleUpdateMemoryConfig(c.env.outgoing, c.env.incoming); }));
  app.post("/api/memory/test", jsonRaw, withBody(async (c) => { await handleTestMemory(c.env.outgoing, c.env.incoming); }));
  app.post("/api/memory/embedding/test", jsonRaw, withBody(async (c) => { await handleTestEmbeddingMemory(c.env.outgoing, c.env.incoming); }));
  app.post("/api/memory/reindex", jsonRaw, withBody(async (c) => { await handleReindexMemory(c.env.outgoing, c.env.incoming); }));
  app.get("/api/memory/status", withBody(async (c) => { await handleMemoryStatus(c.env.outgoing, c.req.query("profileId")); }));
  app.get("/api/memories", withBody(async (c) => { await handleListMemories(c.env.outgoing, c.req.query("profileId"), c.req.query("history") === "1"); }));
  app.get("/api/memories/candidates", withBody(async (c) => { await handleListMemoryCandidates(c.env.outgoing, c.req.query("profileId")); }));
  app.get("/api/memories/export", withBody(async (c) => { await handleExportMemories(c.env.outgoing, c.req.query("profileId"), c.req.query("history") === "1"); }));
  app.post("/api/memories/import", jsonRaw, withBody(async (c) => { await handleImportMemories(c.env.outgoing, c.env.incoming); }));
  app.post("/api/memories/:id/confirm", withBody(async (c) => { await handleConfirmMemory(c.env.outgoing, c.req.param("id") as string, c.req.query("profileId")); }));
  app.post("/api/memories/:id/reject", withBody(async (c) => { await handleRejectMemory(c.env.outgoing, c.req.param("id") as string, c.req.query("profileId")); }));
  app.delete("/api/memories/:id", withBody(async (c) => { await handleDeleteMemory(c.env.outgoing, c.req.param("id") as string, c.req.query("profileId")); }));

  // ── 15e. M2 批次 5（内容管理：命令 / 技能 / MCP）：原生挂载；dispatch 分支已摘除 ──
  // 技能 id 允许 "/"（含子目录），Hono 用 :id{.+} 通配参数；静态段（/api/skills/import）
  // 必须先于通配参数注册。MCP 写路由在 handler 后仍接 refreshMcpTools(true)（平移前语义）。
  app.get("/api/commands", withBody(async (c) => { await handleListCommands(c.env.outgoing); }));
  app.post("/api/commands", jsonRaw, withBody(async (c) => { await handleSaveCommand(c.env.outgoing, c.env.incoming); }));
  app.put("/api/commands/:id", jsonRaw, withBody(async (c) => { await handleUpdateCommand(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.delete("/api/commands/:id", withBody(async (c) => { await handleDeleteCommand(c.env.outgoing, c.req.param("id") as string); }));
  app.get("/api/skills", withBody(async (c) => { await handleListSkills(c.env.outgoing); }));
  app.post("/api/skills", jsonRaw, withBody(async (c) => { await handleSaveSkill(c.env.outgoing, c.env.incoming); }));
  app.post("/api/skills/import", jsonRaw, withBody(async (c) => { await handleImportSkills(c.env.outgoing, c.env.incoming); }));
  app.patch("/api/skills/:id{.+}", jsonRaw, withBody(async (c) => { await handleSetSkillEnabled(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.delete("/api/skills/:id{.+}", withBody(async (c) => { await handleDeleteSkill(c.env.outgoing, c.req.param("id") as string); }));
  app.get("/api/mcp", withBody(async (c) => { await handleListMcp(c.env.outgoing); }));
  app.post("/api/mcp", jsonRaw, withBody(async (c) => { await handleSaveMcp(c.env.outgoing, c.env.incoming); await refreshMcpTools(true); }));
  app.patch("/api/mcp", jsonRaw, withBody(async (c) => { await handleSetMcpEnabled(c.env.outgoing, c.env.incoming); await refreshMcpTools(true); }));
  app.post("/api/mcp/import", jsonRaw, withBody(async (c) => { await handleImportMcp(c.env.outgoing, c.env.incoming); await refreshMcpTools(true); }));
  app.post("/api/mcp/:id/test", withBody(async (c) => { await handleTestMcp(c.env.outgoing, c.req.param("id") as string); }));
  app.patch("/api/mcp/:id", jsonRaw, withBody(async (c) => { await handleUpdateMcp(c.env.outgoing, c.env.incoming, c.req.param("id") as string); await refreshMcpTools(true); }));
  app.delete("/api/mcp/:id", withBody(async (c) => { await handleDeleteMcp(c.env.outgoing, c.req.param("id") as string); await refreshMcpTools(true); }));

  // ── 15f. M2 批次 6（会话管理）：原生挂载；dispatch 分支已摘除 ──
  // cleanup 静态段必须先于 :id 注册（/api/sessions/cleanup 不能被当成会话 id）。
  // GET/POST /api/sessions 共用一个 handler（内部按 method 分支），签名 (res, req)。
  app.get("/api/sessions", withBody(async (c) => { await handleSessions(c.env.outgoing, c.env.incoming); }));
  app.post("/api/sessions", jsonRaw, withBody(async (c) => { await handleSessions(c.env.outgoing, c.env.incoming); }));
  app.post("/api/sessions/cleanup", jsonRaw, withBody(async (c) => { await handleCleanupSessions(c.env.outgoing, c.env.incoming); }));
  app.delete("/api/sessions/:id", withBody(async (c) => { await handleDeleteSession(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.post("/api/sessions/:id/compact", jsonRaw, withBody(async (c) => { await handleCompactSession(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.post("/api/sessions/:id/permission", jsonRaw, withBody(async (c) => { await handleSessionPermission(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.get("/api/sessions/:id/transcript", withBody(async (c) => { await handleTranscript(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.get("/api/sessions/:id/export", withBody(async (c) => { await handleExportSession(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));

  // ── 15g. M2 批次 7a（插件 / 路由决策 / 子代理）：原生挂载；dispatch 分支已摘除 ──
  app.get("/api/plugins", withBody(async (c) => { handleListPlugins(c.env.outgoing); }));
  app.patch("/api/plugins/:id", jsonRaw, withBody(async (c) => { await handleSetPluginEnabled(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.get("/api/routing", withBody(async (c) => { handleGetRouting(c.env.outgoing); }));
  app.put("/api/routing", jsonRaw, withBody(async (c) => { await handleSaveRouting(c.env.outgoing, c.env.incoming); }));
  app.post("/api/routing/test", jsonRaw, withBody(async (c) => { await handleTestRouting(c.env.outgoing, c.env.incoming); }));
  app.get("/api/subagents", withBody(async (c) => { handleListSubagents(c.env.outgoing); }));
  app.post("/api/subagents", jsonRaw, withBody(async (c) => { await handleCreateSubagent(c.env.outgoing, c.env.incoming); }));
  app.patch("/api/subagents/:id", jsonRaw, withBody(async (c) => { await handleUpdateSubagent(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.delete("/api/subagents/:id", withBody(async (c) => { await handleDeleteSubagent(c.env.outgoing, c.req.param("id") as string); }));

  // ── 15h. M2 批次 7b（备份恢复 + 用户管理）：原生挂载；dispatch 分支已摘除 ──
  // users 系列 handler 参数序是 (req, res)，与 raw() 相反，全部 lambda 显式写。
  app.post("/api/backup", withBody(async (c) => { await handleCreateBackup(c.env.outgoing); }));
  app.get("/api/backup", withBody(async (c) => { await handleListBackups(c.env.outgoing); }));
  app.post("/api/restore", jsonRaw, withBody(async (c) => { await handleRestoreBackup(c.env.outgoing, c.env.incoming); }));
  app.get("/api/users", withBody(async (c) => { await handleListUsers(c.env.outgoing); }));
  app.post("/api/users", jsonRaw, withBody(async (c) => { await handleCreateUser(c.env.incoming, c.env.outgoing); }));
  app.patch("/api/users/:id", jsonRaw, withBody(async (c) => { await handleUpdateUser(c.env.incoming, c.env.outgoing, c.req.param("id") as string); }));
  app.delete("/api/users/:id", withBody(async (c) => { await handleDeleteUser(c.env.incoming, c.env.outgoing, c.req.param("id") as string); }));
  app.post("/api/users/:id/reset-password", withBody(async (c) => { await handleResetUserPassword(c.env.incoming, c.env.outgoing, c.req.param("id") as string); }));
  app.get("/api/users/:id/tokens", withBody(async (c) => { await handleListUserTokens(c.env.outgoing, c.req.param("id") as string); }));
  app.post("/api/users/:id/tokens", jsonRaw, withBody(async (c) => { await handleCreateUserToken(c.env.incoming, c.env.outgoing, c.req.param("id") as string); }));
  app.delete("/api/users/:id/tokens/:tokenId", withBody(async (c) => { await handleRevokeUserToken(c.env.incoming, c.env.outgoing, c.req.param("id") as string, c.req.param("tokenId") as string); }));

  // ── 15i. M2 批次 8（项目与文件）：原生挂载；dispatch 分支已摘除 ──
  // upload 用放宽的 12MB 上限（jsonRawFor(12_000_000)），与平移前 readBody(req, 12MB) 一致。
  app.get("/api/projects", withBody(async (c) => { await handleListProjects(c.env.outgoing); }));
  app.post("/api/projects", jsonRaw, withBody(async (c) => { await handleAddProject(c.env.outgoing, c.env.incoming); }));
  app.post("/api/projects/pick-directory", withBody(async (c) => { await handlePickProjectDirectory(c.env.outgoing, c.env.incoming); }));
  app.post("/api/projects/active", jsonRaw, withBody(async (c) => { await handleSetActiveProject(c.env.outgoing, c.env.incoming); }));
  app.delete("/api/projects/:id", withBody(async (c) => { await handleDeleteProject(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.post("/api/projects/:id/refresh", withBody(async (c) => { await handleRefreshProject(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.post("/api/fs/list", jsonRaw, withBody(async (c) => { await handleFsList(c.env.outgoing, c.env.incoming); }));
  app.post("/api/fs/search", jsonRaw, withBody(async (c) => { await handleFsSearch(c.env.outgoing, c.env.incoming); }));
  app.post("/api/fs/read", jsonRaw, withBody(async (c) => { await handleFsRead(c.env.outgoing, c.env.incoming); }));
  app.post("/api/fs/open-remote", jsonRaw, withBody(async (c) => { await handleFsOpenRemote(c.env.outgoing, c.env.incoming); }));
  app.post("/api/files/upload", jsonRawFor(12_000_000), withBody(async (c) => { await handleUpload(c.env.outgoing, c.env.incoming); }));

  // ── 15j. M2 批次 9a（RAG 外部知识库）：原生挂载；dispatch 分支已摘除 ──
  app.get("/api/rag", withBody(async (c) => { await handleGetRag(c.env.outgoing); }));
  app.post("/api/rag/config", jsonRaw, withBody(async (c) => { await handleSaveRagConfig(c.env.outgoing, c.env.incoming); }));
  app.post("/api/rag/test", jsonRaw, withBody(async (c) => { await handleTestRag(c.env.outgoing, c.env.incoming); }));
  app.post("/api/rag/ingest", jsonRaw, withBody(async (c) => { await handleIngest(c.env.outgoing, c.env.incoming); }));
  app.post("/api/rag/search", jsonRaw, withBody(async (c) => { await handleRagSearch(c.env.outgoing, c.env.incoming); }));
  app.delete("/api/rag/docs/:id", withBody(async (c) => { await handleDeleteRagDoc(c.env.outgoing, c.env.incoming, c.req.param("id") as string); }));
  app.post("/api/rag/clear", jsonRaw, withBody(async (c) => { await handleClearRag(c.env.outgoing, c.env.incoming); }));

  // ── 15k. M2 批次 9b（房产 / 求职 / Browser Use）：原生挂载；dispatch 分支已摘除 ──
  // browser 会话守卫逐字平移：Hono param 已做 URI 解码（旧链路 decodeURIComponent 等价），
  // 字符集与设备归属校验保留；失败直写原生 res。
  const guardBrowserSession = (c: AppContext): string | Response => {
    const sessionId = c.req.param("id") as string;
    const res = c.env.outgoing;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "浏览器会话 id 格式非法" }));
      return alreadySent();
    }
    const userId = requireDeviceIdentity(c.env.incoming, res);
    if (!userId) return alreadySent();
    if (!getSessionByThreadForUser(sessionId, userId)) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Browser Use 会话不存在或不属于当前设备" }));
      return alreadySent();
    }
    return sessionId;
  };
  const guarded = (fn: (c: AppContext, sessionId: string) => Promise<void>) => async (c: AppContext) => {
    const sessionId = guardBrowserSession(c);
    if (typeof sessionId !== "string") return sessionId;
    await fn(c, sessionId);
    return alreadySent();
  };
  app.get("/api/estate", withBody(async (c) => { await handleGetEstate(c.env.outgoing); }));
  app.get("/api/estate/exports/:exportId", withBody(async (c) => { await handleEstateExport(c.env.outgoing, c.req.param("exportId") as string); }));
  app.post("/api/estate/install", jsonRaw, withBody(async (c) => { await handleInstallBeike(c.env.outgoing, c.env.incoming); }));
  app.post("/api/estate/login", jsonRaw, withBody(async (c) => { await handleStartBeikeLogin(c.env.outgoing, c.env.incoming); }));
  app.post("/api/estate/key", jsonRaw, withBody(async (c) => { await handleSaveBeikeKey(c.env.outgoing, c.env.incoming); }));
  app.get("/api/job", withBody(async (c) => { await handleGetJob(c.env.outgoing); }));
  app.put("/api/job", jsonRaw, withBody(async (c) => { await handleSaveJob(c.env.outgoing, c.env.incoming); }));
  app.post("/api/job/login", jsonRaw, withBody(async (c) => { await handleJobLogin(c.env.outgoing, c.env.incoming); }));
  app.post("/api/job/doctor", jsonRaw, withBody(async (c) => { await handleJobDoctor(c.env.outgoing, c.env.incoming); }));
  app.post("/api/job/diagnose", jsonRaw, withBody(async (c) => { await handleJobDiagnose(c.env.outgoing, c.env.incoming); }));
  app.get("/api/browser/status", withBody(async (c) => { handleBrowserStatus(c.env.outgoing); }));
  app.get("/api/browser/sessions/:id", guarded(async (c, sessionId) => { handleBrowserState(c.env.outgoing, sessionId); }));
  app.get("/api/browser/sessions/:id/screenshot", guarded(async (c, sessionId) => { handleBrowserScreenshot(c.env.outgoing, sessionId); }));
  app.post("/api/browser/sessions/:id", jsonRaw, guarded(async (c, sessionId) => { await handleBrowserClose(c.env.outgoing, c.env.incoming, sessionId); }));

  // ── 16. 兜底分发：GET 非 /api 走静态文件；其余原样透传 legacy 顺序分发 ──
  app.all("*", async (c) => {
    const req = c.env.incoming;
    const res = c.env.outgoing;
    const pathname = c.req.path;
    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      if (await serveStatic(pathname, res)) return alreadySent();
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return alreadySent();
    }
    await dispatchApi(req, res, { requestId: c.get("requestLog").requestId, sessionId: c.get("requestLog").sessionId });
    return alreadySent();
  });

  return app;
}

