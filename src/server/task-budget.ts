/**
 * task-budget.ts — 逻辑任务的跨审批预算与工作台账
 * ============================================================
 * 职责：把一个「用户目标 + 多次审批/澄清/继续」视为同一个逻辑任务，维护
 * 工具/模型调用预算、活动时长、已读文件与关键结果；只驻留内存，不写 checkpoint。
 * 设计立场：预算按执行片段累计（等待人审批的时间不算），台账在每次模型调用前
 * 由 graph 通过 configurable 读取最新版本，避免审批后的下一次 ReAct 丢失探索记忆。
 */
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "./events.js";
import type { Session, TurnRecord } from "./sessions.js";

export interface TaskToolRecord {
  id: string;
  name: string;
  args: string;
  result: string;
  status: "running" | "success" | "error";
}

export interface TaskRunState {
  id: string;
  startedAt: number;
  activeMs: number;
  segmentStartedAt?: number;
  lastActivityAt: number;
  goal: string;
  notes: string[];
  toolCalls: Map<string, TaskToolRecord>;
  /** 实际工具调用总数；不随台账裁剪而减少。 */
  toolCallCount: number;
  modelCallIds: Set<string>;
  /** callId → 该调用的 input/output 峰值；流式分片不能直接累加。 */
  usagePeaks?: Record<string, { input: number; output: number }>;
  /** 每次执行片段递增，避免 usage-1 这类局部 callId 跨 continuation 被误合并。 */
  segmentIndex: number;
  inputTokens: number;
  outputTokens: number;
  interrupted: boolean;
  /** 用户显式「继续」后开启新的预算窗口；累计成本仍保留。 */
  budgetBaseActiveMs: number;
  budgetBaseToolCalls: number;
  budgetBaseModelCalls: number;
  limited: boolean;
}

export interface TaskBudgetSnapshot {
  activeMs: number;
  toolCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export type TaskLimitReason = "timeout" | "idle" | "tools" | "models";

export interface TaskLimit {
  reason: TaskLimitReason;
  message: string;
  used: number;
  limit: number;
}

const MAX_LEDGER_CHARS = 4_000;
const MAX_TOOL_RESULT_IN_LEDGER = 280;
/** 工具台账保留最近 N 个已结束调用；running 的流式卡片最多保留 32 个。 */
const MAX_TOOL_RECORDS = 40;
const MAX_NOTES = 6;
const MAX_LEDGER_TOOLS = 24;

function ensureTask(session: Session, preserve: boolean, user: string): TaskRunState {
  const now = Date.now();
  if (!session.activeTask || !preserve) {
    session.activeTask = {
      id: randomUUID(),
      startedAt: now,
      activeMs: 0,
      lastActivityAt: now,
      goal: user.replace(/\s+/g, " ").trim().slice(0, 500),
      notes: [],
      toolCalls: new Map(),
      toolCallCount: 0,
      modelCallIds: new Set(),
      usagePeaks: {},
      segmentIndex: 0,
      inputTokens: 0,
      outputTokens: 0,
      interrupted: false,
      budgetBaseActiveMs: 0,
      budgetBaseToolCalls: 0,
      budgetBaseModelCalls: 0,
      limited: false,
    };
    session.taskLedger = "";
  }
  return session.activeTask;
}

const CONTINUE_INTENT = /^(继续|继续吧|继续执行|接着|接着做|continue)[。.!！]?$/i;

/** 重启后首次「继续」时从最近一轮任务重建台账；不扫描整个历史仓库。 */
function rebuildTaskFromHistory(session: Session): void {
  const records = session.turnHistory;
  if (!records.length) return;
  let start = records.length - 1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record.continuation && !CONTINUE_INTENT.test(record.user.trim())) {
      start = index;
      break;
    }
  }
  const task: TaskRunState = {
    id: randomUUID(),
    startedAt: Date.now(),
    activeMs: 0,
    lastActivityAt: Date.now(),
    goal: records[start]?.user.slice(0, 500) || "继续当前任务",
    notes: [],
    toolCalls: new Map(),
    toolCallCount: 0,
    modelCallIds: new Set(),
    usagePeaks: {},
    segmentIndex: 0,
    inputTokens: 0,
    outputTokens: 0,
    interrupted: false,
    budgetBaseActiveMs: 0,
    budgetBaseToolCalls: 0,
    budgetBaseModelCalls: 0,
    limited: false,
  };
  session.activeTask = task;
  for (const record of records.slice(start) as TurnRecord[]) {
    // 每个恢复轮次都是一个独立 usage 命名空间；否则各轮都从 usage-1 开始，
    // 会把不同模型调用错误合并成一次。
    task.segmentIndex += 1;
    for (const event of record.events) observeTaskEvent(session, event);
  }
  // 恢复只用于保留台账；预算窗口从下一次用户动作重新开始。
  task.activeMs = 0;
  task.segmentStartedAt = undefined;
  task.budgetBaseToolCalls = task.toolCallCount;
  task.budgetBaseModelCalls = task.modelCallIds.size;
  task.budgetBaseActiveMs = 0;
  task.interrupted = records.slice(start).some((record) => record.events.some((event) => event.type === "interrupt"));
  session.taskLedger = renderTaskLedger(task);
}

/** 开始一个执行片段；continuation=true 时继承同一任务。 */
export function beginTaskSegment(session: Session, continuation: boolean, user = ""): TaskRunState {
  if (!session.activeTask && CONTINUE_INTENT.test(user.trim())) rebuildTaskFromHistory(session);
  const explicitContinue = !continuation && CONTINUE_INTENT.test(user.trim());
  const preserve = continuation || explicitContinue;
  const task = ensureTask(session, preserve, user || session.taskLedger || "继续当前任务");
  if (explicitContinue) {
    // 用户主动「继续」= 新预算窗口，但保留台账和已读工具；累计 token/工具不清零。
    task.budgetBaseActiveMs = task.activeMs;
    task.budgetBaseToolCalls = task.toolCallCount;
    task.budgetBaseModelCalls = task.modelCallIds.size;
    task.limited = false;
  }
  if (task.segmentStartedAt === undefined) task.segmentStartedAt = Date.now();
  task.segmentIndex += 1;
  task.lastActivityAt = Date.now();
  task.interrupted = false;
  if (user && task.goal !== user.slice(0, 500)) {
    task.notes.push(user.slice(0, 300));
    if (task.notes.length > MAX_NOTES) task.notes.splice(0, task.notes.length - MAX_NOTES);
  }
  session.taskLedger = renderTaskLedger(task);
  return task;
}

/** 结束执行片段；审批等待时间不计入 activeMs。 */
export function endTaskSegment(session: Session): void {
  const task = session.activeTask;
  if (!task?.segmentStartedAt) return;
  task.activeMs += Math.max(0, Date.now() - task.segmentStartedAt);
  task.segmentStartedAt = undefined;
  task.lastActivityAt = Date.now();
  session.taskLedger = renderTaskLedger(task);
}

export interface TaskBudgetLimits {
  turnTimeoutMs: number;
  idleTimeoutMs: number;
  maxToolCalls: number;
  maxModelCalls: number;
}

export function taskSnapshot(session: Session): TaskBudgetSnapshot | null {
  const task = session.activeTask;
  if (!task) return null;
  const running = task.segmentStartedAt ? Date.now() - task.segmentStartedAt : 0;
  return {
    activeMs: task.activeMs + running,
    toolCalls: task.toolCallCount,
    modelCalls: task.modelCallIds.size,
    inputTokens: task.inputTokens,
    outputTokens: task.outputTokens,
  };
}

function modelKey(event: Extract<AgentEvent, { type: "usage" }>): string {
  if (event.callId) return event.callId;
  return `${event.model ?? ""}|${event.inputTokens}|${event.outputTokens}|${event.node ?? ""}`;
}

/** 观察一个 SSE 事件并更新任务台账；只读，不改变 graph 状态。 */
export function observeTaskEvent(session: Session, event: AgentEvent): void {
  const task = session.activeTask;
  if (!task) return;
  task.lastActivityAt = Date.now();
  if (event.type === "tool_call") {
    const previous = task.toolCalls.get(event.id);
    const record = previous ?? { id: event.id, name: "", args: "", result: "", status: "running" as const };
    if (!previous) task.toolCallCount += 1;
    if (event.name) record.name = event.name;
    record.args = (record.args + (event.argsFragment || "")).slice(0, 1_500);
    task.toolCalls.set(event.id, record);
    if (task.toolCalls.size > MAX_TOOL_RECORDS) {
      const first = task.toolCalls.keys().next().value;
      if (first) task.toolCalls.delete(first);
    }
  } else if (event.type === "tool_result") {
    const record = task.toolCalls.get(event.id) ?? { id: event.id, name: "unknown", args: "", result: "", status: "success" as const };
    record.result = event.content.slice(0, MAX_TOOL_RESULT_IN_LEDGER);
    record.status = event.isError ? "error" : "success";
    task.toolCalls.set(event.id, record);
  } else if (event.type === "usage") {
    // 流式 usage 是累计快照；按 callId 取峰值，避免分片相加。
    const key = `${task.segmentIndex}:${modelKey(event)}`;
    if (!task.modelCallIds.has(key)) task.modelCallIds.add(key);
    const peakKey = key;
    const peaks = task.usagePeaks ??= {};
    const previous = peaks[peakKey] ?? { input: 0, output: 0 };
    const next = {
      input: Math.max(previous.input, event.inputTokens),
      output: Math.max(previous.output, event.outputTokens),
    };
    peaks[peakKey] = next;
    task.inputTokens += Math.max(0, next.input - previous.input);
    task.outputTokens += Math.max(0, next.output - previous.output);
  } else if (event.type === "interrupt") {
    task.interrupted = true;
  }
  session.taskLedger = renderTaskLedger(task);
}

/** 返回本轮是否已越过预算；调用方负责 abort 与产出 turn_limit。 */
export function renderTaskBudgetNote(session: Session, limits: TaskBudgetLimits): string {
  const task = session.activeTask;
  const snapshot = taskSnapshot(session);
  if (!task || !snapshot) return "";
  const windowActiveMs = Math.max(0, snapshot.activeMs - task.budgetBaseActiveMs);
  const windowToolCalls = Math.max(0, snapshot.toolCalls - task.budgetBaseToolCalls);
  const windowModelCalls = Math.max(0, snapshot.modelCalls - task.budgetBaseModelCalls);
  return `本预算窗口已用工具 ${windowToolCalls}/${limits.maxToolCalls} 次、模型 ${windowModelCalls}/${limits.maxModelCalls} 次、活动 ${Math.round(windowActiveMs / 1000)} 秒。信息足够时请直接完成，不要重复探索。`;
}

export function taskLimit(session: Session, limits: TaskBudgetLimits): TaskLimit | null {
  const task = session.activeTask;
  if (!task) return null;
  const snapshot = taskSnapshot(session);
  if (!snapshot) return null;
  const windowActiveMs = Math.max(0, snapshot.activeMs - task.budgetBaseActiveMs);
  const windowToolCalls = Math.max(0, snapshot.toolCalls - task.budgetBaseToolCalls);
  const windowModelCalls = Math.max(0, snapshot.modelCalls - task.budgetBaseModelCalls);
  if (windowActiveMs > limits.turnTimeoutMs) {
    return { reason: "timeout", used: windowActiveMs, limit: limits.turnTimeoutMs,
      message: `任务执行已超过 ${Math.round(limits.turnTimeoutMs / 60_000)} 分钟，已停止以免继续消耗配额。` };
  }
  if (Date.now() - task.lastActivityAt > limits.idleTimeoutMs) {
    return { reason: "idle", used: Date.now() - task.lastActivityAt, limit: limits.idleTimeoutMs,
      message: `已连续 ${Math.round(limits.idleTimeoutMs / 1_000)} 秒没有收到模型或工具事件，已停止等待；可稍后重试或换模型。` };
  }
  if (windowToolCalls > limits.maxToolCalls) {
    return { reason: "tools", used: windowToolCalls, limit: limits.maxToolCalls,
      message: `本任务工具调用已达到 ${limits.maxToolCalls} 次上限，已停止继续探索。请缩小任务范围或直接说明下一步。` };
  }
  if (windowModelCalls > limits.maxModelCalls) {
    return { reason: "models", used: windowModelCalls, limit: limits.maxModelCalls,
      message: `本任务模型调用已达到 ${limits.maxModelCalls} 次上限，已停止以免继续消耗配额。` };
  }
  return null;
}

/** 生成给模型的工作台账；不包含原始工具输出，只保留可复用事实。 */
export function renderTaskLedger(task: TaskRunState | null | undefined): string {
  if (!task) return "";
  // 同参数的多次读取合并成一条并标注次数，防止台账本身被重复探索挤满。
  const unique = new Map<string, { tool: TaskToolRecord; count: number }>();
  for (const tool of task.toolCalls.values()) {
    const key = `${tool.name}|${tool.args.replace(/\s+/g, " ").trim()}`;
    const previous = unique.get(key);
    if (previous) {
      previous.count += 1;
      previous.tool = tool;
    } else {
      unique.set(key, { tool, count: 1 });
    }
  }
  const tools = [...unique.values()].slice(-MAX_LEDGER_TOOLS);
  const toolLines = tools.map(({ tool, count }) => {
    const args = tool.args.replace(/\s+/g, " ").slice(0, 180);
    const result = tool.result.replace(/\s+/g, " ").slice(0, MAX_TOOL_RESULT_IN_LEDGER);
    return `- ${tool.name || "tool"}(${args})${count > 1 ? ` ×${count}` : ""} [${tool.status}]${result ? `：${result}` : ""}`;
  });
  const lines = [
    "【任务台账（跨审批/澄清保持）】",
    `目标：${task.goal || "（未记录）"}`,
    task.notes.length ? `最近用户补充：${task.notes.join("；")}` : "",
    tools.length ? `已完成工具（最近 ${tools.length} 个）：\n${toolLines.join("\n")}` : "已完成工具：暂无",
    task.interrupted
      ? "状态：此前有审批/澄清中断；继续时请复用上面的结果，不要从零重复探索。"
      : "状态：执行中。若已有足够信息，请直接修改或回答；不要重复读取同一文件。",
  ].filter(Boolean);
  return lines.join("\n").slice(0, MAX_LEDGER_CHARS);
}
