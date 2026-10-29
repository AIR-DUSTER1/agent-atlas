/**
 * ============================================================
 * core/state.ts — 全局状态与本地持久化（唯一可变状态源）
 * ============================================================
 * 职责：集中声明前端运行时状态、localStorage 键名、对话块的读写入口。
 * 设计立场：
 *  - 整个前端只允许这一处放「跨模块可变状态」，其余模块通过 import state 读写，
 *    避免各模块私自持有副本导致「界面与数据不同步」；
 *  - localStorage 写入统一走 saveLocal（300ms 防抖），不允许别处直接 setItem；
 *  - 只存「用户可见的历史」：blocks / usage / 会话元数据 / 项目视图，
 *    不存配置与密钥（那些在服务端）。
 */

import { mergeAdjacentAssistantBlocks } from "../modules/chat-flow.js";
import type { AppState, ChatBlock } from "../modules/types.js";

/** 前端版本标记：改动前端源码后递增，用于确认浏览器跑的是不是最新脚本 */
export const APP_VERSION = "web-2026-10-29-35";

console.log(
  "%c[LangGraph Demo] 前端脚本已加载 " + APP_VERSION,
  "color:#fff;background:#5b8cff;padding:2px 8px;border-radius:4px"
);

export const LS_TRANSCRIPTS = "lg-agent-transcripts";
export const LS_SESSIONS = "lg-agent-sessions-meta";
export const LS_USAGE = "lg-agent-usage";
export const LS_PROJECT_VIEW = "lg-agent-project-view";
export const LS_THEME = "lg-agent-theme";


export const state: AppState = {
  config: null,        // { mock, model, baseURL, contextWindow, providers, demos }
  sessions: [],        // 会话列表（服务端内存态 + 本地残留标记）
  projects: [],        // [{id, name, type:"local"|"cloud", path, url?, builtin?}]
  externalAgents: [],  // 第三方接入的 Agent
  rag: null,           // 外部 RAG 状态
  estate: null,        // 贝壳 CLI 状态
  projectView: "all",  // "all" | projectId（侧栏过滤 + 新建会话归属）
  currentId: null,
  blocks: {},          // sessionId -> [block]
  usage: {},           // sessionId -> 本轮 usage
  streams: {},         // sessionId -> 正在流式的回合（不同会话可并行）
  compacting: {},      // sessionId -> /压缩上下文是否进行中（仅互斥同一会话）
  settingsView: "models",
  pendingFiles: [],    // 输入框待发送附件
};

/* ---------------------------------------------------------------------------
 * 流式渲染期间的 DOM 引用缓存（内存态，不参与持久化）
 * 放在这里是因为它们与 block/part 结构强绑定，多个渲染模块都要查。
 * ------------------------------------------------------------------------- */
export interface PartRefs {
  el: HTMLElement;
  textEl?: HTMLElement;
  metaEl?: HTMLElement;
}

export const partEls = new Map<object, PartRefs>();      // part -> 渲染所需 DOM 引用
export const blockBodies = new Map<object, HTMLElement>(); // assistant block -> 正文容器
export const textTimers = new Map<object, ReturnType<typeof setTimeout>>();
export const thinkingTimers = new Map<object, ReturnType<typeof setTimeout>>();
export const usageEls = new Map<object, HTMLElement>();   // assistant block -> 用量小字元素

/* ---------------------------------------------------------------------------
 * 本地持久化
 * ------------------------------------------------------------------------- */
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function loadLocal(): void {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_TRANSCRIPTS) || "{}") as unknown;
    state.blocks = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, ChatBlock[]>;
    // 旧版本审批恢复会追加连续 assistant 块；加载时合并，避免历史缓存继续多头像。
    for (const [sid, blocks] of Object.entries(state.blocks)) {
      if (Array.isArray(blocks)) state.blocks[sid] = mergeAdjacentAssistantBlocks(blocks);
    }
  } catch { state.blocks = {}; }
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_USAGE) || "{}") as unknown;
    state.usage = (parsed && typeof parsed === "object" ? parsed : {}) as AppState["usage"];
  } catch { state.usage = {}; }
  state.projectView = localStorage.getItem(LS_PROJECT_VIEW) || "all";
}

export function saveLocal(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_TRANSCRIPTS, JSON.stringify(state.blocks));
      localStorage.setItem(LS_USAGE, JSON.stringify(state.usage));
      localStorage.setItem(LS_PROJECT_VIEW, state.projectView);
      localStorage.setItem(LS_SESSIONS, JSON.stringify(
        state.sessions.map((s) => ({
          id: s.id, kind: s.kind, agentProfileId: s.agentProfileId,
          title: s.title, demo: s.demo, projectId: s.projectId, createdAt: s.createdAt,
        }))
      ));
    } catch { /* 存储已满等场景忽略 */ }
  }, 300);
}

/** 取某个会话的对话块数组（不存在则创建） */
export function transcript(sid: string | null): ChatBlock[] {
  if (!sid) return [];
  if (!state.blocks[sid]) state.blocks[sid] = [];
  return state.blocks[sid];
}

/** 当前选中会话 */
export function currentSession(): AppState["sessions"][number] | undefined {
  return state.sessions.find((s) => s.id === state.currentId);
}
