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
 * SSE 数据帧：每行 `data: {"type":"token","text":"..."}` + 空行，与 AgentEvent 一一对应。
 * 客户端断开：通过 AbortSignal 取消图流（模型请求随之中止），保证「停止」按钮可用。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { runGraphEvents } from "./stream.js";
import { mockRun } from "./mock.js";
import {
  createSession, deleteSession, getSession, isDemo, listSessions, DEMOS,
  rebuildIfStale, bumpConfigVersion, beginTurnRecord, completeTurnRecord, getTurnHistory,
  recordApproval, recordDecision, restoreSessions, buildPrehistoryNote, type Session,
} from "./sessions.js";
import {
  loadSettings, listProviders, getActiveId, getActiveModelId, addProvider, updateProvider, deleteProvider,
  activate, addModel, updateModel, deleteModel, setReasoning, listDialects, getReasoningState,
  maskKey, fetchGatewayModelList, getContextWindowForActive, refreshModelInfo, getActiveModality,
} from "./settings.js";
import { loadProjects, listProjects, getActiveProjectId, setActiveProject, addProject, deleteProject, refreshCloudProject } from "./projects.js";
import { loadExternalAgents, listExternalAgents, getExternalAgent, addExternalAgent, updateExternalAgent, deleteExternalAgent, runExternalAgent } from "./external.js";
import { listDir, readFileAuthorized, openRemoteRoot, storeUpload, resolveChatFiles, buildUserContent } from "./files.js";
import type { ChatFileRef } from "./files.js";
import { loadRag, getRagPublic, saveRagConfig, testRagConnection, searchRag, ingestFolder, ingestText, ingestChatAttachments, deleteRagDoc, clearRag } from "./rag.js";
import { loadEstate, getEstatePublic, installBeike, saveBeikeKey, analyzeEstateTurn } from "./estate.js";
import { assertChatInterval, acquireSessionSlot } from "./limits.js";
import type { AgentEvent, ApprovalPayload } from "./events.js";
import { isAuthEnabled, verifyBearer } from "./auth.js";
import { applySecurityHeaders, checkSameOrigin, respondForbidden, respondUnauthorized } from "./http-guard.js";
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
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
// T2-2：journal 回放 —— 重启后恢复会话壳 / 轮次历史 / pending 审批标记
const restoredSessions = await restoreSessions();
if (restoredSessions > 0) {
  console.log(`  ↪ 已从 journal 恢复 ${restoredSessions} 个会话（对话历史可回放；带审批挂起的会话将提示重新发起）`);
}
void refreshModelInfo().catch(() => {});
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// 静态文件（白名单式防目录穿越）
// ---------------------------------------------------------------------------
async function serveStatic(pathname: string, res: import("node:http").ServerResponse): Promise<boolean> {
  const file = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (!/^[\w.-]+$/.test(file)) return false; // 只允许单层文件名，杜绝 ../ 穿越
  try {
    const data = await readFile(join(PUBLIC_DIR, file));
    // no-store：页面与脚本始终取最新（本地学习 demo，禁用浏览器缓存，
    // 避免「更新代码后浏览器还在跑旧 app.js → 按钮点了没反应」）
    res.writeHead(200, {
      "Content-Type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SSE 输出
// ---------------------------------------------------------------------------
function writeEvent(res: import("node:http").ServerResponse, event: AgentEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** 统一的流式执行器：真实图 or 模拟模型，都吐 AgentEvent。
 *  每个推给前端的事件同时收进 collector，流结束后交给 onDone 持久化到会话记录。 */
async function streamToClient(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage,
  session: Session,
  produce: (signal: AbortSignal) => AsyncGenerator<AgentEvent>,
  onDone?: (events: AgentEvent[]) => void
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const controller = new AbortController();
  let clientGone = false;
  // 客户端断开检测：ServerResponse 的 close 在「响应未写完就断连」时才是真正的中止信号
  // （req 的 close 在请求体读完时就会触发，不能用来判断断连）
  res.on("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort();
    }
  });

  const collected: AgentEvent[] = [];
  try {
    for await (const event of produce(controller.signal)) {
      if (controller.signal.aborted) break;
      collected.push(event);
      writeEvent(res, event);
      if (event.type === "interrupt") recordApproval(session, event.payload);
      if (event.type === "done") session.pendingApproval = null;
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      const message = err instanceof Error ? err.message : String(err);
      collected.push({ type: "error", message });
      writeEvent(res, { type: "error", message });
    }
  } finally {
    // 被中止的部分轮也入档：历史回放时能看到「说了半截 + 停止」的真实经过
    onDone?.(collected);
    if (!clientGone) {
      writeEvent(res, { type: "done" });
      res.end();
    } else {
      res.end();
    }
  }
}

// ---------------------------------------------------------------------------
// 业务处理
// ---------------------------------------------------------------------------
/** 单次请求体字节数上限：聊天消息 + 附件 base64 正常都在 1MB 内；文件上传另有 12MB 白名单 */
const BODY_MAX_BYTES = 2_000_000;
const BODY_TOO_LARGE_MSG = "请求体过大：单次请求上限 2MB，请减少附件或文本内容后重试";
/** 413 后丢弃式排水的追加字节上限：正常客户端的超限余量是 MB 级，超过视为攻击性流，直接断开 */
const BODY_DRAIN_EXTRA_MAX_BYTES = 8_000_000;

/** readBody 超限时抛出；respondBadRequest 据此统一回 413（区别于业务错误的 400） */
class BodyTooLargeError extends Error {
  constructor() { super(BODY_TOO_LARGE_MSG); this.name = "BodyTooLargeError"; }
}

/**
 * 读取请求体（Phase 0 加固版）。
 * 旧实现的两个内存 DoS 坑：① 按「字符串长度」统计而非字节数（多字节字符会被放大统计，
 * 但二进制 base64 反而漏判）；② 超限后只是 reject，data 监听仍挂着继续把数据拼进字符串。
 * 现在：Content-Length 预检可提前拒绝；流式累计字节数，超限立刻 pause + reject，
 * 由响应层回 413 并断开连接（Connection: close），不再累积任何数据。
 */
function readBody(req: import("node:http").IncomingMessage, maxBytes = BODY_MAX_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    // Content-Length 预检：声明的长度已超限 → 不读不拼，直接判
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return;
      total += c.length;
      if (total > maxBytes) {
        tooLarge = true;
        req.pause(); // 停止接收：响应层回完 413 后由全局处理器断开连接
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 路由统一的失败响应：BodyTooLargeError → 413，其余一律 400 + 中文错误 */function respondBadRequest(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage, err: unknown): void {
  const tooLarge = err instanceof BodyTooLargeError;
  res.writeHead(tooLarge ? 413 : 400, {
    "Content-Type": "application/json; charset=utf-8",
    ...(tooLarge ? { Connection: "close" } : {}),
  });
  res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  if (tooLarge) {
    // 请求体没被读完 → keep-alive 无法继续。不能直接 destroy：
    // 客户端可能还有积压 body 未送达，带 unread-data 关闭会触发 RST，
    // 把已发出的 413 一并冲掉（踩坑：客户端只见 ECONNRESET 拿不到状态码）。
    // 对策「丢弃式排水」：继续把剩余 body 读进黑洞直到流结束再关；
    // 攻击性无限流靠排水总量上限兜底（超限直接 destroy，RST 可接受）。
    res.on("finish", () => {
      let drained = 0;
      req.on("data", (c: Buffer) => {
        drained += c.length;
        if (drained > BODY_DRAIN_EXTRA_MAX_BYTES) req.socket?.destroy();
      });
      req.on("end", () => req.socket?.destroy());
      req.on("error", () => req.socket?.destroy());
      req.resume();
    });
  }
}

async function handleChat(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage,
  sessionId: string,
  body: { message?: unknown; files?: unknown }
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "会话不存在或服务已重启，请新建会话" }));
    return;
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "消息不能为空" }));
    return;
  }
  // 配置在会话创建后被改过 → 先用当前配置重建图（Demo 2/3 的记忆会重置）
  rebuildIfStale(session);

  // T2-5 并发闸：连点节流 + 同会话唯一流（在登记对话记录之前，拒绝即零痕迹）
  assertChatInterval(sessionId);
  const releaseSlot = acquireSessionSlot(sessionId);
  try {
    await handleChatInner(res, req, session, message, body);
  } finally {
    releaseSlot();
  }
}

async function handleChatInner(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage,
  session: Session,
  message: string,
  body: { message?: unknown; files?: unknown }
): Promise<void> {
  // 附件：前端只传引用（项目/远程文件路径 或 上传 id），内容由服务端读取并校验。
  // 图片附件仅在启用中的模型为「多模态」时可用（否则 400 提示）。
  const fileRefs: ChatFileRef[] = Array.isArray(body.files) ? (body.files as ChatFileRef[]).slice(0, 5) : [];
  let fullMessage: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = message;
  if (fileRefs.length) {
    const attachments = await resolveChatFiles(fileRefs, getActiveModality() === "vision"); // 无效引用会抛错 → 路由转 400
    fullMessage = buildUserContent(message, attachments, getActiveModality());
    // RAG 自动入库：文本附件顺手送进外部知识库（best-effort，失败不影响对话）
    void ingestChatAttachments(
      attachments.filter((a) => a.kind === "text").map((a) => ({ name: a.name, content: a.content, truncated: a.truncated }))
    );
  }

  // 登记本轮对话记录（流结束后由 streamToClient 回填事件 → 任意浏览器可回放历史）
  const recordFiles = fileRefs.map((f) => ({ name: f.name ?? f.path ?? "附件", source: f.kind === "upload" ? "上传" : "项目文件", image: false }));
  beginTurnRecord(session, message, recordFiles.length ? recordFiles : undefined);

  // ── 外部 Agent 会话：不走 LangGraph / mock，直接启动第三方工具子进程 ──
  if (session.kind === "external") {
    const agent = getExternalAgent(session.agentId ?? "");
    if (!agent) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "该会话的外部 Agent 已被移除，请新建对话" }));
      return;
    }
    // 外部工具按纯文本接收：多模态附件只取文本部分（图片不传给第三方进程）
    const text = typeof fullMessage === "string"
      ? fullMessage
      : fullMessage.filter((p) => p.type === "text").map((p) => p.text).join("\n\n");
    await streamToClient(res, req, session, (signal) => runExternalAgent(agent, text, signal),
      (events) => completeTurnRecord(session, events));
    return;
  }

  // ── 房产会话：每轮把用户原话上报贝壳 analyze（官方契约，fire-and-forget） ──
  if (session.kind === "estate") {
    // 意图摘要 = 最近几轮用户消息的拼接（best-effort，无模型调用）
    const recent = session.turnHistory.slice(-3).map((r) => r.user).join(" ; ");
    void analyzeEstateTurn(message, recent ? `${recent} ; 本轮：${message}` : message);
  }

  // 未配置 API_KEY → 模拟模式；否则跑真实图
  if (!config.apiKey) {
    session.turns += 1; // 轮次递增，供模拟用量（上下文增长 / 缓存命中率）使用
    await streamToClient(res, req, session, (signal) =>
      mockRun({ message: typeof fullMessage === "string" ? fullMessage : message, rawMessage: message, kind: session.kind, turnIndex: session.turns - 1, signal })
    , (events) => completeTurnRecord(session, events));
    return;
  }

  const { HumanMessage } = await import("@langchain/core/messages");
  // T2-4：journal 回放来的会话首条真图消息 —— 前置注入历史上文摘录（一次性）
  const preNote = buildPrehistoryNote(session);
  const graphInput: unknown[] = preNote
    ? [new HumanMessage(preNote), new HumanMessage(fullMessage)]
    : [new HumanMessage(fullMessage)];
  await streamToClient(res, req, session, (signal) =>
    runGraphEvents(session.graph as Parameters<typeof runGraphEvents>[0], { messages: graphInput }, {
      threadId: session.threadId,
      signal,
    })
  , (events) => completeTurnRecord(session, events));
}

async function handleResume(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage,
  sessionId: string,
  body: { decision?: unknown }
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "会话不存在或服务已重启" }));
    return;
  }
  const decision = body.decision === "approve" ? "approve" : "reject";
  // T2-5：审批恢复也是流，同样走同会话唯一流闸
  const releaseSlot = acquireSessionSlot(sessionId);
  try {
    await handleResumeInner(res, req, session, decision, body);
  } finally {
    releaseSlot();
  }
}

async function handleResumeInner(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage,
  session: Session,
  decision: "approve" | "reject",
  body: { decision?: unknown }
): Promise<void> {
  const approval = session.pendingApproval;
  // T2-3：重启后带 pendingApproval 的会话 —— 图的 interrupt 状态已不可恢复，
  // 重复 resume 是明确错误，必须让用户重新发起（不允许静默重复执行）
  if (approval && session.resumeUnavailable) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: `服务重启后该审批的执行上下文已失效，无法继续（不重复执行、也不静默重做）。` +
        `请重新发起这个请求，例如：「${approval.toolName}」的那条指令再发一次。`,
    }));
    return;
  }
  // 配置变更后不重建审批中的图：旧图的 interrupt 状态无法跨 checkpointer 恢复，
  // 让本次 resume 在原图上完成（配置从下一条消息起生效）
  if (!approval) rebuildIfStale(session);

  beginTurnRecord(session, `(人工审批：${decision === "approve" ? "批准" : "拒绝"} ${approval?.toolName ?? "操作"}）`);

  if (!config.apiKey) {
    await streamToClient(res, req, session, (signal) =>
      mockRun({ decision, approval: approval ?? undefined, turnIndex: session.turns, signal })
    , (events) => {
      // T2-3：决定已做出 → journal 落 decided（一次性转移），再把本轮入档
      recordDecision(session, decision === "approve" ? "approved" : "rejected");
      completeTurnRecord(session, events);
    });
    return;
  }

  // 真实图：用 Command({ resume }) 把决定送回被暂停的图（见 agent/hitl.ts）
  const { buildResumeCommand } = await import("../agent/hitl.js");
  await streamToClient(res, req, session, (signal) =>
    runGraphEvents(session.graph as Parameters<typeof runGraphEvents>[0], buildResumeCommand(decision as "approve" | "reject"), {
      threadId: session.threadId,
      signal,
    })
  , (events) => {
    recordDecision(session, decision === "approve" ? "approved" : "rejected");
    completeTurnRecord(session, events);
  });
}

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
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // API 响应一律禁缓存（GET /api/config 等被浏览器缓存会造成状态不同步）
    if (pathname.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    // Phase 1 安全响应头（nosniff / no-referrer / DENY 嵌入 / CSP），对所有路径生效
    applySecurityHeaders(res);

    // --- 健康检查（不认证：部署探针需要无凭据可达；只回固定串，无信息泄露）
    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    // Phase 1 认证：AUTH_TOKEN 开启后，除静态页与 /healthz 外的全部 /api/* 都要 Bearer。
    // 静态页豁免 = 让浏览器能加载出 UI 并弹 token 输入框（401 引导流程）
    if (pathname.startsWith("/api/")) {
      if (!verifyBearer(req)) { respondUnauthorized(req, res); return; }
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
    if (pathname === "/api/config" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        mock: !config.apiKey,
        model: config.model,
        baseURL: config.baseURL,
        protocol: config.protocol,
        hasKey: Boolean(config.apiKey),
        keyMasked: maskKey(config.apiKey),
        providers: listProviders(),
        activeProviderId: getActiveId(),
        activeModelId: getActiveModelId(),
        // 当前启用模型的思考等级（方言 + 档位 + 该方言的全部档位），前端顶栏/设置页据此渲染
        reasoning: getReasoningState(),
        dialects: listDialects(),
        contextWindow: getContextWindowForActive() ?? null,
        demos: DEMOS,
      }));
      return;
    }

    // ── 供应商管理：添加 ──
    if (pathname === "/api/config/providers" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        const { provider, activeChanged } = await addProvider(body);
        if (activeChanged) {
          bumpConfigVersion();
          void refreshModelInfo().catch(() => {});
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, provider, activeChanged, mock: !config.apiKey }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    // ── 模型管理：给某个供应商添加模型（一个供应商可挂多个模型）──
    const modelsMatch = pathname.match(/^\/api\/config\/providers\/([\w-]+)\/models$/);
    if (modelsMatch && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        const r = await addModel(modelsMatch[1], body);
        if (r.activeChanged) {
          bumpConfigVersion();
          void refreshModelInfo().catch(() => {});
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    // ── 模型管理：改 / 删单个模型 ──
    const modelMatch = pathname.match(/^\/api\/config\/providers\/([\w-]+)\/models\/([\w-]+)$/);
    if (modelMatch && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        const r = await updateModel(modelMatch[1], modelMatch[2], body);
        if (r.activeChanged) {
          bumpConfigVersion();
          void refreshModelInfo().catch(() => {});
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }
    if (modelMatch && req.method === "DELETE") {
      try {
        const r = await deleteModel(modelMatch[1], modelMatch[2]);
        if (r.activeChanged) {
          bumpConfigVersion();
          void refreshModelInfo().catch(() => {});
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    // ── 思考等级：只改当前（或指定）模型的方言 / 档位 ──
    if (pathname === "/api/config/reasoning" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        const r = await setReasoning(body);
        if (r.activeChanged) bumpConfigVersion();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r, reasoning: getReasoningState() }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    // ── 供应商管理：更新 ──
    const providerMatch = pathname.match(/^\/api\/config\/providers\/([\w-]+)$/);
    if (providerMatch && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        const { activeChanged } = await updateProvider(providerMatch[1], body);
        if (activeChanged) {
          bumpConfigVersion();
          void refreshModelInfo().catch(() => {});
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, activeChanged, mock: !config.apiKey, model: config.model, baseURL: config.baseURL }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    // ── 供应商管理：删除 ──
    if (providerMatch && req.method === "DELETE") {
      try {
        const { activeChanged } = await deleteProvider(providerMatch[1]);
        if (activeChanged) {
          bumpConfigVersion();
          void refreshModelInfo().catch(() => {});
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, activeChanged, mock: !config.apiKey }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    // ── 供应商管理：切换启用（可同时指定该供应商下的模型）──
    if (pathname === "/api/config/activate" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { id?: string; providerId?: string; modelId?: string };
      try {
        const r = await activate(body.providerId ?? body.id ?? "", body.modelId);
        if (r.activeChanged) {
          bumpConfigVersion();
          void refreshModelInfo().catch(() => {});
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r, mock: !config.apiKey, baseURL: config.baseURL, reasoning: getReasoningState() }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    // 拉取网关模型列表（兼「测试连接」）：
    // { providerId } 用已存档案的 Key 测试 / { baseURL, apiKey, protocol } 用表单里未保存的值测试
    // 返回每个模型的元信息（上下文窗口 / 多模态 / 是否支持推理），前端据此渲染可点击的模型清单
    if (pathname === "/api/models" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        baseURL?: unknown; apiKey?: unknown; providerId?: unknown; protocol?: unknown;
      };
      try {
        const models = await fetchGatewayModelList({
          baseURL: typeof body.baseURL === "string" && body.baseURL.trim() ? body.baseURL : undefined,
          apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
          providerId: typeof body.providerId === "string" ? body.providerId : undefined,
          protocol: body.protocol,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, models, contextWindow: getContextWindowForActive() ?? null }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
      return;
    }

    if (pathname === "/api/sessions") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(listSessions().map((s) => ({
          id: s.id, kind: s.kind, demo: s.demo, agentId: s.agentId, projectId: s.projectId, title: s.title, createdAt: s.createdAt,
          pendingApproval: Boolean(s.pendingApproval),
        }))));
        return;
      }
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { kind?: unknown; demo?: unknown; projectId?: unknown; title?: string; agentId?: unknown };
        // 新逻辑：{ kind: "agent" }（默认）/ { kind: "demo", demo: 1-4 } / { kind: "external", agentId }
        //         / { kind: "estate" }（房产 Agent，贝壳工具集）
        // 兼容旧调用：只传 { demo: N } 视为示例会话
        const kind = body.kind === "demo" || body.kind === "external" || body.kind === "estate" || (!body.kind && isDemo(body.demo))
          ? (body.kind as "demo" | "external" | "estate")
          : "agent";
        const demo = isDemo(body.demo) ? body.demo : null;
        if (kind === "demo" && !demo) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "示例会话需要 demo: 1-4" }));
          return;
        }
        const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : getActiveProjectId();
        try {
          const session = createSession(kind, demo, projectId, body.title, typeof body.agentId === "string" ? body.agentId : null);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ id: session.id, kind: session.kind, demo: session.demo, agentId: session.agentId, projectId: session.projectId, title: session.title, createdAt: session.createdAt }));
        } catch (err) {
          respondBadRequest(res, req, err);
        }
        return;
      }
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
    if (sessionMatch && req.method === "DELETE") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: deleteSession(sessionMatch[1]) }));
      return;
    }

    // 会话对话记录回放（历史会话查看）：本地浏览器没有该会话的缓存时，
    // 前端用它从服务端拉取每轮「用户消息 + 事件流」并按原样重放渲染
    const transcriptMatch = pathname.match(/^\/api\/sessions\/([\w-]+)\/transcript$/);
    if (transcriptMatch && req.method === "GET") {
      const session = getSession(transcriptMatch[1]);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "会话不存在或服务已重启" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ records: getTurnHistory(session), pendingApproval: session.pendingApproval }));
      return;
    }

    // ── 外部 Agent（第三方 Git 仓库接入）：列表 / 接入 / 补全 / 删除 ──
    if (pathname === "/api/external-agents" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ agents: listExternalAgents() }));
      return;
    }

    if (pathname === "/api/external-agents" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        url?: string; name?: string; command?: string; args?: unknown; passCredentials?: unknown;
      };
      try {
        const r = await addExternalAgent(body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r, agents: listExternalAgents() }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    const extMatch = pathname.match(/^\/api\/external-agents\/([\w-]+)$/);
    if (extMatch && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        name?: string; command?: string; args?: unknown; passCredentials?: unknown;
      };
      try {
        const agent = await updateExternalAgent(extMatch[1], body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, agent }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    if (extMatch && req.method === "DELETE") {
      try {
        await deleteExternalAgent(extMatch[1]);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, agents: listExternalAgents() }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    // ── 项目文件夹：列表 / 添加（本地 / 云端 Git）/ 删除 / 刷新 ──
    if (pathname === "/api/projects" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ projects: listProjects(), activeProjectId: getActiveProjectId() }));
      return;
    }

    if (pathname === "/api/projects" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; type?: string; path?: string; url?: string };
      try {
        const project = await addProject(body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, project, projects: listProjects(), activeProjectId: getActiveProjectId() }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    if (pathname === "/api/projects/active" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { id?: string };
      try {
        setActiveProject(body.id ?? "");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, activeProjectId: getActiveProjectId() }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([\w-]+)$/);
    if (projectMatch && req.method === "DELETE") {
      try {
        await deleteProject(projectMatch[1]);
        const moved = (await import("./sessions.js")).moveSessions(projectMatch[1], "default");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, movedSessions: moved, projects: listProjects(), activeProjectId: getActiveProjectId() }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    if (pathname.match(/^\/api\/projects\/([\w-]+)\/refresh$/) && req.method === "POST") {
      const id = pathname.match(/^\/api\/projects\/([\w-]+)\/refresh$/)![1];
      try {
        const p = await refreshCloudProject(id);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, project: p }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    // ── 文件上下文：目录浏览 / 文件读取 / 远程文件夹授权 / 本地上传 ──
    // （注意：先 await 业务再 writeHead，失败才能正常回 4xx）
    if (pathname === "/api/fs/list" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { path?: string };
      try {
        const data = await listDir(body.path);
        // roots 拼上项目信息：前端据此区分 本地💻 / 云端☁️ 样式
        const byPath = new Map(listProjects().map((p) => [p.path, p]));
        const roots = data.roots.map((r) => {
          const p = byPath.get(r.path);
          return { ...r, type: p?.type ?? "local", projectId: p?.id ?? null, url: p?.url };
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ...data, roots }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    if (pathname === "/api/fs/read" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { path?: string };
      try {
        const data = await readFileAuthorized(body.path ?? "");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(data));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    if (pathname === "/api/fs/open-remote" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { path?: string };
      try {
        const data = await openRemoteRoot(body.path ?? "");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...data }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    if (pathname === "/api/files/upload" && req.method === "POST") {
      // 图片走 dataURL，体积比文本大 → 单独放宽请求体上限
      const body = JSON.parse((await readBody(req, 12_000_000)) || "{}") as {
        name?: unknown; content?: unknown; image?: unknown;
      };
      try {
        if (typeof body.name !== "string" || typeof body.content !== "string") {
          throw new Error("参数不完整（name / content）");
        }
        const data = storeUpload(body.name, body.content, body.image === true);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...data }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    if (pathname === "/api/chat" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        sessionId?: string; message?: unknown; files?: unknown;
      };
      try {
        await handleChat(res, req, body.sessionId ?? "", body);
      } catch (err) {
        // 附件解析等前置错误 → 400/413（此时流未开始）
        respondBadRequest(res, req, err);
      }
      return;
    }

    if (pathname === "/api/resume" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { sessionId?: string; decision?: unknown };
      await handleResume(res, req, body.sessionId ?? "", body);
      return;
    }

    // ── RAG（外部知识库服务）：配置 / 测试 / 入库 / 检索 / 清空 ──
    // 真实的向量存储与 embedding 由外部服务完成（契约见 src/server/rag.ts）
    if (pathname === "/api/rag" && req.method === "GET") {
      const rag = await getRagPublic();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(rag));
      return;
    }

    if (pathname === "/api/rag/config" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { baseURL?: string; apiKey?: unknown; collection?: unknown; topK?: unknown };
      try {
        const rag = await saveRagConfig({ ...body, baseURL: body.baseURL ?? "" });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, rag }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    if (pathname === "/api/rag/test" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { baseURL?: string; apiKey?: unknown };
      try {
        const r = await testRagConnection({
          baseURL: typeof body.baseURL === "string" && body.baseURL.trim() ? body.baseURL : undefined,
          apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (err) {
        if (err instanceof BodyTooLargeError) respondBadRequest(res, req, err);
        else {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
      }
      return;
    }

    if (pathname === "/api/rag/ingest" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { path?: string; name?: string; content?: string };
      try {
        let summary: unknown;
        if (typeof body.path === "string" && body.path.trim()) {
          summary = await ingestFolder(body.path); // 文件夹扫描批量入库（授权路径内）
        } else if (typeof body.content === "string" && typeof body.name === "string") {
          await ingestText(body.name, body.content, "手动粘贴");
          summary = { ingested: 1 };
        } else {
          throw new Error("需要 path（文件夹扫描入库）或 name + content（文本入库）");
        }
        const rag = await getRagPublic();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, summary, rag }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    if (pathname === "/api/rag/search" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { query?: string; topK?: number };
      try {
        const r = await searchRag(body.query ?? "", body.topK);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    const ragDocMatch = pathname.match(/^\/api\/rag\/docs\/([\w-]+)$/);
    if (ragDocMatch && req.method === "DELETE") {
      try {
        const rag = await deleteRagDoc(ragDocMatch[1]);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, rag }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    if (pathname === "/api/rag/clear" && req.method === "POST") {
      try {
        const rag = await clearRag();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, rag }));
      } catch (err) {
        respondBadRequest(res, req, err);
      }
      return;
    }

    // ── 房产 Agent（贝壳 CLI）：状态 / 一键安装 / 保存授权 Key ──
    // 注意 getEstatePublic 会真正探测一次 beike --version（毫秒级），必须 await
    if (pathname === "/api/estate" && req.method === "GET") {
      try {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(await getEstatePublic()));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ installed: false, error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (pathname === "/api/estate/install" && req.method === "POST") {
      await readBody(req); // 消费掉可能为空的请求体，参数无关紧要
      try {
        const status = await installBeike(); // 下载 ~32MB + 解压，可能要几十秒
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...status }));
      } catch (err) {
        if (err instanceof BodyTooLargeError) respondBadRequest(res, req, err);
        else {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
      }
      return;
    }

    if (pathname === "/api/estate/key" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { apiKey?: unknown };
      try {
        if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
          throw new Error("apiKey 不能为空：登录贝壳获取页面显示的完整凭证后粘贴");
        }
        // beike auth --save：Key 只进 CLI 本地凭证，工作台不落盘不回显
        const r = await saveBeikeKey(body.apiKey);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (err) {
        if (err instanceof BodyTooLargeError) respondBadRequest(res, req, err);
        else {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not Found" }));
  } catch (err) {
    // 请求体超限：统一 413 + 断开连接（readBody 已 pause 数据流，不会有残留累积）
    if (err instanceof BodyTooLargeError) {
      respondBadRequest(res, req, err);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, HOST, async () => {
  const mode = config.apiKey ? "真实模型" : "模拟模式（未配置 API_KEY）";
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(
    `\n  LangGraph Agent Web 已启动\n` +
    `  ➜  http://${displayHost}:${PORT}   (监听 ${HOST}:${PORT})\n` +
    `  模式: ${mode}   模型: ${config.model}   网关: ${config.baseURL}\n` +
    `  提示: 右上角 ⚙ 设置 可在线修改供应商 / API Key / 模型\n`
  );
  // 显式对外开放且未配置认证：给出不可忽略的警告（Phase 1 引入 AUTH_TOKEN 后此告警消失）
  if ((HOST === "0.0.0.0" || HOST === "::") && !AUTH_ENABLED) {
    console.warn(
      `  ⚠⚠⚠  HOST=${HOST} 且未配置 AUTH_TOKEN：本服务的接口可以修改配置 / 执行命令 / 消耗网关配额，\n` +
      `  ⚠⚠⚠  当前对局域网所有设备开放。仅限可信内网临时使用，公网场景必须先设置 AUTH_TOKEN。\n`
    );
  }
});
