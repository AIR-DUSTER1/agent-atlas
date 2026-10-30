/**
 * ============================================================
 * types-ui.ts — 前端 UI 内部结构（对话块 / 部件 / 输入框菜单）
 * ============================================================
 * 职责：一「轮」对话的数据形状 —— Block 与 Part 的可辨识联合、输入框 / @
 * 菜单项，以及全局状态与 Electron 桥。
 * 设计立场：
 *  - 可辨识联合（p / t 字段）让 switch 穷尽检查生效：新增部件类型时
 *    所有渲染分支会编译失败，而不是运行时静默漏渲染；
 *  - Block / Part 都会写进 localStorage（历史回放），改名等于数据迁移：
 *    加字段必须可选、删字段要兼容旧缓存。
 */

import type {
  AgentEvent, ApprovalPayload, ClarificationPayload, MemoryEntry,
  PermissionModeId, ProjectEntry, Session,
} from "./types-api.js";

/* ---------------------------------------------------------------------------
 * 助手回合内的部件
 * ------------------------------------------------------------------------- */

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface UsageInfo {
  lastInput: number;
  lastOutput: number;
  lastCache: number;
  /** 一个逻辑任务内所有主/内部模型调用的累计 token（跨审批、跨「继续」）。 */
  taskInput?: number;
  taskOutput?: number;
  /** 实际工具调用数；流式分片不重复计数。 */
  taskTools?: number;
  /** 主模型 + 内部模型调用次数。 */
  taskModels?: number;
  /** 活动时长（等待审批的墙钟时间不计入）。 */
  taskActiveMs?: number;
  /** 最近一次模型/工具/重试事件时间，用于前端显示「等待模型响应」。 */
  lastActivityAt?: number;
  /**
   * 当前会话的上下文用量峰值。切换模型时保留该历史事实，只更新分母，
   * 直到新模型返回下一轮权威 usage。
   */
  contextTokens?: number;
  /** 当前目标模型的窗口容量；切换模型后同步更新，已发生的 used 不清零。 */
  contextWindow?: number | null;
  /** 当前目标模型的输入预算（窗口扣除输出预留与安全余量）。 */
  contextInputBudget?: number | null;
  /** 输出预留与安全余量，用于容量条解释为什么未用满窗口。 */
  outputReserveTokens?: number;
  safetyMarginTokens?: number;
  /** 新请求已发出但还没收到主模型 usage；期间展示上一轮，收到后允许下调。 */
  contextPending?: boolean;
  /** 每个 callId 的用量峰值（流式快照会递增，不是增量）。 */
  usagePeaks?: Record<string, { input: number; output: number }>;
  /** 每个 callId 已计入任务的峰值；用于历史回放覆盖同一快照时只补差额。 */
  taskUsagePeaks?: Record<string, { input: number; output: number }>;
  /** 已计数的工具调用 id，避免流式分片重复增加工具次数。 */
  seenToolIds?: Set<string>;
}

export interface TextPart {
  p: "text";
  text: string;
  streaming?: boolean;
}

export interface ThinkingPart {
  p: "thinking";
  node: string;
  text: string;
  streaming?: boolean;
  /** 该节点的静态 chip 已被这张思考卡吸收（不再重复渲染） */
  nodeSeen?: boolean;
}

export interface NodePart {
  p: "node";
  name: string;
}

export interface ModelRetryPart {
  p: "model_retry";
  records: Array<{
    attempt: number;
    retries: number;
    totalAttempts: number;
    phase: "retry" | "success" | "failed";
    reason: string;
    at: number;
  }>;
}

export interface ToolPart {
  p: "tool";
  id: string;
  name: string;
  argsText: string;
  result: ToolResult | null;
}

export interface ApprovalPart {
  p: "approval";
  req: ApprovalPayload;
  status: "pending" | "approved" | "rejected" | "resolved";
  collapsed?: boolean;
}

export interface ClarificationPart {
  p: "clarification";
  req: ClarificationPayload;
  status: "pending" | "answered";
  answer?: string;
}

export type AssistantPart =
  | TextPart
  | ThinkingPart
  | NodePart
  | ModelRetryPart
  | ToolPart
  | ApprovalPart
  | ClarificationPart;

/* ---------------------------------------------------------------------------
 * 对话块
 * ------------------------------------------------------------------------- */

export interface UserBlock {
  t: "user";
  text: string;
  /** 发送时的附件元信息（不含内容） */
  files?: Array<{ name: string; source: string; image?: boolean }>;
  _el?: HTMLElement;
}

export interface AssistantBlock {
  t: "assistant";
  parts: AssistantPart[];
  _usage?: UsageInfo;
  _el?: HTMLElement;
  _typing?: HTMLElement | null;
}

export interface NoticeBlock {
  t: "notice";
  title: string;
  text: string;
  loading?: boolean;
  summary?: string;
  _el?: HTMLElement;
}

export interface ErrorBlock {
  t: "error";
  text: string;
  _el?: HTMLElement;
}

export type ChatBlock = UserBlock | AssistantBlock | NoticeBlock | ErrorBlock;

/** 服务端 transcript 回放的单轮记录 */
export interface TranscriptRecord {
  user?: string;
  files?: Array<{ name: string; source: string; image?: boolean }>;
  events?: AgentEvent[];
  continuation?: boolean;
  /** journal 存储投影：有值时说明该轮发生过 usage 归并/事件上限裁剪 */
  storage?: {
    originalEvents: number;
    storedEvents: number;
    droppedEvents: number;
    eventLimit: number;
    mergedTokenChunks: number;
    mergedReasoningChunks: number;
    reasoningCharsDropped: number;
    dedupedUsageEvents: number;
  };
}

/* ---------------------------------------------------------------------------
 * 输入框弹出菜单（/ 命令与 @ 文件搜索）
 * ------------------------------------------------------------------------- */

export interface SlashCommand {
  id: string;
  icon: string;
  label: string;
  desc: string;
  keywords: string;
}

export interface ComposerFileItem {
  type: "file";
  file: { path: string; name: string; rootName?: string; rel?: string; size: number };
}

export interface ComposerCommandItem extends SlashCommand {
  type: "command";
  /** 用户自定义命令的提示词模板；内置命令没有该字段 */
  template?: string;
}

export type ComposerItem = ComposerFileItem | ComposerCommandItem;

export interface ComposerTrigger {
  char: "/" | "@";
  query: string;
  start: number;
  end: number;
}

/* ---------------------------------------------------------------------------
 * 全局状态
 * ------------------------------------------------------------------------- */

import type { AppConfig, PendingFile, RagState, EstateState, ExternalAgent, PluginSettingsState, SubagentSettingsState } from "./types-api.js";

export interface SessionStreamState {
  ctrl: AbortController;
  sid: string;
  ablock: AssistantBlock;
}

export interface AppState {
  config: AppConfig | null;
  sessions: Session[];
  projects: ProjectEntry[];
  externalAgents: ExternalAgent[];
  rag: RagState | null;
  estate: EstateState | null;
  plugins: PluginSettingsState | null;
  subagents: SubagentSettingsState | null;
  projectView: string;
  projCollapsed: string[];
  currentId: string | null;
  blocks: Record<string, ChatBlock[]>;
  usage: Record<string, UsageInfo>;
  /** 会话 id → 正在运行的 SSE 回合；允许多个会话并行生成。 */
  streams: Record<string, SessionStreamState>;
  /** 会话 id → 是否正在压缩上下文；只互斥同一会话。 */
  compacting: Record<string, boolean>;
  settingsView: string;
  pendingFiles: PendingFile[];
  /** 记忆 / 统计等懒加载分区的缓存（目前主要给插件卡片判定） */
  memories?: MemoryEntry[];
}

/** Electron 桌面端注入的桥（浏览器里为 undefined） */
export interface DesktopBridge {
  isElectron?: boolean;
  setOverlayTheme?: (dark: boolean) => void | Promise<boolean>;
  /** Electron 原生目录选择框；浏览器模式没有该桥，服务端接口兜底。 */
  pickDirectory?: () => Promise<{ canceled: boolean; path?: string; error?: string }>;
}

/** 页面内对话框（ui-dialog.ts）的选项 */


export type { PermissionModeId, Session, ProjectEntry, MemoryEntry };
