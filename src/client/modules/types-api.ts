/**
 * ============================================================
 * types-api.ts — 前端共享类型：与后端契约的唯一映射点
 * ============================================================
 * 职责：把 server/events.ts 的事件协议与各 /api 响应形状集中声明。
 * 设计立场：
 *  - 事件类型与 src/server/events.ts 保持同构；后端改协议时这里必须同步
 *    （两处都有注释指向对方，避免「前端漏接新事件」这种静默失效）；
 *  - 只放类型，不放运行时代码 —— 编译后被完全擦除，不影响产物体积；
 *  - UI 内部结构（Block/Part）在 types-ui.ts，由 types.ts 统一再导出。
 */

/* ---------------------------------------------------------------------------
 * SSE 事件协议（与 src/server/events.ts 一一对应）
 * ------------------------------------------------------------------------- */

export interface ApprovalPayload {
  type: "approval";
  toolName: string;
  description: string;
  args: Record<string, unknown>;
  /** 自主模式下由模型评估出的风险理由（审批卡展示用） */
  riskReason?: string;
}

export interface ClarificationOption {
  id: string;
  label: string;
  description?: string;
}

export interface ClarificationPayload {
  type: "clarification";
  question: string;
  options: ClarificationOption[];
  allowCustom: boolean;
}

export type InterruptPayload = ApprovalPayload | ClarificationPayload;

/** 服务端 → 前端的规范化事件流；新增变体必须同步 stream/events.ts 的 switch */
export type AgentEvent =
  | { type: "node"; name: string }
  | { type: "reasoning"; text: string; node?: string }
  | { type: "token"; text: string; node?: string }
  | { type: "tool_call"; id: string; name?: string; argsFragment: string }
  | { type: "tool_result"; id: string; content: string; isError?: boolean }
  | { type: "ai_message"; content: string; node?: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens: number;
      model?: string;
      callId?: string;
      node?: string;
      internal?: boolean;
    }
  | { type: "interrupt"; payload: InterruptPayload }
  | { type: "shutdown"; message: string }
  | { type: "error"; message: string }
  | { type: "done" };

/* ---------------------------------------------------------------------------
 * 配置（GET /api/config）
 * ------------------------------------------------------------------------- */

export interface ModelEntry {
  id: string;
  name: string;
  displayName: string;
  modality: "text" | "vision";
  active: boolean;
  contextWindow: number | null;
  contextWindowSource?: "manual" | "gateway" | "default";
  manualContextWindow?: number | null;
  reasoningLevel?: string;
  reasoningLabel: string;
  reasoningDialect?: string;
  reasoning?: { dialect?: string; level?: string; custom?: string };
}

export interface ProviderEntry {
  id: string;
  name: string;
  baseURL: string;
  protocol: string;
  active: boolean;
  hasKey: boolean;
  keyMasked?: string;
  models: ModelEntry[];
}

export interface ReasoningLevel {
  id: string;
  label: string;
  desc: string;
}

export interface ReasoningState {
  dialect?: string;
  dialectLabel?: string;
  vendor?: string;
  level?: string;
  label?: string;
  scheme?: string;
  levels?: ReasoningLevel[];
  auto?: boolean;
  error?: string;
}

export interface DialectInfo {
  id: string;
  label: string;
  vendor: string;
  field: string;
  scheme: string;
  levels: ReasoningLevel[];
  protocols?: string[];
}

export interface DemoInfo {
  id: number;
  name: string;
  desc: string;
  example: string;
}

export interface AppConfig {
  mock: boolean;
  model: string;
  baseURL?: string;
  contextWindow: number | null;
  providers: ProviderEntry[];
  dialects?: DialectInfo[];
  reasoning?: ReasoningState;
  demos: DemoInfo[];
}

/** 网关 /models 探测返回的单个模型（设置页 chips 用） */
export interface GatewayModel {
  id: string;
  contextWindow?: number | null;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
}

/* ---------------------------------------------------------------------------
 * 会话 / 项目 / 外部 Agent
 * ------------------------------------------------------------------------- */

export type SessionKind = "agent" | "estate" | "demo" | "external";

export type PermissionModeId = "readonly" | "approve" | "autonomous" | "auto";

export interface Session {
  id: string;
  kind: SessionKind;
  agentProfileId?: string;
  demo?: number | null;
  agentId?: string;
  projectId: string;
  title: string;
  createdAt: number;
  pendingApproval?: boolean;
  permissionMode?: PermissionModeId;
  /** 服务端已无此会话（重启后仅本地残留）：只读 */
  stale?: boolean;
  /** 前端内部：首条消息已改过标题 */
  _renamed?: boolean;
}

export interface ProjectEntry {
  id: string;
  name: string;
  type: "local" | "cloud";
  path: string;
  url?: string;
  builtin?: boolean;
}

export interface ExternalAgent {
  id: string;
  name: string;
  url: string;
  description?: string;
  command: string;
  args: string[];
  passCredentials?: boolean;
}

/* ---------------------------------------------------------------------------
 * RAG / 房产 / 备份 / 记忆 / 统计
 * ------------------------------------------------------------------------- */

export interface RagDoc {
  id: string;
  name: string;
  bytes: number;
  at: number;
  source?: string;
}

export interface RagState {
  configured: boolean;
  baseURL?: string;
  apiKeyMasked?: string;
  hasKey?: boolean;
  collection?: string;
  topK?: number;
  docs?: RagDoc[];
}

export interface RagHit {
  name?: string;
  source?: string;
  score?: number | string;
  text?: string;
}

export interface EstateState {
  installed: boolean;
  version?: string;
  viaPATH?: boolean;
  path?: string;
  error?: string;
  keyUrl?: string;
}

export interface BackupEntry {
  name: string;
  createdAt: number;
  files: string[];
  manifestVersion?: 1 | 2;
  secrets?: "encrypted" | "plaintext-risk" | "none" | "unknown";
  verified?: boolean;
}

export interface MemoryEntry {
  id: string;
  key: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  source: "agent" | "manual";
}

export interface StatsTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  sessions: number;
  delegateCalls: number;
  modelCalls?: number;
}

export interface StatsDay {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
}

export interface StatsModelRow {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface StatsHourRow {
  hour: number;
  turns: number;
  tokens: number;
}

export interface StatsToolRow {
  name: string;
  count: number;
}

export interface StatsHealth {
  avgTurnMs: number;
  cacheHitRate: number;
  failedTurns: number;
  interruptedTurns: number;
}

export interface StatsSessionRow {
  sessionId: string;
  title: string;
  turns: number;
  tokens: number;
}

export interface StatsRange {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  totals: StatsTotals;
  byDay: StatsDay[];
  byModel: StatsModelRow[];
  byModelShare: StatsModelRow[];
  byHour: StatsHourRow[];
  toolCalls: StatsToolRow[];
  health: StatsHealth;
  topSessions: StatsSessionRow[];
}

export interface StatsResult {
  generatedAt: number;
  ranges: StatsRange[];
}

/* ---------------------------------------------------------------------------
 * 文件上下文（附件）与文件浏览
 * ------------------------------------------------------------------------- */

export interface FsRef {
  kind: "fs";
  path: string;
  name: string;
  source?: string;
}

export interface UploadRef {
  kind: "upload";
  uploadId: string;
  name: string;
  source?: string;
  /** dataURL 预览（图片附件） */
  preview?: string | null;
}

export type PendingFile = FsRef | UploadRef;

export interface FsEntry {
  name: string;
  type: "file" | "dir";
  size: number;
}

export interface FsRoot {
  path: string;
  name: string;
  type?: "local" | "cloud";
}

export interface FsListResult {
  path: string;
  parent: string | null;
  roots: FsRoot[];
  entries: FsEntry[];
}
