/**
 * routes/chat.ts — /api/chat 与 /api/resume 路由（对话 + 审批决定，SSE 流式回包）
 * ============================================================
 * 从 index.ts 拆出的「聊天域」：一条 SSE 生成器绑会话（真实图 / mock / 外部子进程），
 * 限流用 limits.ts，停不下来的部分轮也入档。协议坑（done 是兜底写的，不进事件循环）见内。
 */
import { config } from "../../config.js";
import { runGraphEvents } from "../stream.js";
import { mockRun } from "../mock.js";
import { assertChatInterval, acquireSessionSlot } from "../limits.js";
import { runExternalAgent, getExternalAgent } from "../external.js";
import { analyzeEstateTurn } from "../estate.js";
import { resolveChatFiles, buildUserContent, type ChatFileRef } from "../files.js";
import { ingestChatAttachments } from "../rag.js";
import {
  getSession, rebuildIfStale, beginTurnRecord, completeTurnRecord,
  recordApproval, recordDecision, buildPrehistoryNote, takeContextSummary, type Session,
} from "../sessions.js";
import { getActiveModality } from "../settings.js";
import { lifecycle } from "../lifecycle.js";
import { writeAudit } from "../audit.js";
import type { AgentEvent } from "../events.js";

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
  // 登记 SSE 连接：优雅退出时 lifecycle 先写 shutdown 帧再 abort，客户端能区分
  // 「服务在重启」与「网络断了」；卸载放在 finally，避免已结束连接被反复通知。
  const unregisterSse = lifecycle.registerSse(res, () => controller.abort());
  // 客户端断开检测：ServerResponse 的 close 在「响应未写完就断连」时才是真正的中止信号
  // （req 的 close 在请求体读完时就会触发，不能用来判断断连）
  res.on("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort();
    }
  });

  const collected: AgentEvent[] = [];
  let sawInterrupt = false;
  try {
    for await (const event of produce(controller.signal)) {
      if (controller.signal.aborted) break;
      collected.push(event);
      writeEvent(res, event);
      if (event.type === "interrupt") {
        recordApproval(session, event.payload);
        sawInterrupt = true;
      }
      // interrupt 后图也会结束并补 done，此时必须保留 pending 等用户 resume；
      // 只有正常走完、没有新 interrupt 的流才清空（resume 的 onDone 在无新 interrupt 时也会再清一次）。
      if (event.type === "done" && !sawInterrupt) session.pendingApproval = null;
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      const message = err instanceof Error ? err.message : String(err);
      collected.push({ type: "error", message });
      writeEvent(res, { type: "error", message });
    }
  } finally {
    unregisterSse();
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

export async function handleChat(
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
  // /compact 后的新线程：旧消息已清空，只注入压缩摘要（一次性）
  const compactNote = takeContextSummary(session);
  const graphInput: unknown[] = [
    ...(preNote ? [new HumanMessage(preNote)] : []),
    ...(compactNote ? [new HumanMessage(compactNote)] : []),
    new HumanMessage(fullMessage),
  ];
  await streamToClient(res, req, session, (signal) =>
    runGraphEvents(session.graph as Parameters<typeof runGraphEvents>[0], { messages: graphInput }, {
      threadId: session.threadId,
      signal,
    })
  , (events) => completeTurnRecord(session, events));
}

export async function handleResume(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage,
  sessionId: string,
  body: { decision?: unknown; choice?: unknown }
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "会话不存在或服务已重启" }));
    return;
  }

  const pending = session.pendingApproval;
  let resumeValue: string;
  if (pending?.type === "clarification") {
    const choice = typeof body.choice === "string" ? body.choice.trim() : "";
    if (!choice) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "请选择一个选项或输入补充说明" }));
      return;
    }
    resumeValue = choice.slice(0, 2_000);
  } else {
    // 没有待处理事项却发送 choice：说明前端状态已过期，明确拒绝而不是静默当审批拒绝
    if (!pending && typeof body.choice === "string" && body.choice.trim()) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "当前没有待确认的选项，请重新发起请求" }));
      return;
    }
    resumeValue = body.decision === "approve" ? "approve" : "reject";
  }

  // T2-5：审批/澄清恢复也是流，同样走同会话唯一流闸
  const releaseSlot = acquireSessionSlot(sessionId);
  try {
    await handleResumeInner(res, req, session, resumeValue);
  } finally {
    releaseSlot();
  }
}

async function handleResumeInner(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage,
  session: Session,
  resumeValue: string
): Promise<void> {
  const approval = session.pendingApproval;
  const clarification = approval?.type === "clarification" ? approval : null;
  // T2-3：重启后带 pendingApproval 的会话 —— 图的 interrupt 状态已不可恢复，
  // 重复 resume 是明确错误，必须让用户重新发起（不允许静默重复执行）
  if (approval && session.resumeUnavailable) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    const error = clarification
      ? "服务重启后该澄清的上下文已失效，无法继续。请重新发起原来的请求。"
      : `服务重启后该审批的执行上下文已失效，无法继续（不重复执行、也不静默重做）。` +
        `请重新发起这个请求，例如：「${approval.type === "approval" ? approval.toolName : "操作"}」的那条指令再发一次。`;
    res.end(JSON.stringify({ error }));
    return;
  }
  // 配置变更后不重建审批中的图：旧图的 interrupt 状态无法跨 checkpointer 恢复，
  // 让本次 resume 在原图上完成（配置从下一条消息起生效）
  if (!approval) rebuildIfStale(session);

  if (!config.apiKey && clarification) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "模拟模式不支持澄清恢复，请配置模型后重新发起请求" }));
    return;
  }

  // 审批/澄清决定是安全边界动作：审计只记会话/工具/决定，不落具体参数或用户补充内容
  if (approval) {
    writeAudit("hitl.decided", {
      sessionId: session.id,
      toolName: approval.type === "approval" ? approval.toolName : "clarification",
      decision: clarification ? "answered" : resumeValue,
    });
  }

  const recordUser = clarification
    ? `（需求澄清：${resumeValue.slice(0, 60)}）`
    : `（人工审批：${resumeValue === "approve" ? "批准" : "拒绝"} ${approval?.type === "approval" ? approval.toolName : "操作"}）`;
  beginTurnRecord(session, recordUser);

  if (!config.apiKey) {
    const approved = approval?.type === "approval" ? approval : undefined;
    await streamToClient(
      res,
      req,
      session,
      (signal) => mockRun({ decision: resumeValue as "approve" | "reject", approval: approved, turnIndex: session.turns, signal }),
      (events) => {
        // T2-3：决定已做出 → journal 记 decided（一次性转移），再把本轮入档。
        // 若恢复过程中又产生新 interrupt（例如连续两个高风险工具），保留新 pending。
        if (!events.some((event) => event.type === "interrupt")) {
          recordDecision(session, resumeValue === "approve" ? "approved" : "rejected");
        }
        completeTurnRecord(session, events);
      }
    );

    return;
  }

  // 真实图：用 Command({ resume }) 把决定送回被暂停的图（见 agent/hitl.ts / workflow.ts）
  const { buildResumeCommand } = await import("../../agent/hitl.js");
  await streamToClient(
    res,
    req,
    session,
    (signal) => runGraphEvents(
      session.graph as Parameters<typeof runGraphEvents>[0],
      buildResumeCommand(resumeValue),
      { threadId: session.threadId, signal }
    ),
    (events) => {
      if (!events.some((event) => event.type === "interrupt")) {
        recordDecision(
          session,
          clarification ? "answered" : resumeValue === "approve" ? "approved" : "rejected"
        );
      }
      completeTurnRecord(session, events);
    }
  );
}
