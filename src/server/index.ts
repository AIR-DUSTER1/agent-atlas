/**
 * ============================================================
 * index.ts — Agent Web 进程入口（框架迁移 M1 起只管启动顺序 / 监听 / 优雅退出；请求处理在 app.ts）
 * ============================================================
 * 职责（按平移前 index.ts 的启动序列原样保留，一行未改语义）：
 *   1. --check-production 发布自检短路与生产门禁；
 *   2. initializePostgres / ensureBootstrapAdmin / 迁移 / 会话与检查点回放；
 *   3. createAdaptorServer(app.fetch) 组装 Hono 外壳并监听（PORT / HOST 见 http-context.ts）；
 *   4. 优雅退出：SIGINT/SIGTERM → 通知 SSE → 等在途请求 → flush journal/audit → 退出码。
 * 请求处理（横切门禁 + 路由分发）见 app.ts 与 dispatch.ts；SSE 数据帧契约不变
 * （每行 `data: {"type":"token","text":"..."}` + 空行），客户端断开仍走 AbortSignal 取消图流。
 */
import { config } from "../config.js";
import { PRODUCT_NAME } from "../product.js";
import { bumpConfigVersion, restoreSessions } from "./sessions.js";
import { loadTraceSettings } from "./trace-settings.js";
import { loadSettings, refreshModelInfo } from "./settings.js";
import { ensureProjectsLoaded, loadProjects } from "./projects.js";
import { loadExternalAgents } from "./external.js";
import { loadRag } from "./rag.js";
import { isRagConfigured } from "./rag.js";
import { loadEstate } from "./estate.js";
import { loadPluginSettings } from "./plugin-settings.js";
import { loadSubagentSettings } from "./subagent-settings.js";
import { configureRoutingVectorProbe, loadRoutingSettings } from "./routing-settings.js";
import { createRagVectorFinder, syncRoutingIndex } from "./routing-vector.js";
import { handleGetRouting, handleSaveRouting, handleTestRouting } from "./routes/routing.js";
import { handleGetTracing, handleSaveTracing } from "./routes/tracing.js";
import { configureRoutingBreaker, configureRoutingVectorFinder } from "../routing/state.js";
import { CircuitBreaker } from "./runtime/circuit-breaker.js";
import { isAuthEnabled, verifyMetricsAuth, verifyRequestAuth } from "./auth.js";
import { adoptBearerIdentity, ensureDeviceIdentity, ensureDeviceSession, requireDeviceIdentity, isAdminRequest } from "./security/device.js";
import { userIdentityForRequest } from "./security/device.js";
import { initializePostgres, closePostgres, isPostgresBackend } from "./persistence/postgres.js";
import { ensureBootstrapAdmin } from "./persistence/accounts.js";
import { enterUserContext, localUserContext } from "./user-context.js";
import { applySecurityHeaders, checkSameOrigin, respondForbidden, respondUnauthorized } from "./http-guard.js";
import { readBody, respondBadRequest, BodyTooLargeError } from "./http-body.js";
import { serveStatic } from "./static.js";
import { handleHealthz, handleReadyz } from "./health.js";
import { lifecycle } from "./lifecycle.js";
import { startParentWatchdog } from "./parent-watchdog.js";
import { auditFilePath, flushAudit, writeAudit } from "./audit.js";
import { flushJournal, journalPath } from "./session-store.js";
import { checkpointFilePath, flushCheckpointLog } from "../checkpoint.js";
import { loadMemories, memoryStoreDir, flushMemoryUsage } from "../memory-store.js";
import { log, newRequestId } from "./logging.js";
import { SETTINGS_FILE } from "./config-store.js";
import { BUILD_INFO } from "./build-info.js";
import { assertProductionEnvironment, assertProductionRuntimeReady, isProductionMode } from "./production.js";
import { hasLocalLock } from "./security/local-lock.js";
import { collectProductionReleaseChecks, failedReleaseChecks } from "./release-check.js";
import { authFailureLimiter, clientIp } from "./security/rate-limit.js";
import { incCounter, incGauge, metricPath, observeHistogram, startProcessMetrics } from "./observability/metrics.js";
import { handleClientError, handleDiagnostics, handleMetrics, handleVersion } from "./routes/observability.js";
import { runPersistenceMigrations } from "./persistence/migrations.js";
import { applyMemoryRuntime } from "./memory-http.js";
import { installMemoryMetricsSink } from "./memory-observability.js";
import { startMemoryMaintenance, stopMemoryMaintenance } from "./memory-maintenance.js";
import {
  assertFreshCredentials, assertPasswordChangeAllowed, handleAuthLogin, handleAuthLogout,
  handleAuthMe, handleAuthPassword, handleAuthRenew, handleAuthStatus, handleClearLocalLock,
  handleLocalLockStatus, handlePasswordLogin, handleSetLocalLock,
} from "./routes/auth.js";
import { handleChat, handleResume } from "./routes/chat.js";
import {
  handleGetApiConfig, handleAddProvider, handleAddModel, handleUpdateModel, handleDeleteModel,
  handleSetReasoning, handleUpdateProvider, handleDeleteProvider, handleActivate, handleModels,
} from "./routes/config.js";
import { handleStaticMap } from "./map-static.js";
import { handleSessions, handleDeleteSession, handleTranscript, handleCompactSession, handleSessionPermission, handleExportSession, handleCleanupSessions } from "./routes/sessions.js";
import { handleListExternalAgents, handleAddExternalAgent, handleUpdateExternalAgent, handleDeleteExternalAgent } from "./routes/external.js";
import { handleListProjects, handleAddProject, handleSetActiveProject, handleDeleteProject, handleRefreshProject, handlePickProjectDirectory } from "./routes/projects.js";
import { handleFsList, handleFsSearch, handleFsRead, handleFsOpenRemote, handleUpload } from "./routes/files.js";
import { handleGetRag, handleSaveRagConfig, handleTestRag, handleIngest, handleRagSearch, handleDeleteRagDoc, handleClearRag } from "./routes/rag.js";
import {
  handleListMemories, handleDeleteMemory, handleExportMemories, handleImportMemories,
  handleListMemoryCandidates, handleConfirmMemory, handleRejectMemory,
} from "./routes/memories.js";
import {
  handleGetMemoryConfig, handleUpdateMemoryConfig, handleTestMemory, handleMemoryStatus,
  handleTestEmbeddingMemory, handleReindexMemory,
} from "./routes/memory.js";
import { handleStats } from "./routes/stats.js";
import { handleCreateBackup, handleListBackups, handleRestoreBackup } from "./routes/backup.js";
import { handleEstateExport, handleGetEstate, handleInstallBeike, handleSaveBeikeKey, handleStartBeikeLogin } from "./routes/estate.js";
import { handleGetJob, handleJobDiagnose, handleJobDoctor, handleJobLogin, handleSaveJob } from "./routes/job.js";
import {
  handleBrowserClose, handleBrowserScreenshot, handleBrowserState, handleBrowserStatus,
} from "./routes/browser-use.js";
import { loadJob } from "./job.js";
import { closeAllBrowserSessions } from "./browser-use.js";
import { handleListPlugins, handleSetPluginEnabled } from "./routes/plugins.js";
import {
  handleCreateUser, handleCreateUserToken, handleDeleteUser, handleListUserTokens,
  handleListUsers, handleResetUserPassword, handleRevokeUserToken, handleUpdateUser,
} from "./routes/users.js";
import {
  handleCreateSubagent,
  handleDeleteSubagent,
  handleListSubagents,
  handleUpdateSubagent,
} from "./routes/subagents.js";
import { handleListCommands, handleSaveCommand, handleUpdateCommand, handleDeleteCommand } from "./routes/commands.js";
import { handleListSkills, handleSaveSkill, handleDeleteSkill, handleImportSkills, handleSetSkillEnabled } from "./routes/skills.js";
import {
  handleListMcp, handleSaveMcp, handleDeleteMcp, handleTestMcp, handleImportMcp, handleSetMcpEnabled, handleUpdateMcp,
} from "./routes/mcp.js";
import { disconnectAll } from "./mcp.js";
import { loadMcpTools, mcpApprovalDescriptions } from "./mcp-tools.js";
import { createAdaptorServer } from "@hono/node-server";
import { createApp } from "./app.js";
import { refreshMcpTools } from "./mcp-refresh.js";
import { AUTH_ENABLED, HOST, PORT } from "./http-context.js";

// 生产镜像自检：必须在迁移、加载用户配置和监听端口之前完成。
// 该分支只输出结构化结果；任何失败都以非 0 退出，避免坏镜像被编排器上线。
if (process.argv.includes("--check-production")) {
  const checks = await collectProductionReleaseChecks();
  const failures = failedReleaseChecks(checks);
  const report = { ok: failures.length === 0, check: "production-release", checks };
  await new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify(report) + "\n", () => resolve());
  });
  process.exit(failures.length === 0 ? 0 : 1);
}


/** 生产门禁失败：只输出结构化日志，写回 stdout 后以 1 退出。 */
async function stopForStartup(err: unknown): Promise<never> {
  log("error", "startup_check_failed", {
    message: err instanceof Error ? err.message : String(err),
  });
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(1);
}

try {
  assertProductionEnvironment();
} catch (err) {
  await stopForStartup(err);
}

// 启动顺序：版本迁移 → 设置/扩展加载 → 生产门禁 → journal 回放。
try {
  await initializePostgres();
  await ensureBootstrapAdmin();
  await runPersistenceMigrations();
  await loadSettings();
  await loadTraceSettings();
  await loadSubagentSettings();
  await assertProductionRuntimeReady({
    apiKey: config.apiKey,
    dataFiles: [SETTINGS_FILE, journalPath(), checkpointFilePath(), memoryStoreDir(), auditFilePath()],
  });
  await loadProjects();
  await loadExternalAgents();
  await loadRag();
  await loadEstate();
  await loadJob();
  await loadPluginSettings();
  // F1：跨会话长期记忆先预热本地文件，再按配置注册 / 激活本地或 HTTP Provider。
  await loadMemories();
  installMemoryMetricsSink();
  await applyMemoryRuntime();
  startMemoryMaintenance();
  // MCP：启动时连接已配置的 server 并把工具注入 general profile。
  // 单个 server 连不上只记日志并跳过，不能让整个服务起不来。
  await refreshMcpTools();
  // 路由：配置镜像 + 向量层注入。RAG 未配置时 createRagVectorFinder 返回 null，
  // 整层不存在（R4：没配 RAG 就零网络调用）。
  await loadRoutingSettings();
  configureRoutingVectorProbe(() => isRagConfigured());
  configureRoutingVectorFinder(createRagVectorFinder());
  // systemone 后端的熔断器在 server 层注入；路由层只认最小接口，不 import server。
  configureRoutingBreaker(new CircuitBreaker("routing-systemone", 3, 300_000));
  // 索引重建 best-effort：失败只记日志，规则层照常工作。
  void syncRoutingIndex().catch(() => {});
} catch (err) {
  await stopForStartup(err);
}

// T2-2：journal 回放 —— 重启后恢复会话壳 / 轮次历史 / pending 审批标记
let restoredSessions = 0;
try {
  restoredSessions = await restoreSessions();
} catch (err) {
  await stopForStartup(err);
}
if (restoredSessions > 0) {
  log("info", "sessions_restored", { count: restoredSessions });
  // 人类可读提示只在终端输出；容器/管道场景保持 stdout 纯 NDJSON
  if (process.stdout.isTTY && !isProductionMode()) {
    console.log(`  ↪ 已从 journal 恢复 ${restoredSessions} 个会话（对话历史可回放；带审批挂起的会话将提示重新发起）`);
  }
}
void refreshModelInfo().catch(() => {});

// ---------------------------------------------------------------------------
// HTTP 入口
// ---------------------------------------------------------------------------

const app = createApp();
// createAdaptorServer 走 http1（本项目无 h2 场景）；运行时类型按 http.Server 断言，
// 优雅退出的 closeIdleConnections / closeAllConnections 只在 http.Server 上存在。
const server = createAdaptorServer({
  fetch: app.fetch,
  // 不覆盖全局 Request/Response：领域代码与测试可能依赖全局类型的既有形状
  overrideGlobalObjects: false,
}) as import("node:http").Server;

// ---------------------------------------------------------------------------
// 优雅退出（Phase 4）：停新请求 → 通知 SSE → 等在途 → flush → 退出
// ---------------------------------------------------------------------------
let signalHandled = false;
let stopParentWatchdog: (() => void) | null = null;
function handleSignal(signal: string): void {
  if (stopParentWatchdog) {
    stopParentWatchdog();
    stopParentWatchdog = null;
  }
  // 第二次 Ctrl+C / kill：编排器已等不及，立即退出，不再拖住 drain
  if (signalHandled) {
    log("warn", "shutdown_forced_by_signal", { signal });
    process.exit(1);
  }
  signalHandled = true;
  log("info", "shutdown_signal", { signal });
  void lifecycle.shutdown({
    // 等 close 回调：确保最后几帧（含 SSE shutdown/done）已交给 socket 再退出
    closeServer: () => new Promise<void>((resolve) => server.close(() => resolve())),
    closeIdleConnections: () => server.closeIdleConnections(),
    closeAllConnections: () => server.closeAllConnections(),
    flush: async () => {
      await flushJournal();
      await flushAudit();
      await flushCheckpointLog();
      await flushMemoryUsage();
      stopMemoryMaintenance();
      await closeAllBrowserSessions();
      await disconnectAll(); // 持久检查点的在途追加也等落盘（F0）
      await closePostgres();
    },
    // stdout 接管道时 process.exit 可能截断最后一行日志：等写入回调后再退，
    // 并留一个 1s 的兜底定时器（不 hold 事件循环）
    exit: (code) => {
      process.exitCode = code;
      const fallback = setTimeout(() => process.exit(code), 1_000);
      fallback.unref();
      process.stdout.write("", () => process.exit(code));
    },
  });
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));
// Windows 控制台 Ctrl+Break 对应 SIGBREAK（POSIX 无此信号）
if (process.platform === "win32") process.on("SIGBREAK", () => handleSignal("SIGBREAK"));

// 仅桌面端注入：主进程被系统直接结束时，服务自行走同一条优雅退出链路。
const electronParentPid = Number(process.env.ELECTRON_PARENT_PID ?? "");
if (Number.isInteger(electronParentPid) && electronParentPid > 0) {
  stopParentWatchdog = startParentWatchdog({
    parentPid: electronParentPid,
    onParentGone: () => handleSignal("electron_parent_gone"),
  });
  log("info", "parent_watchdog_started", { parentPid: electronParentPid });
}

server.on("error", (err: NodeJS.ErrnoException) => {
  log("error", "server_listen_failed", { code: err.code, message: err.message, host: HOST, port: PORT });
  if (process.stderr.isTTY && !isProductionMode()) {
    console.error(
      err.code === "EADDRINUSE"
        ? `\n  端口 ${PORT} 已被占用：请设置 PORT=其它端口，或先停掉占用进程。\n`
        : `\n  服务启动失败：${err.message}\n`
    );
  }
  process.exit(1);
});

startProcessMetrics();
server.listen(PORT, HOST, async () => {
  const mode = config.apiKey ? "真实模型" : "模拟模式（未配置 API_KEY）";
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  log("info", "server_start", {
    host: HOST,
    port: PORT,
    authEnabled: AUTH_ENABLED,
    mockMode: !config.apiKey,
    model: config.model,
    version: BUILD_INFO.version,
    channel: BUILD_INFO.channel,
    commit: BUILD_INFO.commit,
    buildId: BUILD_INFO.buildId,
  });
  // 人类可读横幅只在终端输出；容器/管道场景保持 stdout 纯 NDJSON
  if (process.stdout.isTTY && !isProductionMode()) {
    console.log(
      `\n  ${PRODUCT_NAME} Web 已启动\n` +
      `  ➜  http://${displayHost}:${PORT}   (监听 ${HOST}:${PORT})\n` +
      `  模式: ${mode}   模型: ${config.model}   网关: ${config.baseURL}\n` +
      `  提示: 侧栏左下 ⚙ 设置 可在线修改供应商 / API Key / 模型\n`
    );
  }
  // 显式对外开放且未配置认证：日志里必须留痕，终端再给一次醒目提示
  if ((HOST === "0.0.0.0" || HOST === "::") && !AUTH_ENABLED) {
    log("warn", "insecure_bind", { host: HOST });
    if (process.stderr.isTTY) {
      console.warn(
        `  ⚠⚠⚠  HOST=${HOST} 且未配置 AUTH_TOKEN：本服务的接口可以修改配置 / 执行命令 / 消耗网关配额，\n` +
        `  ⚠⚠⚠  当前对局域网所有设备开放。仅限可信内网临时使用，公网场景必须先设置 AUTH_TOKEN。\n`
      );
    }
  }
  // 存储策略自检（用户体系改造 U4）：线上坚持 file 后端必须意识到多用户隔离失效。
  if (isProductionMode() && !isPostgresBackend()) {
    const lockEnabled = await hasLocalLock();
    log("warn", "file_backend_in_production", { localLockEnabled: lockEnabled });
    if (process.stderr.isTTY) {
      const lockHint = lockEnabled
        ? `  ⚠  已启用本地访问密码锁；单用户模式下多用户隔离仍不可用。\n`
        : `  ⚠  尚未设置访问密码锁：任何人拿到地址即可操作本服务，请尽快在设置 → 账号与安全 中开启。\n`;
      console.warn(
        `  ⚠  线上部署检测到文件后端（STATE_BACKEND=file）：建议使用 PostgreSQL 以获得多用户与事务完整性。\n` +
        lockHint
      );
    }
  }
});
