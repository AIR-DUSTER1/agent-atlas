/**
 * ============================================================
 * dispatch.ts — API 顺序分发（框架迁移 M1：从 index.ts 原样平移）
 * ============================================================
 * 职责：把已通过全部横切门禁的 /api 请求按既有 if 链分发给 routes/*.ts。
 * 迁移纪律：M1 阶段本文件**逐字平移**，不改匹配顺序、不改响应形状；
 * M2 按域分批声明式化时再逐条摘除（每批迁走后从本文件删除对应分支）。
 * 413 / 400 / 500 错误映射与请求记账在外层 app.ts 的 requestContext 中间件，
 * 与平移前的 index.ts handler 完全一致。refreshMcpTools 随 MCP 路由一并迁入
 * （index.ts 启动路径也从这里导入）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { bumpConfigVersion, getSessionByThreadForUser } from "./sessions.js";
import {
  handleAddExternalAgent,
  handleDeleteExternalAgent,
  handleListExternalAgents,
  handleUpdateExternalAgent,
} from "./routes/external.js";
import {
  handleAddProject,
  handleDeleteProject,
  handleListProjects,
  handlePickProjectDirectory,
  handleRefreshProject,
  handleSetActiveProject,
} from "./routes/projects.js";
import { handleBrowserClose, handleBrowserScreenshot, handleBrowserState, handleBrowserStatus } from "./routes/browser-use.js";
import { handleChat, handleResume } from "./routes/chat.js";
import {
  handleCleanupSessions,
  handleCompactSession,
  handleDeleteSession,
  handleExportSession,
  handleSessionPermission,
  handleSessions,
  handleTranscript,
} from "./routes/sessions.js";
import {
  handleClearRag,
  handleDeleteRagDoc,
  handleGetRag,
  handleIngest,
  handleRagSearch,
  handleSaveRagConfig,
  handleTestRag,
} from "./routes/rag.js";
import { handleCreateBackup, handleListBackups, handleRestoreBackup } from "./routes/backup.js";
import { handleCreateSubagent, handleDeleteSubagent, handleListSubagents, handleUpdateSubagent } from "./routes/subagents.js";
import {
  handleCreateUser,
  handleCreateUserToken,
  handleDeleteUser,
  handleListUserTokens,
  handleListUsers,
  handleResetUserPassword,
  handleRevokeUserToken,
  handleUpdateUser,
} from "./routes/users.js";
import {
  handleEstateExport,
  handleGetEstate,
  handleInstallBeike,
  handleSaveBeikeKey,
  handleStartBeikeLogin,
} from "./routes/estate.js";
import { handleFsList, handleFsOpenRemote, handleFsRead, handleFsSearch, handleUpload } from "./routes/files.js";
import { handleGetJob, handleJobDiagnose, handleJobDoctor, handleJobLogin, handleSaveJob } from "./routes/job.js";
import { handleGetRouting, handleSaveRouting, handleTestRouting } from "./routes/routing.js";
import { handleListPlugins, handleSetPluginEnabled } from "./routes/plugins.js";
import { handleStaticMap } from "./map-static.js";
import { loadMcpTools, mcpApprovalDescriptions } from "./mcp-tools.js";
import { log } from "./logging.js";
import { readBody, respondBadRequest } from "./http-body.js";
import { requireDeviceIdentity } from "./security/device.js";
import { setExternalTools } from "../agent/general.js";

export interface DispatchContext {
  /** 请求 id：透传给 /api/client-errors 作为关联键 */
  requestId: string;
  /** 对话类请求的会话 id：仅供访问日志记录（dispatch 内部赋值） */
  sessionId?: string;
}

/**
 * 重新加载 MCP 工具并注入 general profile。
 * 每次增删 MCP server / 配置变更后调用；单个 server 失败不阻断其它 server。
 */
export async function refreshMcpTools(bumpVersion = false): Promise<void> {
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

export async function dispatchApi(req: IncomingMessage, res: ServerResponse, ctx: DispatchContext): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:0`);
  const pathname = url.pathname;
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
    // 用户 id 是 uuid；reset-password / tokens 子路径在各自分支用 endsWith 区分
    const userMatch = pathname.match(/^\/api\/users\/([\w-]+)$/);
    const userTokenRevokeMatch = pathname.match(/^\/api\/users\/([\w-]+)\/tokens\/([\w-]+)$/);

    // 结论地图：高德/腾讯/百度 Web 服务 Key 仅在服务端代理中使用
    if (pathname === "/api/map/static" && req.method === "GET") { await handleStaticMap(res, url); return; }

    // 供应商 / 模型 / 思考等级 / 网关探测

    // LangSmith 追踪设置（只保存配置；真正上报发生在 runGraphEvents 的 callback 注入点）

    // 内置插件启停（RAG / 找房数据源 / Computer Use）
    if (pathname === "/api/plugins" && req.method === "GET") { handleListPlugins(res); return; }
    if (pluginMatch && req.method === "PATCH") { await handleSetPluginEnabled(res, req, pluginMatch[1]); return; }

    // 子代理配置（身份 / 启停 / 模型；提示词与工具由主 Agent 运行时赋予）
    if (pathname === "/api/subagents" && req.method === "GET") { handleListSubagents(res); return; }
    if (pathname === "/api/subagents" && req.method === "POST") { await handleCreateSubagent(res, req); return; }
    if (subagentMatch && req.method === "PATCH") { await handleUpdateSubagent(res, req, subagentMatch[1]); return; }
    if (subagentMatch && req.method === "DELETE") { await handleDeleteSubagent(res, subagentMatch[1]); return; }

    // 用户管理（U2，admin only；文件模式由路由内统一 404）
    if (pathname === "/api/users" && req.method === "GET") { await handleListUsers(res); return; }
    if (pathname === "/api/users" && req.method === "POST") { await handleCreateUser(req, res); return; }
    if (userMatch && req.method === "PATCH") { await handleUpdateUser(req, res, userMatch[1]); return; }
    if (userMatch && req.method === "DELETE") { await handleDeleteUser(req, res, userMatch[1]); return; }
    if (userMatch && pathname.endsWith("/reset-password") && req.method === "POST") {
      await handleResetUserPassword(req, res, userMatch[1]);
      return;
    }
    if (userMatch && pathname.endsWith("/tokens") && req.method === "GET") {
      await handleListUserTokens(res, userMatch[1]);
      return;
    }
    if (userMatch && pathname.endsWith("/tokens") && req.method === "POST") {
      await handleCreateUserToken(req, res, userMatch[1]);
      return;
    }
    if (userTokenRevokeMatch && req.method === "DELETE") {
      await handleRevokeUserToken(req, res, userTokenRevokeMatch[1], userTokenRevokeMatch[2]);
      return;
    }

    // 路由决策层（默认关闭；开启后按规则 → 向量 → 决策模型挑子代理）
    if (pathname === "/api/routing" && req.method === "GET") { handleGetRouting(res); return; }
    if (pathname === "/api/routing" && req.method === "PUT") { await handleSaveRouting(res, req); return; }
    if (pathname === "/api/routing/test" && req.method === "POST") { await handleTestRouting(res, req); return; }

    // 会话
    if (pathname === "/api/sessions") { await handleSessions(res, req); return; }
    // 批量清理要放在 sessionMatch 之前：/api/sessions/cleanup 不能被当成会话 id
    if (pathname === "/api/sessions/cleanup" && req.method === "POST") { await handleCleanupSessions(res, req); return; }
    if (sessionMatch && req.method === "DELETE") { await handleDeleteSession(res, req, sessionMatch[1]); return; }
    if (compactMatch && req.method === "POST") { await handleCompactSession(res, req, compactMatch[1]); return; }
    if (permissionMatch && req.method === "POST") { await handleSessionPermission(res, req, permissionMatch[1]); return; }
    if (transcriptMatch && req.method === "GET") { await handleTranscript(res, req, transcriptMatch[1]); return; }
    const exportMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/export$/);
    if (exportMatch && req.method === "GET") { await handleExportSession(res, req, exportMatch[1]); return; }

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
        sessionId?: string; message?: unknown; files?: unknown; headless?: unknown;
      };
      ctx.sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
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
      ctx.sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
      await handleResume(res, req, body.sessionId ?? "", body);
      return;
    }

    // 记忆插槽配置 / 连接测试 / 运行状态
    // 版本与运维诊断（受认证保护；不返回路径、提示词或密钥）

    // 使用统计（只读聚合，数据源为 journal 回放后的内存轮次）

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
    const estateExportMatch = pathname.match(/^\/api\/estate\/exports\/([0-9a-f-]{36})$/i);
    if (estateExportMatch && req.method === "GET") { await handleEstateExport(res, estateExportMatch[1]!); return; }
    if (pathname === "/api/estate" && req.method === "GET") { await handleGetEstate(res); return; }
    if (pathname === "/api/estate/install" && req.method === "POST") { await handleInstallBeike(res, req); return; }
    if (pathname === "/api/estate/login" && req.method === "POST") { await handleStartBeikeLogin(res, req); return; }
    if (pathname === "/api/estate/key" && req.method === "POST") { await handleSaveBeikeKey(res, req); return; }

    // 求职岗位 Agent（内置浏览器采集）：状态 / 数据目录 / 登录 / 自检
    if (pathname === "/api/job" && req.method === "GET") { await handleGetJob(res); return; }
    if (pathname === "/api/job" && req.method === "PUT") { await handleSaveJob(res, req); return; }
    if (pathname === "/api/job/login" && req.method === "POST") { await handleJobLogin(res, req); return; }
    if (pathname === "/api/job/doctor" && req.method === "POST") { await handleJobDoctor(res, req); return; }
      if (pathname === "/api/job/diagnose" && req.method === "POST") { await handleJobDiagnose(res, req); return; }

    // Browser Use（通用 Agent 插件）：状态 / 实时画面 / 关闭会话
    if (pathname === "/api/browser/status" && req.method === "GET") { handleBrowserStatus(res); return; }
    const browserMatch = pathname.match(/^\/api\/browser\/sessions\/([^/]+)(\/screenshot)?$/);
    if (browserMatch) {
      let browserSessionId = "";
      try { browserSessionId = decodeURIComponent(browserMatch[1] || ""); }
      catch { res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "浏览器会话 id 编码非法" })); return; }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(browserSessionId)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "浏览器会话 id 格式非法" }));
        return;
      }
      const userId = requireDeviceIdentity(req, res);
      if (!userId) return;
      if (!getSessionByThreadForUser(browserSessionId, userId)) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Browser Use 会话不存在或不属于当前设备" }));
        return;
      }
      if (!browserMatch[2] && req.method === "GET") { handleBrowserState(res, browserSessionId); return; }
      if (browserMatch[2] && req.method === "GET") { handleBrowserScreenshot(res, browserSessionId); return; }
      if (!browserMatch[2] && req.method === "POST") { await handleBrowserClose(res, req, browserSessionId); return; }
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not Found" }));
}
