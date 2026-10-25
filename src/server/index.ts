/**
 * ============================================================
 * index.ts — Agent Web 服务（零框架：node:http + SSE）
 * ============================================================
 * 为什么不用 Express？
 *   一共 6 个路由 + 静态文件，node:http 足够，学习 Demo 零额外依赖更好读。
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
import { restoreSessions } from "./sessions.js";
import { loadSettings, refreshModelInfo } from "./settings.js";
import { loadProjects } from "./projects.js";
import { loadExternalAgents } from "./external.js";
import { loadRag } from "./rag.js";
import { loadEstate } from "./estate.js";
import { isAuthEnabled, verifyBearer } from "./auth.js";
import { applySecurityHeaders, checkSameOrigin, respondForbidden, respondUnauthorized } from "./http-guard.js";
import { readBody, respondBadRequest, BodyTooLargeError } from "./http-body.js";
import { serveStatic } from "./static.js";
import { handleHealthz, handleReadyz } from "./health.js";
import { lifecycle } from "./lifecycle.js";
import { flushAudit, writeAudit } from "./audit.js";
import { flushJournal } from "./session-store.js";
import { flushCheckpointLog } from "../checkpoint.js";
import { loadMemories } from "../memory-store.js";
import { log, newRequestId } from "./logging.js";
import { handleChat, handleResume } from "./routes/chat.js";
import {
  handleGetApiConfig, handleAddProvider, handleAddModel, handleUpdateModel, handleDeleteModel,
  handleSetReasoning, handleUpdateProvider, handleDeleteProvider, handleActivate, handleModels,
} from "./routes/config.js";
import { handleSessions, handleDeleteSession, handleTranscript, handleCompactSession, handleSessionPermission, handleExportSession, handleCleanupSessions } from "./routes/sessions.js";
import { handleListExternalAgents, handleAddExternalAgent, handleUpdateExternalAgent, handleDeleteExternalAgent } from "./routes/external.js";
import { handleListProjects, handleAddProject, handleSetActiveProject, handleDeleteProject, handleRefreshProject } from "./routes/projects.js";
import { handleFsList, handleFsSearch, handleFsRead, handleFsOpenRemote, handleUpload } from "./routes/files.js";
import { handleGetRag, handleSaveRagConfig, handleTestRag, handleIngest, handleRagSearch, handleDeleteRagDoc, handleClearRag } from "./routes/rag.js";
import { handleListMemories, handleSaveMemory, handleDeleteMemory } from "./routes/memories.js";
import { handleStats } from "./routes/stats.js";
import { handleGetEstate, handleInstallBeike, handleSaveBeikeKey } from "./routes/estate.js";
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

// 启动时先叠加 Web 设置页保存的覆盖配置（.web-config.json → 覆盖 .env），
// 加载项目文件夹列表，并后台拉一次启用中供应商的模型元信息（上下文窗口长度）
await loadSettings();
await loadProjects();
await loadExternalAgents();
await loadRag();
await loadEstate();
// F1：跨会话长期记忆（agent 层 memoryNote 每轮读内存索引，这里启动时预热落盘数据）
await loadMemories();
// T2-2：journal 回放 —— 重启后恢复会话壳 / 轮次历史 / pending 审批标记
const restoredSessions = await restoreSessions();
if (restoredSessions > 0) {
  log("info", "sessions_restored", { count: restoredSessions });
  // 人类可读提示只在终端输出；容器/管道场景保持 stdout 纯 NDJSON
  if (process.stdout.isTTY) {
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

    // Phase 1 认证：AUTH_TOKEN 开启后，除静态页与探针外的全部 /api/* 都要 Bearer。
    // 静态页豁免 = 让浏览器能加载出 UI 并弹 token 输入框（401 引导流程）
    if (pathname.startsWith("/api/")) {
      if (!verifyBearer(req)) {
        // 认证失败留审计痕迹（只记方法/路径，不带 token 内容）
        writeAudit("auth_rejected", { requestId, method: req.method, path: pathname });
        respondUnauthorized(req, res);
        return;
      }
      // Phase 1 同源/CSRF 防护：mutating 必须同源（跨站表单/text/plain POST 直接拒）
      const originReject = checkSameOrigin(req);
      if (originReject) { respondForbidden(req, res, originReject); return; }
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

    // 跨会话长期记忆（设置页「记忆」弹窗；Agent 侧经 memory_save 工具同一存储）
    if (pathname === "/api/memories" && req.method === "GET") { await handleListMemories(res); return; }
    if (pathname === "/api/memories" && req.method === "POST") { await handleSaveMemory(res, req); return; }
    const memoryDelMatch = pathname.match(/^\/api\/memories\/([\w-]+)$/);
    if (memoryDelMatch && req.method === "DELETE") { await handleDeleteMemory(res, memoryDelMatch[1]); return; }

    // 使用统计（只读聚合，数据源为 journal 回放后的内存轮次）
    if (pathname === "/api/stats" && req.method === "GET") { await handleStats(res); return; }

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
    if (tracked) {
      lifecycle.endRequest();
      log(pathname.startsWith("/api/") ? "info" : "debug", "http_request", {
        requestId,
        method: req.method,
        path: pathname,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
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
      await flushCheckpointLog(); // 持久检查点的在途追加也等落盘（F0）
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
  if (process.stderr.isTTY) {
    console.error(
      err.code === "EADDRINUSE"
        ? `\n  端口 ${PORT} 已被占用：请设置 PORT=其它端口，或先停掉占用进程。\n`
        : `\n  服务启动失败：${err.message}\n`
    );
  }
  process.exit(1);
});

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
  if (process.stdout.isTTY) {
    console.log(
      `\n  LangGraph Agent Web 已启动\n` +
      `  ➜  http://${displayHost}:${PORT}   (监听 ${HOST}:${PORT})\n` +
      `  模式: ${mode}   模型: ${config.model}   网关: ${config.baseURL}\n` +
      `  提示: 右上角 ⚙ 设置 可在线修改供应商 / API Key / 模型\n`
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
