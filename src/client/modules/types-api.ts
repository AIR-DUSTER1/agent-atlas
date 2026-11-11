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

/** 一道澄清题：选项 id 只在本道题内唯一，跨题可重复使用 A/B/C。 */
export interface ClarificationQuestion {
  id: string;
  question: string;
  options: ClarificationOption[];
  allowCustom: boolean;
}

/**
 * 载荷里的题面：id 允许缺省。
 * 新服务端一定会给 id，但历史 journal 与第三方构造可能没有；
 * 归一化时按顺序补 q1..qN，所以入参类型不能比运行时更严。
 */
export type ClarificationQuestionInput = Omit<ClarificationQuestion, "id"> & { id?: string };

/**
 * 澄清载荷：新形状是可多题的 questions 数组。
 * 历史 journal 与旧版服务端仍是单问形状（顶层 question + options），
 * 因此这里保留三个可选旧字段 —— 由 modules/clarify.ts 统一归一化后再渲染。
 */
export interface ClarificationPayload {
  type: "clarification";
  questions?: ClarificationQuestionInput[];
  /** @deprecated 旧单问载荷 */
  question?: string;
  /** @deprecated 旧单问载荷 */
  options?: ClarificationOption[];
  /** @deprecated 旧单问载荷 */
  allowCustom?: boolean;
}

export type InterruptPayload = ApprovalPayload | ClarificationPayload;

export type WorkflowStepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";
export type WorkflowPlanStatus = "running" | "completed" | "failed";

export interface WorkflowPlanStep {
  id: string;
  title: string;
  detail?: string;
  status: WorkflowStepStatus;
  note?: string;
}

/** 输入框上方流程窗体的完整快照；revision 单调递增，可安全覆盖旧状态。 */
export interface WorkflowPlanSnapshot {
  id: string;
  revision: number;
  goal: string;
  steps: WorkflowPlanStep[];
  status: WorkflowPlanStatus;
  activeStepId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 服务端 → 前端的规范化事件流；新增变体必须同步 stream/events.ts 的 switch */
export type AgentEvent =
  | { type: "node"; name: string }
  | { type: "reasoning"; text: string; node?: string }
  | {
      type: "model_retry";
      attempt: number;
      retries: number;
      totalAttempts: number;
      phase: "retry" | "success" | "failed";
      reason: string;
      at: number;
    }
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
      contextWindow?: number;
      contextInputBudget?: number;
      outputReserveTokens?: number;
      safetyMarginTokens?: number;
      taskInputTokens?: number;
      taskOutputTokens?: number;
      taskToolCalls?: number;
      taskModelCalls?: number;
      taskActiveMs?: number;
    }
  | { type: "interrupt"; payload: InterruptPayload }
  /** 自主执行流程快照；null 表示本轮没有流程，窗体隐藏。 */
  | { type: "workflow_plan"; plan: WorkflowPlanSnapshot | null }
  /** 无头模式自动采用的澄清假设：不挂起，但要让人知道「本该问什么」 */
  | {
      type: "clarification_note";
      question: string;
      assumption: string;
      optionId?: string;
    }
  /** 本轮结束时的任务累计用量（token 统计的权威口径，下游优先取它） */
  | {
      type: "task_usage";
      inputTokens: number;
      outputTokens: number;
      toolCalls: number;
      modelCalls: number;
      activeMs: number;
      interrupted?: boolean;
    }
  /** 路由决策卡片：派给谁 / 依据 / 来自哪一层（rule / vector / model / fallback） */
  | {
      type: "route_decision";
      kind: "dispatch" | "ask" | "main";
      layer: "rule" | "vector" | "model" | "fallback";
      agentId?: string;
      agentName?: string;
      confidence: number;
      margin: number;
      reason: string;
      candidates: Array<{ agentId: string; name: string; score: number }>;
      handoffCount: number;
    }
  | {
      type: "risk_decision";
      decision: "auto";
      toolName: string;
      reason: string;
      callId?: string;
    }
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
  contextInputBudget?: number;
  outputReserveTokens?: number;
  safetyMarginTokens?: number;
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

export interface ContextBudget {
  contextWindow: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
}

export interface AppConfig {
  mock: boolean;
  model: string;
  baseURL?: string;
  contextWindow: number | null;
  contextBudget?: ContextBudget;
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

export type SessionKind = "agent" | "estate" | "job" | "demo" | "external";

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

/** 内置插件的启停快照；platform 用于区分仅 Windows 的 Computer Use。 */
export interface PluginSettingsState {
  enabled: Record<"rag" | "estate" | "job" | "browser" | "computer", boolean>;
  platform: string;
}

export interface BrowserUseState {
  available: boolean;
  browserName: string;
  executableName: string;
  activeSessions: number;
  maxSessions: number;
  platform: string;
  error?: string;
}

export interface BrowserPageState {
  sessionId: string;
  active: boolean;
  busy: boolean;
  url: string;
  title: string;
  updatedAt: number;
  viewport: { width: number; height: number };
  error?: string;
}

/** 子代理模型：默认继承主对话，也可固定到已配置的供应商 × 模型。 */
export type SubagentModelSelection =
  | { mode: "inherit" }
  | { mode: "fixed"; providerId: string; modelId: string };

/** 子代理路由名片：规则层与决策模型共用；空关键词 + 空类别 = 不参与竞争。 */
export interface SubagentRouting {
  keywords: string[];
  category?: string;
  suitableFor: string[];
  notSuitableFor: string[];
  /** 继承哪个领域 profile 的系统提示（不填 = 通用后台子代理提示词） */
  domainProfile?: "general" | "estate" | "job";
}

export interface SubagentEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  model: SubagentModelSelection;
  routing: SubagentRouting;
  builtIn: boolean;
  createdAt: number;
  updatedAt: number;
  modelLabel: string;
  modelAvailable: boolean;
  /** 是否参与路由竞争（有类别或关键词） */
  routable: boolean;
}

export interface SubagentSettingsState {
  agents: SubagentEntry[];
}

export type RoutingBackendId = "openai-compat" | "systemone" | "rules-only";

export interface RoutingSettings {
  enabled: boolean;
  backend: RoutingBackendId;
  llm: {
    providerId: string | null;
    modelId: string | null;
    temperature: number;
    structuredOutput: boolean;
    maxOutputTokens: number;
  };
  systemone: { baseURL: string; expectedModel: string; apiKey: string };
  thresholds: {
    ruleAutoAccept: number;
    ruleMargin: number;
    vectorAccept: number;
    modelConfidence: number;
    candidateMargin: number;
  };
  limits: {
    hierarchicalAbove: number;
    maxIntents: number;
    maxCategories: number;
    maxHandoffs: number;
    maxPlanDispatches: number;
    maxIntentTextChars: number;
  };
  decideTimeoutMs: number;
}

export interface RoutingSnapshot {
  settings: RoutingSettings;
  hasSystemoneKey: boolean;
  vectorAvailable: boolean;
}

export interface RoutingTestResult {
  decision: {
    kind: "dispatch" | "ask" | "main";
    layer: "rule" | "vector" | "model" | "fallback";
    agentId?: string;
    agentName?: string;
    confidence: number;
    margin: number;
    reason: string;
    candidates: Array<{ agentId: string; name: string; score: number }>;
    handoffCount: number;
  };
  usedModel: boolean;
  usedVector: boolean;
  ruleScores: Array<{
    agentId: string;
    name: string;
    score: number;
    hits: string[];
    negatives: string[];
  }>;
  candidateCount: number;
}

export interface EstateState {
  installed: boolean;
  version?: string;
  viaPATH?: boolean;
  path?: string;
  error?: string;
  keyUrl?: string;
  loginRequired?: boolean;
}

/** 求职 Agent 内置浏览器与数据目录状态；对应 GET /api/job。 */
export interface JobState {
  installed: boolean;
  hasOverride: boolean;
  browserOK: boolean;
  browserName: string;
  browserError: string;
  dataDir: string;
  lastRunJobs: number;
  lastRunAt: string;
  profilePresent: boolean;
  platform: string;
  error?: string;
}

/** 求职站点结构诊断；对应 POST /api/job/diagnose。 */
export interface JobDiagnosisResponse {
  ok: boolean;
  summary: string;
  output: string;
  reportPath: string;
  error?: string;
  report: {
    at: string;
    overall: "OK" | "DEGRADED" | "BROKEN" | "BLOCKED";
    applied: Array<{ platform: string; selector: string; path: string }>;
    platforms: Array<{
      platform: string;
      verdict: "OK" | "DEGRADED" | "BROKEN" | "BLOCKED";
      cardCount: number;
      jobs: number;
      notes: string[];
      candidates: Array<{ selector?: string; verified?: boolean; titleRate?: number; linkRate?: number }>;
      snapshots: Record<string, string>;
    }>;
  };
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
  scope: { profileId: "general" | "estate" | "job"; userId: string };
  key: string;
  content: string;
  tags: string[];
  status: "candidate" | "active" | "stale" | "superseded" | "archived";
  category?: "preference" | "project_fact" | "correction" | "identity" | "other";
  confidence?: number;
  expiresAt?: number;
  staleAt?: number;
  lastConfirmedAt?: number;
  origin?: { mode: "manual" | "agent_tool" | "auto" | "import" | "http"; sessionId?: string; turnId?: string };
  replacedBy?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount?: number;
  source: "agent" | "user" | "import";
}

export interface MemoryHttpSettings {
  enabled: boolean;
  preset: "generic" | "hindsight";
  baseURL: string;
  authMode: "none" | "bearer";
  apiKey?: string;
  hasApiKey?: boolean;
  keyMasked?: string;
  timeoutMs: number;
  searchLimit: number;
  writeEnabled: boolean;
  banks: { general: string; estate: string; job: string };
}

export interface MemoryDistillationSettings {
  mode: "off" | "confirm" | "smart";
  maxPerTurn: number;
  hourlyLimit: number;
}

export interface MemoryEmbeddingSettings {
  enabled: boolean;
  preset: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey?: string;
  hasApiKey?: boolean;
  keyMasked?: string;
  timeoutMs: number;
  dimensions: number;
  minSimilarity: number;
}

export interface MemoryRetentionSettings {
  activePerScope: number;
  historyPerScope: number;
  staleGraceDays: number;
  preferenceDays: number;
  projectFactDays: number;
  correctionDays: number;
  identityDays: number;
}

export interface MemorySlotConfig {
  activeProvider: "local" | "http";
  local: { allowPII: boolean };
  http: MemoryHttpSettings;
  distillation: MemoryDistillationSettings;
  embedding: MemoryEmbeddingSettings;
  retention: MemoryRetentionSettings;
}

export interface MemoryProviderHealth {
  providerId: "local" | "http";
  status: "ok" | "degraded" | "unavailable";
  latencyMs?: number;
  message?: string;
}

export interface MemoryProviderSummary {
  id: "local" | "http";
  active: boolean;
  capabilities: { read: true; write: boolean; delete: boolean; search: true; health: boolean };
}

export interface MemorySlotStatus {
  activeProvider: "local" | "http";
  health: MemoryProviderHealth;
  providers: MemoryProviderSummary[];
  config: MemorySlotConfig;
  localStore: {
    state: string;
    file: string;
    storeDir: string;
    loaded: boolean;
    migratedFrom?: number;
    quarantinedTo?: string;
    message?: string;
    activeCount: number;
    candidateCount: number;
    staleCount: number;
    historyCount: number;
    eventCount: number;
    bytes?: number;
  };
  semantic: {
    enabled: boolean;
    model: string;
    indexed: number;
    dimensions: number;
    updatedAt: number | null;
    message?: string;
  };
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
