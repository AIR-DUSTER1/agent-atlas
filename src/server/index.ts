/**
 * ============================================================
 * index.ts — Agent Web 服务（零框架：node:http + SSE）
 * ============================================================
 * 为什么不用 Express？
 *   一共 6 个路由 + 静态文件，node:http 足够，学习示例零额外依赖更好读。
 *
 * 路由：
 *   GET  /                  前端页面（public/ 下的静态文件）
 *   GET  /api/config        模型/模式元信息（是否 mock、模型名、供应商×模型清单、思考等级、Demo 清单）
 *   GET  /api/sessions      会话列表
 *   POST /api/sessions      新建会话 { demo }
 *   DELETE /api/sessions/:id 删除会话
 *   POST /api/chat          发消息，SSE 流式返回 AgentEvent
 *   POST /api/resume        Demo 3 审批决定 { sessionId, decision }，SSE 流式返回
 *
 * 设置相关（供应商 × 模型 × 思考等级）：
 *   POST /api/models                              拉取网关模型列表（兼测试连接，带元信息）
 *   POST /api/config/providers                    新增供应商 { name, baseURL, apiKey, protocol, models[] }
 *   POST /api/config/providers/:id                更新供应商（名称 / 网关 / Key / 协议）
 *   DELETE /api/config/providers/:id              删除供应商
 *   POST /api/config/providers/:id/models         给该供应商添加模型（一个供应商可挂多个模型）
 *   POST /api/config/providers/:id/models/:mid    更新单个模型（名称 / 多模态 / 上下文 / 思考等级）
 *   DELETE /api/config/providers/:id/models/:mid  删除单个模型
 *   POST /api/config/activate                     启用「供应商 × 模型」{ providerId, modelId }
 *   POST /api/config/reasoning                    只改思考等级 { providerId?, modelId?, dialect?, level?, custom? }
 *
 * 运维探针（免认证）：
 *   GET /healthz            存活探针（进程/事件循环活着，永不 503）
 *   GET /readyz             就绪探针（配置目录/journal 目录可写且未在关闭中）
 *
 * SSE 数据帧：每行 `data: {"type":"token","text":"..."}` + 空行，与 AgentEvent 一一对应。
 * 客户端断开：通过 AbortSignal 取消图流（模型请求随之中止），保证「停止」按钮可用。
 * Phase 4：每个请求带 X-Request-Id 并记一行 JSON 日志；SIGINT/SIGTERM 走
 * lifecycle 优雅退出（通知 SSE → 等请求 → flush journal/audit → 退出码）。
 */
import { createServer } from "node:http";
import { config } from "../config.js";
import { PRODUCT_NAME } from "../product.js";
import { bumpConfigVersion, restoreSessions } from "./sessions.js";
import { loadSettings, refreshModelInfo } from "./settings.js";
import { loadProjects } from "./projects.js";
import { loadExternalAgents } from "./external.js";
import { loadRag } from "./rag.js";
import { loadEstate } from "./estate.js";
import { loadPluginSettings } from "./plugin-settings.js";
import { loadSubagentSettings } from "./subagent-settings.js";
import { isAuthEnabled, verifyMetricsAuth, verifyRequestAuth } from "./auth.js";
import { applySecurityHeaders, checkSameOrigin, respondForbidden, respondUnauthorized } from "./http-guard.js";
import { readBody, respondBadRequest, BodyTooLargeError } from "./http-body.js";
import { serveStatic } from "./static.js";
import { handleHealthz, handleReadyz } from "./health.js";
import { lifecycle } from "./lifecycle.js";
import { auditFilePath, flushAudit, writeAudit } from "./audit.js";
import { flushJournal, journalPath } from "./session-store.js";
import { checkpointFilePath, flushCheckpointLog } from "../checkpoint.js";
import { loadMemories, memoriesFilePath, flushMemoryUsage } from "../memory-store.js";
import { log, newRequestId } from "./logging.js";
import { SETTINGS_FILE } from "./config-store.js";
import { assertProductionEnvironment, assertProductionRuntimeReady, isProductionMode } from "./production.js";
import { collectProductionReleaseChecks, failedReleaseChecks } from "./release-check.js";
import { authFailureLimiter, clientIp } from "./security/rate-limit.js";
import { incCounter, incGauge, metricPath, observeHistogram, startProcessMetrics } from "./observability/metrics.js";
import { handleClientError, handleDiagnostics, handleMetrics } from "./routes/observability.js";
import { runPersistenceMigrations } from "./persistence/migrations.js";
import { applyMemoryRuntime } from "./memory-http.js";
import { installMemoryMetricsSink } from "./memory-observability.js";
import { handleAuthLogin, handleAuthLogout, handleAuthRenew, handleAuthStatus } from "./routes/auth.js";
import { handleChat, handleResume } from "./routes/chat.js";
import {
  handleGetApiConfig, handleAddProvider, handleAddModel, handleUpdateModel, handleDeleteModel,
  handleSetReasoning, handleUpdateProvider, handleDeleteProvider, handleActivate, handleModels,
} from "./routes/config.js";
import { handleSessions, handleDeleteSession, handleTranscript, handleCompactSession, handleSessionPermission, handleExportSession, handleCleanupSessions } from "./routes/sessions.js";
import { handleListExternalAgents, handleAddExternalAgent, handleUpdateExternalAgent, handleDeleteExternalAgent } from "./routes/external.js";
import { handleListProjects, handleAddProject, handleSetActiveProject, handleDeleteProject, handleRefreshProject, handlePickProjectDirectory } from "./routes/projects.js";
import { handleFsList, handleFsSearch, handleFsRead, handleFsOpenRemote, handleUpload } from "./routes/files.js";
import { handleGetRag, handleSaveRagConfig, handleTestRag, handleIngest, handleRagSearch, handleDeleteRagDoc, handleClearRag } from "./routes/rag.js";
import { handleListMemories, handleSaveMemory, handleDeleteMemory, handleExportMemories, handleImportMemories } from "./routes/memories.js";
import { handleGetMemoryConfig, handleUpdateMemoryConfig, handleTestMemory, handleMemoryStatus } from "./routes/memory.js";
import { handleStats } from "./routes/stats.js";
import { handleCreateBackup, handleListBackups, handleRestoreBackup } from "./routes/backup.js";
import { handleGetEstate, handleInstallBeike, handleSaveBeikeKey } from "./routes/estate.js";
import { handleListPlugins, handleSetPluginEnabled } from "./routes/plugins.js";
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
import { setExternalTools } from "../agent/general.js";
const PORT = Number(process.env.PORT ?? 3000);
/**
 * Phase 0 安全止血：默认只监听 loopback。
 * 本服务无内置认证（Phase 1 才引入 AUTH_TOKEN），接口可以改配置、起子进程、
 * 读服务器文件 —— 绑 0.0.0.0 等于把控制权暴露给局域网。需要显式开放时设置
 * HOST=0.0.0.0（此时若仍未配置认证，参数校验层会拒绝高危操作并输出醒目警告）。
 */
const HOST = process.env.HOST ?? "127.0.0.1";
/** 认证是否已启用（Phase 1：auth.ts 提供判定，本常量用于启动提示与 Phase 0 边界短路） */
const AUTH_ENABLED = isAuthEnabled();

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

/**
 * 重新加载 MCP 工具并注入 general profile。
 * 每次增删 MCP server / 配置变更后调用；单个 server 失败不阻断其它 server。
 */
async function refreshMcpTools(bumpVersion = false): Promise<void> {
  try {
    const [tools, approvals] = await Promise.all([loadMcpTools(), mcpApprovalDescriptions()]);
    setExternalTools(tools, approvals);
    if (bumpVersion) bumpConfigVersion();
    log("info", "mcp_tools_loaded", { count: tools.length });
  } catch (err) {
    // MCP 是增强能力：加载失败只降级，不影响内置工具
    log("warn", "mcp_tools_load_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    setExternalTools([], {});
    if (bumpVersion) bumpConfigVersion();
  }
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
  await runPersistenceMigrations();
  await loadSettings();
  await loadSubagentSettings();
  await assertProductionRuntimeReady({
    apiKey: config.apiKey,
    dataFiles: [SETTINGS_FILE, journalPath(), checkpointFilePath(), memoriesFilePath(), auditFilePath()],
  });
  await loadProjects();
  await loadExternalAgents();
  await loadRag();
  await loadEstate();
  await loadPluginSettings();
  // F1：跨会话长期记忆先预热本地文件，再按配置注册 / 激活本地或 HTTP Provider。
  await loadMemories();
  installMemoryMetricsSink();
  await applyMemoryRuntime();
  // MCP：启动时连接已配置的 server 并把工具注入 general profile。
  // 单个 server 连不上只记日志并跳过，不能让整个服务起不来。
  await refreshMcpTools();
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
/** 服务是否绑定在 loopback 上（HOST=0.0.0.0 / :: 之外的地址都视为仅本机可用） */
const LOOPBACK_HOST = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
/** 未认证 + 对外开放模式下统一的拒绝文案 */
const EXPOSED_NOAUTH_ERR =
  "服务当前以非本机地址开放且未配置认证（AUTH_TOKEN），已拒绝该操作。" +
  "请设置环境变量 AUTH_TOKEN 后携带 Bearer token 访问，或改用 HOST=127.0.0.1 仅本机使用";

const server = createServer(async (req, res) => {
  const requestId = newRequestId();
  res.setHeader("X-Request-Id", requestId);
  const startedAt = Date.now();
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;
  let tracked = false;
  let sessionIdForLog: string | undefined;

  try {
    // API 响应一律禁缓存（GET /api/config 等被浏览器缓存会造成状态不同步）
    if (pathname.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    // Phase 1 安全响应头（nosniff / no-referrer / DENY 嵌入 / CSP），对所有路径生效
    applySecurityHeaders(res);

    // --- 健康检查（免认证：部署探针无凭据可达；只回版本/布尔值，无路径与 Key）
    if (pathname === "/healthz") { await handleHealthz(res); return; }
    if (pathname === "/readyz") { await handleReadyz(res); return; }

    // 优雅退出期间不再接新业务（探针除外）：明确 503，避免客户端只看到连接重置
    if (!lifecycle.beginRequest()) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
      res.end(JSON.stringify({ error: "服务正在关闭，请稍后重试" }));
      log("warn", "request_rejected", { requestId, method: req.method, path: pathname });
      return;
    }
    tracked = true;
    incGauge("agent_http_inflight_requests");

    // 所有 API 的写请求先做同源检查；登录页也必须只允许从本站发起。
    if (pathname.startsWith("/api/")) {
      const originReject = checkSameOrigin(req);
      if (originReject) { respondForbidden(req, res, originReject); return; }
    }

    // 认证端点自身不能要求已登录 Cookie；静态页匿名可加载后由前端发起登录。
    if (pathname === "/api/auth/session" && req.method === "GET") { await handleAuthStatus(req, res); return; }
    if (pathname === "/api/auth/session" && req.method === "POST") { await handleAuthLogin(req, res); return; }
    if (pathname === "/api/auth/session/renew" && req.method === "POST") { await handleAuthRenew(req, res); return; }
    if (pathname === "/api/auth/logout" && req.method === "POST") { await handleAuthLogout(req, res); return; }

    // Prometheus 指标不是 /api/*，但同样需要会话认证；静态页匿名无法读取。
    if (pathname === "/metrics") {
      if (!verifyMetricsAuth(req)) {
        const decision = authFailureLimiter.recordFailure(clientIp(req));
        if (!decision.allowed) {
          res.writeHead(429, { "Content-Type": "application/json; charset=utf-8", "Retry-After": String(decision.retryAfterSeconds) });
          res.end(JSON.stringify({ error: `认证失败次数过多，请在 ${decision.retryAfterSeconds} 秒后重试` }));
        } else {
          respondUnauthorized(req, res);
        }
        return;
      }
      handleMetrics(res);
      return;
    }

    // 除认证端点、静态页与探针外，全部 /api/* 都需要有效会话 Cookie。
    if (pathname.startsWith("/api/") && !verifyRequestAuth(req)) {
      const ip = clientIp(req);
      const decision = authFailureLimiter.recordFailure(ip);
      writeAudit("auth_rejected", { requestId, method: req.method, path: pathname });
      if (!decision.allowed) {
        res.writeHead(429, {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(decision.retryAfterSeconds),
        });
        res.end(JSON.stringify({ error: `认证失败次数过多，请在 ${decision.retryAfterSeconds} 秒后重试` }));
      } else {
        respondUnauthorized(req, res);
      }
      return;
    }
    // Phase 0 止血：非 loopback 绑定且未启用认证 → 所有写请求全部拒绝。
    // 用「方法级」而非接口枚举：新增路由默认落在防线内侧，不会因漏单位置绕过。
    // GET（只读信息）不受限：config/sessions 等只含掩码/元信息，无副作用。
    if (!LOOPBACK_HOST && !AUTH_ENABLED && req.method !== "GET" && req.method !== "HEAD") {
      // authRequired=true：提示设置 AUTH_TOKEN 后携带 Bearer 即可放开
      respondForbidden(req, res, EXPOSED_NOAUTH_ERR, true);
      return;
    }

    // --- 静态 ---
    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      if (await serveStatic(pathname, res)) return;
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    // --- API ---
    // ── API 路由：路径匹配在入口集中做，业务一律在 routes/*.ts（先 await 业务再 writeHead）──
    const modelsMatch = pathname.match(/^\/api\/config\/providers\/([\w-]+)\/models$/);
    const modelMatch = pathname.match(/^\/api\/config\/providers\/([\w-]+)\/models\/([\w-]+)$/);
    const providerMatch = pathname.match(/^\/api\/config\/providers\/([\w-]+)$/);
    const sessionMatch = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
    const transcriptMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/transcript$/);
    const compactMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/compact$/);
    const permissionMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/permission$/);
    const extMatch = pathname.match(/^\/api\/external-agents\/([\w-]+)$/);
    const projectMatch = pathname.match(/^\/api\/projects\/([\w-]+)$/);
    const projectRefresh = pathname.match(/^\/api\/projects\/([\w-]+)\/refresh$/);
    const ragDocMatch = pathname.match(/^\/api\/rag\/docs\/([\w-]+)$/);
    const pluginMatch = pathname.match(/^\/api\/plugins\/([\w-]+)$/);
    const subagentMatch = pathname.match(/^\/api\/subagents\/([\w-]+)$/);

    // 供应商 / 模型 / 思考等级 / 网关探测
    if (pathname === "/api/config" && req.method === "GET") { await handleGetApiConfig(res); return; }
    if (pathname === "/api/config/providers" && req.method === "POST") { await handleAddProvider(res, req); return; }
    if (modelsMatch && req.method === "POST") { await handleAddModel(res, req, modelsMatch[1]); return; }
    if (modelMatch && req.method === "POST") { await handleUpdateModel(res, req, modelMatch[1], modelMatch[2]); return; }
    if (modelMatch && req.method === "DELETE") { await handleDeleteModel(res, req, modelMatch[1], modelMatch[2]); return; }
    if (pathname === "/api/config/reasoning" && req.method === "POST") { await handleSetReasoning(res, req); return; }
    if (providerMatch && req.method === "POST") { await handleUpdateProvider(res, req, providerMatch[1]); return; }
    if (providerMatch && req.method === "DELETE") { await handleDeleteProvider(res, req, providerMatch[1]); return; }
    if (pathname === "/api/config/activate" && req.method === "POST") { await handleActivate(res, req); return; }
    if (pathname === "/api/models" && req.method === "POST") { await handleModels(res, req); return; }

    // 内置插件启停（RAG / 找房数据源 / Computer Use）
    if (pathname === "/api/plugins" && req.method === "GET") { handleListPlugins(res); return; }
    if (pluginMatch && req.method === "PATCH") { await handleSetPluginEnabled(res, req, pluginMatch[1]); return; }

    // 子代理配置（身份 / 启停 / 模型；提示词与工具由主 Agent 运行时赋予）
    if (pathname === "/api/subagents" && req.method === "GET") { handleListSubagents(res); return; }
    if (pathname === "/api/subagents" && req.method === "POST") { await handleCreateSubagent(res, req); return; }
    if (subagentMatch && req.method === "PATCH") { await handleUpdateSubagent(res, req, subagentMatch[1]); return; }
    if (subagentMatch && req.method === "DELETE") { await handleDeleteSubagent(res, subagentMatch[1]); return; }

    // 会话
    if (pathname === "/api/sessions") { await handleSessions(res, req); return; }
    // 批量清理要放在 sessionMatch 之前：/api/sessions/cleanup 不能被当成会话 id
    if (pathname === "/api/sessions/cleanup" && req.method === "POST") { await handleCleanupSessions(res, req); return; }
    if (sessionMatch && req.method === "DELETE") { await handleDeleteSession(res, sessionMatch[1]); return; }
    if (compactMatch && req.method === "POST") { await handleCompactSession(res, req, compactMatch[1]); return; }
    if (permissionMatch && req.method === "POST") { await handleSessionPermission(res, req, permissionMatch[1]); return; }
    if (transcriptMatch && req.method === "GET") { await handleTranscript(res, transcriptMatch[1]); return; }
    const exportMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/export$/);
    if (exportMatch && req.method === "GET") { await handleExportSession(res, exportMatch[1]); return; }

    // 外部 Agent
    if (pathname === "/api/external-agents" && req.method === "GET") { await handleListExternalAgents(res); return; }
    if (pathname === "/api/external-agents" && req.method === "POST") { await handleAddExternalAgent(res, req); return; }
    if (extMatch && req.method === "POST") { await handleUpdateExternalAgent(res, req, extMatch[1]); return; }
    if (extMatch && req.method === "DELETE") { await handleDeleteExternalAgent(res, req, extMatch[1]); return; }

    // 项目文件夹
    if (pathname === "/api/projects" && req.method === "GET") { await handleListProjects(res); return; }
    if (pathname === "/api/projects" && req.method === "POST") { await handleAddProject(res, req); return; }
    if (pathname === "/api/projects/pick-directory" && req.method === "POST") { await handlePickProjectDirectory(res, req); return; }
    if (pathname === "/api/projects/active" && req.method === "POST") { await handleSetActiveProject(res, req); return; }
    if (projectMatch && req.method === "DELETE") { await handleDeleteProject(res, req, projectMatch[1]); return; }
    if (projectRefresh && req.method === "POST") { await handleRefreshProject(res, req, projectRefresh[1]); return; }

    // 文件上下文
    if (pathname === "/api/fs/list" && req.method === "POST") { await handleFsList(res, req); return; }
    if (pathname === "/api/fs/search" && req.method === "POST") { await handleFsSearch(res, req); return; }
    if (pathname === "/api/fs/read" && req.method === "POST") { await handleFsRead(res, req); return; }
    if (pathname === "/api/fs/open-remote" && req.method === "POST") { await handleFsOpenRemote(res, req); return; }
    if (pathname === "/api/files/upload" && req.method === "POST") { await handleUpload(res, req); return; }

    // 对话 / 审批
    if (pathname === "/api/chat" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        sessionId?: string; message?: unknown; files?: unknown;
      };
      sessionIdForLog = typeof body.sessionId === "string" ? body.sessionId : undefined;
      try {
        await handleChat(res, req, body.sessionId ?? "", body);
      } catch (err) {
        // 附件解析等前置错误 → 400/413（此时流未开始）
        respondBadRequest(res, req, err);
      }
      return;
    }
    if (pathname === "/api/resume" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { sessionId?: string; decision?: unknown; choice?: unknown };
      sessionIdForLog = typeof body.sessionId === "string" ? body.sessionId : undefined;
      await handleResume(res, req, body.sessionId ?? "", body);
      return;
    }

    // 记忆插槽配置 / 连接测试 / 运行状态
    if (pathname === "/api/memory/config" && req.method === "GET") { await handleGetMemoryConfig(res); return; }
    if (pathname === "/api/memory/config" && req.method === "PUT") { await handleUpdateMemoryConfig(res, req); return; }
    if (pathname === "/api/memory/test" && req.method === "POST") { await handleTestMemory(res, req); return; }
    if (pathname === "/api/memory/status" && req.method === "GET") { await handleMemoryStatus(res); return; }

    // 跨会话长期记忆（设置页「记忆」弹窗；Agent 侧走同一 Memory Slot）
    if (pathname === "/api/memories" && req.method === "GET") { await handleListMemories(res, url.searchParams.get("profileId"), url.searchParams.get("history") === "1"); return; }
    if (pathname === "/api/memories" && req.method === "POST") { await handleSaveMemory(res, req); return; }
    if (pathname === "/api/memories/export" && req.method === "GET") {
      await handleExportMemories(res, url.searchParams.get("profileId"), url.searchParams.get("history") === "1");
      return;
    }
    if (pathname === "/api/memories/import" && req.method === "POST") { await handleImportMemories(res, req); return; }
    const memoryDelMatch = pathname.match(/^\/api\/memories\/([\w-]+)$/);
    if (memoryDelMatch && req.method === "DELETE") { await handleDeleteMemory(res, memoryDelMatch[1], url.searchParams.get("profileId")); return; }

    // 用户自定义命令（提示词模板；前端斜杠菜单与设置页共用）
    if (pathname === "/api/commands" && req.method === "GET") { await handleListCommands(res); return; }
    if (pathname === "/api/commands" && req.method === "POST") { await handleSaveCommand(res, req); return; }
    const commandMatch = pathname.match(/^\/api\/commands\/([\w-]+)$/);
    if (commandMatch && req.method === "PUT") { await handleUpdateCommand(res, req, commandMatch[1]); return; }
    if (commandMatch && req.method === "DELETE") { await handleDeleteCommand(res, commandMatch[1]); return; }

    // 技能库（按关键词命中注入的领域指南；纯文档不执行）
    if (pathname === "/api/skills" && req.method === "GET") { await handleListSkills(res); return; }
    if (pathname === "/api/skills" && req.method === "POST") { await handleSaveSkill(res, req); return; }
    if (pathname === "/api/skills/import" && req.method === "POST") { await handleImportSkills(res, req); return; }
    const skillMatch = pathname.match(/^\/api\/skills\/(.+)$/);
    if (skillMatch && req.method === "PATCH") { await handleSetSkillEnabled(res, req, skillMatch[1]); return; }
    if (skillMatch && req.method === "DELETE") { await handleDeleteSkill(res, skillMatch[1]); return; }

    // MCP 客户端（JSON-RPC over stdio 自实现；工具默认全登记审批）
    if (pathname === "/api/mcp" && req.method === "GET") { await handleListMcp(res); return; }
    if (pathname === "/api/mcp" && req.method === "POST") {
      await handleSaveMcp(res, req);
      await refreshMcpTools(true);
      return;
    }
    if (pathname === "/api/mcp" && req.method === "PATCH") {
      await handleSetMcpEnabled(res, req);
      await refreshMcpTools(true);
      return;
    }
    if (pathname === "/api/mcp/import" && req.method === "POST") {
      await handleImportMcp(res, req);
      await refreshMcpTools(true);
      return;
    }
    const mcpTestMatch = pathname.match(/^\/api\/mcp\/([\w-]+)\/test$/);
    if (mcpTestMatch && req.method === "POST") { await handleTestMcp(res, mcpTestMatch[1]); return; }
    const mcpUpdateMatch = pathname.match(/^\/api\/mcp\/([\w-]+)$/);
    if (mcpUpdateMatch && req.method === "PATCH") {
      await handleUpdateMcp(res, req, mcpUpdateMatch[1]);
      await refreshMcpTools(true);
      return;
    }
    if (mcpUpdateMatch && req.method === "DELETE") {
      await handleDeleteMcp(res, mcpUpdateMatch[1]);
      await refreshMcpTools(true);
      return;
    }
    // 运维诊断（受认证保护；不返回路径、提示词或密钥）
    if (pathname === "/api/diagnostics" && req.method === "GET") { await handleDiagnostics(res); return; }
    if (pathname === "/api/client-errors" && req.method === "POST") { await handleClientError(req, res, requestId); return; }

    // 使用统计（只读聚合，数据源为 journal 回放后的内存轮次）
    if (pathname === "/api/stats" && req.method === "GET") { await handleStats(res); return; }

    // 备份与恢复（F9：换机 / 误删 / 升级前的整机状态快照）
    if (pathname === "/api/backup" && req.method === "POST") { await handleCreateBackup(res); return; }
    if (pathname === "/api/backup" && req.method === "GET") { await handleListBackups(res); return; }
    if (pathname === "/api/restore" && req.method === "POST") { await handleRestoreBackup(res, req); return; }

    // RAG（外部知识库）
    if (pathname === "/api/rag" && req.method === "GET") { await handleGetRag(res); return; }    if (pathname === "/api/rag/config" && req.method === "POST") { await handleSaveRagConfig(res, req); return; }
    if (pathname === "/api/rag/test" && req.method === "POST") { await handleTestRag(res, req); return; }
    if (pathname === "/api/rag/ingest" && req.method === "POST") { await handleIngest(res, req); return; }
    if (pathname === "/api/rag/search" && req.method === "POST") { await handleRagSearch(res, req); return; }
    if (ragDocMatch && req.method === "DELETE") { await handleDeleteRagDoc(res, req, ragDocMatch[1]); return; }
    if (pathname === "/api/rag/clear" && req.method === "POST") { await handleClearRag(res, req); return; }

    // 房产 Agent（贝壳 CLI）
    if (pathname === "/api/estate" && req.method === "GET") { await handleGetEstate(res); return; }
    if (pathname === "/api/estate/install" && req.method === "POST") { await handleInstallBeike(res, req); return; }
    if (pathname === "/api/estate/key" && req.method === "POST") { await handleSaveBeikeKey(res, req); return; }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not Found" }));
  } catch (err) {
    // 请求体超限：统一 413 + 断开连接（readBody 已 pause 数据流，不会有残留累积）
    if (err instanceof BodyTooLargeError) {
      respondBadRequest(res, req, err);
      return;
    }
    // 请求体不是合法 JSON（各路由直接 JSON.parse(readBody)）：客户端问题 → 400，
    // 不应落到 500（500 会误导「服务端故障」，也让压测把坏请求算成服务错误）
    if (err instanceof SyntaxError) {
      if (!res.headersSent) respondBadRequest(res, req, new Error("请求体不是合法的 JSON"));
      else res.end();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log("error", "request_failed", { requestId, method: req.method, path: pathname, message });
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: message }));
  } finally {
    // 在 handler 完全退出后记账（而不是 res 的 close）：SSE 被 shutdown abort 时，
    // close 可能早于 streamToClient 的 finally 落 journal，会让优雅退出提前 flush。
    const durationMs = Date.now() - startedAt;
    const status = res.statusCode;
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
    if (tracked) {
      lifecycle.endRequest();
      incGauge("agent_http_inflight_requests", {}, -1);
      log(pathname.startsWith("/api/") ? "info" : "debug", "http_request", {
        requestId,
        method: req.method,
        path: pathname,
        status,
        durationMs,
        sessionId: sessionIdForLog,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 优雅退出（Phase 4）：停新请求 → 通知 SSE → 等在途 → flush → 退出
// ---------------------------------------------------------------------------
let signalHandled = false;
function handleSignal(signal: string): void {
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
  await disconnectAll(); // 持久检查点的在途追加也等落盘（F0）
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
});
