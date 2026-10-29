/**
 * task-budget.ts — 逻辑任务的跨审批工作台账
 * ============================================================
 * 职责：把一个「用户目标 + 多次审批/澄清/继续」视为同一个逻辑任务，维护
 * 工具/模型调用台账、活动时长、已读文件与关键结果；只驻留内存，不写 checkpoint。
 * 设计立场：只记录事实，不做墙钟中断；审批、澄清和工具等待不设自动超时，
 * 台账由 graph 通过 configurable 读取，避免审批后的下一次 ReAct 丢失探索记忆。
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
}

export interface TaskBudgetSnapshot {
  activeMs: number;
  toolCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
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
  };
  session.activeTask = task;
  for (const record of records.slice(start) as TurnRecord[]) {
    // 每个恢复轮次都是一个独立 usage 命名空间；否则各轮都从 usage-1 开始，
    // 会把不同模型调用错误合并成一次。
    task.segmentIndex += 1;
    for (const event of record.events) observeTaskEvent(session, event);
  }
  // 恢复只用于保留台账；长任务没有执行 / 调用次数预算，等待时间也不计活动时长。
  task.activeMs = 0;
  task.segmentStartedAt = undefined;
  task.interrupted = records.slice(start).some((record) => record.events.some((event) => event.type === "interrupt"));
  session.taskLedger = renderTaskLedger(task);
}

/** 开始一个执行片段；continuation=true 时继承同一任务。 */
export function beginTaskSegment(session: Session, continuation: boolean, user = ""): TaskRunState {
  if (!session.activeTask && CONTINUE_INTENT.test(user.trim())) rebuildTaskFromHistory(session);
  const preserve = continuation || (!continuation && CONTINUE_INTENT.test(user.trim()));
  const task = ensureTask(session, preserve, user || session.taskLedger || "继续当前任务");
  if (task.segmentStartedAt === undefined) task.segmentStartedAt = Date.now();
  task.segmentIndex += 1;
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
  session.taskLedger = renderTaskLedger(task);
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

/** 给模型的执行事实注记：只提醒效率，不施加调用次数 / 总时长限制。 */
export function renderTaskBudgetNote(session: Session): string {
  const task = session.activeTask;
  const snapshot = taskSnapshot(session);
  if (!task || !snapshot) return "";
  return `本逻辑任务已累计工具 ${snapshot.toolCalls} 次、模型 ${snapshot.modelCalls} 次、活动 ${Math.round(snapshot.activeMs / 1000)} 秒。系统不限制执行时长和调用次数；请基于台账推进目标，避免重复读取相同内容。`;
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
