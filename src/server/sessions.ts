/**
 * ============================================================
 * sessions.ts — Web 会话存储（内存版）
 * ============================================================
 * 会话分两种：
 *   - kind: "agent"  通用 Agent（默认，正常产品逻辑：工具 + 审批 + 多轮记忆）
 *   - kind: "demo"   内置示例（学习 Demo 1-4，图结构刻意保持教学形态）
 *
 * 每个会话一张图实例：
 *   - 通用 Agent / Demo 2 / Demo 3：编译时持有 MemorySaver，
 *     thread_id 绑定 session id → 多轮记忆与审批状态延续；
 *   - Demo 1 / Demo 4：教学上故意不带 checkpointer（展示无记忆的行为差异），本身无状态。
 *
 * 这是学习项目，故与 MemorySaver 一样选择「进程内存」方案：
 * 服务重启后会话即消失（前端会标注历史会话为「已失效」）。
 * 生产环境可换 SqliteSaver / PostgresSaver 并把 session 落库。
 */
import { randomUUID } from "node:crypto";
import { createBasicGraph } from "../agent/basic.js";
import { createMemoryGraph } from "../agent/memory.js";
import { createHitlGraph } from "../agent/hitl.js";
import { createMultiAgentGraph } from "../agent/multi.js";
import { createAgentGraph } from "../agent/general.js";
import { createEstateGraph } from "../agent/estate.js";
import { getExternalAgent } from "./external.js";
import {
  journalSession, journalDelete, journalApproval, journalDecided, journalTurn,
  replaySessions, journalSnapshot, maybeCompactJournal, type SessionRecord,
} from "./session-store.js";
import type { AgentEvent, InterruptPayload } from "./events.js";

export interface DemoMeta {
  id: 1 | 2 | 3 | 4;
  name: string;
  desc: string;
  example: string;
}

/** 内置示例（学习 Demo）：作为新建对话时的可选预设 */
export const DEMOS: DemoMeta[] = [
  { id: 1, name: "基础 ReAct", desc: "示例 · State / Node / 边 / 工具调用循环", example: "北京现在天气怎么样？顺便帮我算一下 (12+7)*3 等于多少？" },
  { id: 2, name: "对话记忆", desc: "示例 · Checkpointer + thread_id 多轮记忆", example: "我叫小明，请记住我" },
  { id: 3, name: "人工审批", desc: "示例 · interrupt() 暂停 + 人工批准/拒绝", example: "给 boss@example.com 发一封邮件，主题是项目进度" },
  { id: 4, name: "多 Agent", desc: "示例 · Supervisor 主管 + 员工子图协作", example: "帮我查一下北京的天气，然后写一首关于它的四行诗" },
];

export function isDemo(v: unknown): v is 1 | 2 | 3 | 4 {
  return v === 1 || v === 2 || v === 3 || v === 4;
}

export type SessionKind = "agent" | "estate" | "demo" | "external";

/** 一轮对话的服务端记录：用户消息 + 该轮全部 AgentEvent（供任意浏览器回放历史） */
export interface TurnRecord {
  /** 用户消息文本（审批/澄清恢复轮为「（批准/拒绝 xx）」「（需求澄清：…）」标记） */
  user: string;
  /** 随消息附加的文件元信息（与前端 user block 的 files 对应） */
  files?: Array<{ name: string; source: string; image: boolean }>;
  /** 该轮 SSE 推给前端的全部事件（含 usage/error/interrupt，不含 done） */
  events: AgentEvent[];
}

const MAX_TURN_RECORDS = 100;   // 每会话最多保留轮数
const MAX_RECORD_EVENTS = 3000; // 单轮事件数上限（异常防护）

export interface Session {
  id: string;
  kind: SessionKind;
  demo: 1 | 2 | 3 | 4 | null;
  /** kind === "external"：接入的第三方 Agent id（external.ts 注册表） */
  agentId: string | null;
  /** 归属的项目文件夹（"default" = 内置本仓库项目） */
  projectId: string;
  title: string;
  createdAt: number;
  /** 本会话的图实例（通用 Agent / Demo 2/3 的 checkpointer 记忆存于实例内） */
  graph: unknown;
  /** thread_id 与 session 绑定，同一会话多轮共享记忆 */
  threadId: string;
  /** Demo 3 / 需求澄清：是否正处于 interrupt 等待用户回复 */
  pendingApproval: InterruptPayload | null;
  /** 建图时的配置版本号 —— 配置变更后首次使用时按需重建图（见 rebuildIfStale） */
  configVersion: number;
  /** 已完成的对话轮数（供 mock 模式模拟用量递增 / 缓存命中率） */
  turns: number;
  /** 服务端对话记录（每轮用户消息 + 全部事件），任意浏览器都能回放历史 */
  turnHistory: TurnRecord[];
  /** T2-4：journal 回放来的会话，首次发消息时把历史轮注入为上文（随后置 false） */
  resumeUninjected: boolean;
  /** T2-3：重启后带 pendingApproval 的会话 —— 图 interrupt 状态无法恢复，resume 将给出明确引导 */
  resumeUnavailable: boolean;
  /** 上下文压缩摘要：下一轮真图调用时注入，替代被清空的旧线程记忆 */
  contextSummary: string | null;
  /** 摘要是否已注入当前线程（注入后不再重复占预算） */
  contextSummaryInjected: boolean;
}

const sessions = new Map<string, Session>();

/** 全局配置版本号：每次保存设置 +1；会话图版本落后时重建以套用新模型 */
let configVersionCounter = 1;
export function bumpConfigVersion(): void {
  configVersionCounter += 1;
}
export function currentConfigVersion(): number {
  return configVersionCounter;
}

export function buildGraph(kind: SessionKind, demo: 1 | 2 | 3 | 4 | null): unknown {
  if (kind === "agent") return createAgentGraph();
  // 房产 Agent：贝壳工具集 + 同一形态（ReAct + 记忆 + 审批），见 agent/estate.ts
  if (kind === "estate") return createEstateGraph();
  switch (demo) {
    case 1: return createBasicGraph();
    case 2: return createMemoryGraph();
    case 3: return createHitlGraph();
    case 4: return createMultiAgentGraph();
    default: return createAgentGraph();
  }
}

/**
 * 配置变更后该会话首次使用时：用当前配置重建图。
 * 注意：重建会得到新的 MemorySaver —— 通用 Agent / Demo 2/3 的多轮记忆
 * 因此重置（等价于「改配置后重启服务」，UI 会提示这一点）。
 */
export function rebuildIfStale(session: Session): boolean {
  if (session.kind === "external") return false; // 外部会话无图，不需要重建
  if (session.configVersion === configVersionCounter) return false;
  session.graph = buildGraph(session.kind, session.demo);
  session.configVersion = configVersionCounter;
  session.pendingApproval = null; // 旧图上的 interrupt 状态随重建失效
  if (session.contextSummary) session.contextSummaryInjected = false;
  return true;
}

export function createSession(kind: SessionKind, demo: 1 | 2 | 3 | 4 | null, projectId: string | undefined, title?: string, agentId?: string | null): Session {
  // 外部 Agent 会话不建 LangGraph：每条消息直接启动第三方工具的子进程（external.ts）
  const external = kind === "external" ? getExternalAgent(agentId ?? "") : undefined;
  if (kind === "external" && !external) throw new Error("外部 Agent 不存在或已被移除");
  const defaultTitle = external ? external.name
    : kind === "demo" ? `${DEMOS.find((d) => d.id === demo)?.name ?? "示例"} 示例`
    : kind === "estate" ? "房产找房"
    : "新对话";
  const session: Session = {
    id: randomUUID(),
    kind,
    demo: kind === "demo" ? demo : null,
    agentId: external?.id ?? null,
    projectId: projectId || "default",
    title: title?.trim() || defaultTitle,
    createdAt: Date.now(),
    graph: kind === "external" ? null : buildGraph(kind, demo),
    threadId: `web-${randomUUID()}`,
    pendingApproval: null,
    configVersion: currentConfigVersion(),
    turns: 0,
    turnHistory: [],
    resumeUninjected: false,
    resumeUnavailable: false,
    contextSummary: null,
    contextSummaryInjected: false,
  };
  sessions.set(session.id, session);
  // T2-2：创建即落 journal —— 白名单挑字段（Session 内含编译图/内存结构，严禁整只序列化）
  journalSession({
    id: session.id, kind: session.kind, demo: session.demo, agentId: session.agentId,
    projectId: session.projectId, title: session.title, createdAt: session.createdAt, threadId: session.threadId,
  });
  return session;
}

// ---------------------------------------------------------------------------
// 服务端对话记录：开始一轮 / 流结束后回填事件 / 读取
// ---------------------------------------------------------------------------

/** 流开始前调用：登记本轮的用户消息（files 与前端 user block 的 files 同形） */
export function beginTurnRecord(
  session: Session,
  user: string,
  files?: Array<{ name: string; source: string; image: boolean }>
): void {
  session.turnHistory.push({ user, files, events: [] });
  if (session.turnHistory.length > MAX_TURN_RECORDS) {
    session.turnHistory.splice(0, session.turnHistory.length - MAX_TURN_RECORDS);
  }
}

/** 流结束后调用：把该轮实际推送的事件挂到最后一条记录上（含被中止的部分轮） */
export function completeTurnRecord(session: Session, events: AgentEvent[]): void {
  const record = session.turnHistory.at(-1);
  if (!record) return;
  record.events = events.length > MAX_RECORD_EVENTS ? events.slice(-MAX_RECORD_EVENTS) : events;
  // T2-2：完整轮次落 journal（含被中止的部分轮；失败自吞，不影响回答流）
  journalTurn(session.id, record.user, record.files, record.events);
  void maybeCompactJournal(); // 后台探 journal 大小，超阈值自动 compact
}

export function getTurnHistory(session: Session): TurnRecord[] {
  return session.turnHistory;
}

/** 项目删除后，把其会话迁移到默认项目 */
export function moveSessions(fromProjectId: string, toProjectId: string): number {
  let moved = 0;
  for (const s of sessions.values()) {
    if (s.projectId === fromProjectId) {
      s.projectId = toProjectId;
      moved += 1;
    }
  }
  return moved;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): Session[] {
  return [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteSession(id: string): boolean {
  const gone = sessions.delete(id);
  if (gone) journalDelete(id); // T2-2：删除也落 journal（重启后同样消失）
  return gone;
}

/** 高风险工具进入人工审批 / 需求澄清进入等待（pending）：streamToClient 的 interrupt 分支调用 */
export function recordApproval(session: Session, payload: InterruptPayload): void {
  session.pendingApproval = payload;
  journalApproval(session.id, payload.type === "approval" ? payload.toolName : "clarification", payload);
}

/** 用户已做出决定（approve/reject/answered）：resume 完成回调里调用，一次性转移。
 *  坑：正常完成的 done 事件会先把内存 pendingApproval 清空，onDone 回调才执行
 *  —— 所以这里不能判断内存状态，journal 幂等（already decided 的 pending 会被回放层忽略）。
 *  若恢复过程中产生新 interrupt，streamToClient 会保留新 pending，onDone 不应再清空。 */
export function recordDecision(session: Session, status: "approved" | "rejected" | "answered"): void {
  journalDecided(session.id, status);

  session.pendingApproval = null;
}

// ---------------------------------------------------------------------------
// T2-2/T2-4：启动回放 —— journal → 内存会话（图新建成 MemorySaver 空态，
// 多轮记忆用「注入历史上文」续命；interrupt 状态不可恢复则明确标记）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T2-4：重启后历史注入 —— journal 回放的会话无 MemorySaver 历史线程，
// 第一轮真图调用时把最近几轮对话拼成一条「上文摘录」注入，让模型有连续上下文。
// 一次性：注入后 resumeUninjected 置 false，不重复占上下文预算。
// ---------------------------------------------------------------------------
const PREHISTORY_MAX_TURNS = 12;   // 最多注入最近 12 轮
const PREHISTORY_USER_MAX = 2_000; // 单轮用户话上限（字符）
const PREHISTORY_AI_MAX = 4_000;   // 单轮助手话上限（字符）

/** 这些 kind 的图带 checkpointer（多轮记忆），值得注入历史；其它（demo1/4 无记忆图）不必 */
function hasSessionMemory(kind: Session["kind"], demo: Session["demo"]): boolean {
  return kind === "agent" || kind === "estate" || kind === "external" || demo === 2 || demo === 3;
}

/** 取「上一轮文件发生前」的上文摘录；返回 null 表示无需注入。
 *  副作用：无论是否注入，调用一次后 resumeUninjected 置 false（只试一次）。 */
export function buildPrehistoryNote(session: Session): string | null {
  if (!session.resumeUninjected || !session.turnHistory.length) return null;
  session.resumeUninjected = false; // 无论注入成功与否只试一次（避免反复占上下文）
  if (!hasSessionMemory(session.kind, session.demo)) return null;
  const pasted: string[] = [];
  for (const t of session.turnHistory.slice(-PREHISTORY_MAX_TURNS)) {
    const ai = t.events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
    if (!ai.trim()) continue; // 纯工具/审批轮（无生成文本）不进摘录
    pasted.push(`用户: ${t.user.slice(0, PREHISTORY_USER_MAX)}`);
    pasted.push(`助手: ${ai.slice(0, PREHISTORY_AI_MAX)}`);
  }
  if (!pasted.length) return null;
  return `【以下是你此前（服务重启前）与用户的对话摘录，用于延续上下文；一切以用户新消息为准】\n\n${pasted.join("\n")}`;
}

/** 取出待注入的压缩摘要（一次性）。注入后线程记忆从摘要继续生长。 */
export function takeContextSummary(session: Session): string | null {
  if (!session.contextSummary || session.contextSummaryInjected) return null;
  session.contextSummaryInjected = true;
  return `【上下文压缩摘要（此前对话已被压缩，以下内容用于延续上下文）】\n\n${session.contextSummary}`;
}

export async function restoreSessions(): Promise<number> {
  await replaySessions();
  const records = journalSnapshot();
  let restored = 0;
  for (const rec of records) {
    const kind = rec.kind;
    // 已失效的外部 Agent / 未知 kind 仍保留会话壳（chat 时给出明确提示）
    const hasGraph = kind !== "external";
    const graph = hasGraph ? buildGraph(kind, rec.demo) : null;
    const pend = rec.pendingApproval;
    const session: Session = {
      id: rec.id,
      kind,
      demo: rec.demo,
      agentId: rec.agentId,
      projectId: rec.projectId,
      title: rec.title || "已恢复的对话",
      createdAt: rec.createdAt,
      graph,
      threadId: rec.threadId || `web-${randomUUID()}`,
      pendingApproval: pend && pend.status === "pending" ? (pend.payload as InterruptPayload) : null,
      configVersion: currentConfigVersion(),
      turns: rec.turns,
      turnHistory: rec.turnHistory.map((t) => ({
        user: t.user,
        files: t.files,
        events: t.events as AgentEvent[],
      })),
      // T2-3：pendingApproval 跨重启不可 resume（图 interrupt 状态未持久化）
      resumeUnavailable: Boolean(pend && pend.status === "pending"),
      // T2-4：带历史轮的会话在下一轮真图调用时注入上文
      resumeUninjected: rec.turns > 0,
      contextSummary: null,
      contextSummaryInjected: false,
    };
    sessions.set(session.id, session);
    restored += 1;
  }
  return restored;
}

/** （内部信息导出）当前恢复的会话数 —— 启动日志用 */
export function countSessions(): number {
  return sessions.size;
}
