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
import { getActiveId, getActiveModality } from "../settings.js";
import { lifecycle } from "../lifecycle.js";
import { writeAudit } from "../audit.js";
import { log } from "../logging.js";
import type { AgentEvent } from "../events.js";
import { getActiveModelLabel } from "../settings.js";
import { incCounter, incGauge } from "../observability/metrics.js";
import { runWithModelSlot } from "../runtime/model-gate.js";
import {
  beginTaskSegment, endTaskSegment, observeTaskEvent, renderTaskBudgetNote,
  renderTaskLedger, taskLimit, taskSnapshot,
} from "../task-budget.js";

function friendlyModelError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const status = Number(/(?:HTTP\s*)?\b(408|429|5\d{2})\b/i.exec(message)?.[1] ?? 0);
  if (status === 408) return "模型供应商请求超时（408）。可稍后重试，系统不会自动重试以免消耗额外配额。";
  if (status === 429) return "模型供应商触发限流（429）。请稍后重试或切换供应商；系统不会自动重试以免消耗额外配额。";
  if (status >= 500) return `模型供应商暂时不可用（HTTP ${status}）。请稍后重试或切换供应商；本轮未自动重试。`;
  if (/timeout|timed out|TimeoutError|请求超过/i.test(message)) {
    return "模型请求超时，已停止本轮等待；系统不会自动重试以免消耗额外配额。";
  }
  if (/abort/i.test(message)) return "请求已取消。";
  return message;
}
function writeEvent(res: import("node:http").ServerResponse, event: AgentEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** 自主审批自动放行也属于 hitl 决定：安全日志必须能追溯，不能只留在会话事件里。 */
export function recordAutoApprovalAudit(
  session: Session,
  event: Extract<AgentEvent, { type: "risk_decision" }>
): void {
  writeAudit("hitl.decided", {
    sessionId: session.id,
    agentProfileId: session.agentProfileId,
    toolName: event.toolName,
    decision: "auto",
    source: "tool-risk",
    reason: event.reason,
    ...(event.callId ? { callId: event.callId } : {}),
  });
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
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, 15_000);
  heartbeat.unref();
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

  const turn = session.turnHistory.at(-1);
  const turnStartedAt = turn?.startedAt ?? Date.now();
  log("info", "agent_turn_started", {
    sessionId: session.id,
    turnId: turn?.turnId ?? "",
    agentProfileId: session.agentProfileId,
    kind: session.kind,
    provider: config.protocol,
    model: getActiveModelLabel() || "mock",
  });

  incGauge("agent_sse_active_streams", { kind: session.kind });
  const collected: AgentEvent[] = [];
  let sawInterrupt = false;
  let limitReason: string | undefined;
  const budgetLimits = {
    turnTimeoutMs: config.agentTurnTimeoutMs,
    idleTimeoutMs: config.agentIdleTimeoutMs,
    maxToolCalls: config.agentMaxToolCalls,
    maxModelCalls: config.agentMaxModelCalls,
  };
  // 看门狗不能只靠「下一条事件」触发：模型/网关完全卡住时事件永远不会到。
  // 每 2 秒检查活动时长、停滞与累计预算，命中后主动 abort graph 并给前端明确原因。
  let notifyLimit: (() => void) | undefined;
  const limitSignal = new Promise<void>((resolve) => { notifyLimit = resolve; });
  const limitNow = (): string | undefined => {
    if (limitReason) return limitReason;
    const exceeded = taskLimit(session, budgetLimits);
    if (!exceeded) return undefined;
    limitReason = exceeded.reason;
    if (session.activeTask) session.activeTask.limited = true;
    incCounter("agent_task_limits_total", { reason: exceeded.reason, kind: session.kind });
    const limitEvent: AgentEvent = { type: "error", message: exceeded.message };
    collected.push(limitEvent);
    if (!res.writableEnded) writeEvent(res, limitEvent);
    controller.abort(new DOMException(exceeded.message, "TaskLimitError"));
    notifyLimit?.();
    return exceeded.reason;
  };
  const watchdog = setInterval(() => { limitNow(); }, 2_000);
  watchdog.unref();
  try {
    // 续跑前先查一次累计预算；已经超限时不再启动新的图/模型请求。
    if (limitNow()) {
      // limitNow 已写出错误帧并 abort，直接进入统一收尾。
    } else {
      // 用 Promise.race 而不是裸 for-await：网关可能连「下一条事件」都不返回，
      // 这时只有看门狗能把 streamToClient 从 await 中释放出来，finally 才能收尾。
      const iterator = produce(controller.signal)[Symbol.asyncIterator]();
      let nextPromise = iterator.next();
      for (;;) {
        const outcome = await Promise.race([
          nextPromise.then((value) => ({ kind: "next" as const, value })),
          limitSignal.then(() => ({ kind: "limit" as const })),
        ]);
        if (outcome.kind === "limit") {
          // 生成器可能卡在底层 HTTP；先 abort，不阻塞 return（部分 SDK 的 return
          // 也要等连接关闭）。请求结束后由 finally 落 journal / 清理槽位。
          void iterator.return?.(undefined);
          break;
        }
        if (outcome.value.done) break;
        const event = outcome.value.value;
        // 处理完当前帧后提前取下一帧，让下一轮 race 不再复用已完成 Promise。
        nextPromise = iterator.next();
        if (controller.signal.aborted) break;
        observeTaskEvent(session, event);
        if (limitNow()) break;
        const snapshot = event.type === "usage" ? taskSnapshot(session) : null;
        const publicEvent: AgentEvent = event.type === "usage" && snapshot
          ? {
              ...event,
              taskInputTokens: snapshot.inputTokens,
              taskOutputTokens: snapshot.outputTokens,
              taskToolCalls: snapshot.toolCalls,
              taskModelCalls: snapshot.modelCalls,
              taskActiveMs: snapshot.activeMs,
            }
          : event;
        collected.push(publicEvent);
        writeEvent(res, publicEvent);
        if (event.type === "interrupt") {
          recordApproval(session, event.payload);
          sawInterrupt = true;
        }
        if (event.type === "risk_decision") {
          recordAutoApprovalAudit(session, event);
        }
        // interrupt 后图也会结束并补 done，此时必须保留 pending 等用户 resume；
        // 只有正常走完、没有新 interrupt 的流才清空（resume 的 onDone 在无新 interrupt 时也会再清一次）。
        if (event.type === "done" && !sawInterrupt) session.pendingApproval = null;
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      incCounter("agent_model_errors_total", { model: getActiveModelLabel() || "mock", reason: "stream" });
      const message = friendlyModelError(err);
      collected.push({ type: "error", message });
      writeEvent(res, { type: "error", message });
    }
  } finally {
    clearInterval(heartbeat);
    clearInterval(watchdog);
    unregisterSse();
    incGauge("agent_sse_active_streams", { kind: session.kind }, -1);
    endTaskSegment(session);
    const turnStatus = limitReason
      ? `limited:${limitReason}`
      : controller.signal.aborted
        ? "aborted"
        : collected.some((event) => event.type === "error")
          ? "error"
          : sawInterrupt ? "waiting" : "completed";
    incCounter("agent_sse_streams_total", {
      kind: session.kind,
      agentProfileId: session.agentProfileId ?? "none",
      status: turnStatus,
    });
    if (clientGone) incCounter("agent_sse_disconnects_total", { kind: session.kind });
    // 被中止的部分轮也入档：历史回放时能看到「说了半截 + 停止」的真实经过
    onDone?.(collected);
    log("info", "agent_turn_finished", {
      sessionId: session.id,
      turnId: turn?.turnId ?? "",
      agentProfileId: session.agentProfileId,
      kind: session.kind,
      provider: config.protocol,
      model: getActiveModelLabel() || "mock",
      status: turnStatus,
      events: collected.length,
      durationMs: Math.max(0, Date.now() - turnStartedAt),
      taskLimited: limitReason,
    });
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
  // 配置在会话创建后被改过 → 先用当前配置重建图（产品图共享持久检查点，
  // 重建不再丢对话记忆；demo 2/3 的记忆仍会随重建重置）
  await rebuildIfStale(session);

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
  beginTaskSegment(session, false, message);

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
  await runWithModelSlot(getActiveId(), () => streamToClient(res, req, session, (signal) =>
    runGraphEvents(session.graph as Parameters<typeof runGraphEvents>[0], { messages: graphInput }, {
      threadId: session.threadId,
      signal,
      agentProfileId: session.agentProfileId,
      turnId: session.turnHistory.at(-1)?.turnId,
      permissionMode: session.permissionMode,
      taskLedger: renderTaskLedger(session.activeTask),
      budgetNote: renderTaskBudgetNote(session, {
        turnTimeoutMs: config.agentTurnTimeoutMs,
        idleTimeoutMs: config.agentIdleTimeoutMs,
        maxToolCalls: config.agentMaxToolCalls,
        maxModelCalls: config.agentMaxModelCalls,
      }),
    })
  , (events) => completeTurnRecord(session, events)));
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
  // 配置变更后不重建审批中的图：resume 必须回到产生 interrupt 的同一图实例，
  // 让本次 resume 在原图上完成（配置从下一条消息起生效）
  if (!approval) await rebuildIfStale(session);

  if (!config.apiKey && clarification) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "模拟模式不支持澄清恢复，请配置模型后重新发起请求" }));
    return;
  }

  // 审批/澄清决定是安全边界动作：审计只记会话/工具/决定，不落具体参数或用户补充内容
  if (approval) {
    writeAudit("hitl.decided", {
      sessionId: session.id,
      agentProfileId: session.agentProfileId,
      toolName: approval.type === "approval" ? approval.toolName : "clarification",
      decision: clarification ? "answered" : resumeValue,
    });
  }

  if (approval?.type === "approval") {
    incCounter("agent_approvals_total", {
      tool: approval.toolName,
      agentProfileId: session.agentProfileId ?? "none",
      outcome: resumeValue === "approve" ? "approved" : "rejected",
    });
  }

  const recordUser = clarification
    ? `（需求澄清：${resumeValue.slice(0, 60)}）`
    : `（人工审批：${resumeValue === "approve" ? "批准" : "拒绝"} ${approval?.type === "approval" ? approval.toolName : "操作"}）`;
  beginTurnRecord(session, recordUser, undefined, true);
  beginTaskSegment(session, true, recordUser);

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
  await runWithModelSlot(getActiveId(), () => streamToClient(
    res,
    req,
    session,
    (signal) => runGraphEvents(
      session.graph as Parameters<typeof runGraphEvents>[0],
      buildResumeCommand(resumeValue),
      {
        threadId: session.threadId,
        signal,
        agentProfileId: session.agentProfileId,
        turnId: session.turnHistory.at(-1)?.turnId,
        permissionMode: session.permissionMode,
        taskLedger: renderTaskLedger(session.activeTask),
        budgetNote: renderTaskBudgetNote(session, {
          turnTimeoutMs: config.agentTurnTimeoutMs,
          idleTimeoutMs: config.agentIdleTimeoutMs,
          maxToolCalls: config.agentMaxToolCalls,
          maxModelCalls: config.agentMaxModelCalls,
        }),
      }
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
  ));
}
