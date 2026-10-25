/* ============================================================
   app.js — LangGraph Agent 学习 Demo 前端
   参考 ZCode 聊天界面：流式回答 / 工具调用卡片 / 人工审批 / 会话侧栏
   无框架、无构建：原生 JS + SSE。通用件拆在 modules/（原生 ESM）：
     modules/format.js    Markdown 渲染 / token 与字节格式化 / 图标与 URL 白名单
     modules/ui-dialog.js 全局错误横幅 / 页面内 alert/confirm/prompt 组件
   ============================================================ */
"use strict";

import {
  escapeHtml, renderInline, renderMarkdown, fmtArgs, fmtTokens, fmtSize,
  reasoningTag, safeImageSrc, safeHref, nodeIcon, nodeLabel, NODE_ICONS, TOOL_ICONS,
} from "./modules/format.js";
import { cancelActiveDialog, showFatalBanner, uiAlert, uiConfirm, uiPrompt } from "./modules/ui-dialog.js";
import { AGENT_PROFILES, profileMetaForSession } from "./modules/agent-profile.js";

/** 前端版本标记：改动 app.js 后递增，用于确认浏览器跑的是不是最新脚本 */
const APP_VERSION = "web-2026-10-25-1";
console.log(
  "%c[LangGraph Demo] 前端脚本已加载 " + APP_VERSION,
  "color:#fff;background:#5b8cff;padding:2px 8px;border-radius:4px"
);

/* ---------------------------------------------------------------------------
 * 全局状态
 * ------------------------------------------------------------------------- */
const state = {
  config: null,        // { mock, model, baseURL, contextWindow, providers, demos }
  sessions: [],        // { id, kind, agentProfileId, demo, agentId, projectId, title, createdAt, stale?, pendingApproval? }
  projects: [],        // [{id, name, type:"local"|"cloud", path, url?, builtin?}]
  externalAgents: [],  // [{id, name, url, command, args, ...}] 第三方接入的 Agent
  rag: null,           // { configured, baseURL, apiKeyMasked, collection, topK, docs } 外部 RAG 状态
  estate: null,        // { installed, version?, viaPATH?, keyUrl, ... } 贝壳 CLI 状态
  projectView: "all",  // "all" | projectId（侧栏过滤 + 新建会话归属）
  currentId: null,
  blocks: {},          // sessionId -> [block]
  usage: {},           // sessionId -> { contextTokens, lastInput, lastOutput, lastCache }
  streaming: null,     // { ctrl, sid, ablock }
  compacting: false,   // /压缩上下文 请求进行中（与 SSE streaming 互斥）
};

/** 流式期间每个 part 对应的 DOM 引用（内存 Map，不参与持久化） */
const partEls = new Map();      // part -> 渲染所需 DOM 引用
const blockBodies = new Map();  // assistant block -> 正文容器
const textTimers = new Map();   // part -> 节流定时器
const usageEls = new Map();     // assistant block -> 用量小字元素

const FILE_MENTION_LIMIT = 20;
const SLASH_COMMANDS = [
  {
    id: "compact",
    icon: "🗜️",
    label: "压缩上下文",
    desc: "把当前会话整理成摘要，释放上下文空间",
    keywords: "compact 压缩 上下文 摘要",
  },
];
const composerMenu = {
  kind: null,       // "slash" | "file"
  items: [],
  active: 0,
  trigger: null,    // { char, query, start, end }
  loading: false,
  error: "",
  searchSeq: 0,
  searchTimer: 0,
  ctrl: null,
};

const LS_TRANSCRIPTS = "lg-agent-transcripts";
const LS_SESSIONS = "lg-agent-sessions-meta";
const LS_USAGE = "lg-agent-usage";
const LS_PROJECT_VIEW = "lg-agent-project-view";
const LS_THEME = "lg-agent-theme";

/* ---------------------------------------------------------------------------
 * 主题切换：深色（默认）/ 浅色。html[data-theme] 驱动 CSS 变量整体换肤；
 * localStorage 持久化，<head> 里的内联脚本在样式应用前恢复，避免闪白/闪黑。
 * ------------------------------------------------------------------------- */
function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function updateThemeBtn() {
  const btn = $("theme-btn");
  if (!btn) return;
  const light = currentTheme() === "light";
  btn.textContent = light ? "🌙" : "☀️";
  btn.title = light ? "切换到深色主题" : "切换到浅色主题";
  // Electron 桌面端：窗口控制键（右上角原生三按钮）颜色跟随应用主题；
  // 浏览器环境没有 window.desktop，静默跳过
  window.desktop?.setOverlayTheme?.(!light);
}

function toggleTheme() {
  const next = currentTheme() === "light" ? "dark" : "light";
  if (next === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(LS_THEME, next); } catch { /* 隐私模式等 */ }
  updateThemeBtn();
}

/* ---------------------------------------------------------------------------
 * 窄屏抽屉式侧栏：☰ 开关 + 遮罩点击关闭；选中会话/项目后自动收起。
 * 桌面宽屏下侧栏常驻，open 类只在 ≤860px 媒体查询里有样式效果。
 * ------------------------------------------------------------------------- */
function setSidebarOpen(open) {
  const sb = $("sidebar");
  if (!sb) return;
  sb.classList.toggle("open", open);
  const scrim = $("sidebar-scrim");
  if (scrim) scrim.classList.toggle("hidden", !open);
}

/* ---------------------------------------------------------------------------
 * DOM 快捷方式
 * ------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const chatScroll = $("chat-scroll");
const messagesEl = $("messages");
const welcomeEl = $("welcome");
const inputEl = $("input");
const sendBtn = $("send-btn");
const stopBtn = $("stop-btn");

const DEMO_BADGE_TEXT = { 1: "示例 1 · 基础 ReAct", 2: "示例 2 · 对话记忆", 3: "示例 3 · 人工审批", 4: "示例 4 · 多 Agent" };

/** 会话列表短标签：Agent profile 走元数据，demo / external 保留各自语义。 */
function sessionTagText(session) {
  if (session.kind === "external") return "外部";
  if (session.kind === "demo") return `示例 ${session.demo}`;
  return profileMetaForSession(session)?.shortLabel ?? "未知";
}
/** 请求协议 → 徽标短文案（openai 是默认，不显示徽标） */
const PROTOCOL_LABEL = {
  "openai-responses": "Responses",
  "anthropic": "Anthropic",
  "gemini": "Gemini",
};

/** 通用 Agent 的常规示例（点击 → 新建通用 Agent 会话并预填） */
const GENERAL_EXAMPLES = [
  "帮我算一下 (128+512)*3，再看看现在几点了",
  "查一下北京的天气，适合穿什么",
  "给 boss@example.com 发一封邮件，主题是周报",
  "附加一个文件，帮我总结它的要点（用 📎 选择）",
];

/* ---------------------------------------------------------------------------
 * 会话持久化（localStorage）—— 服务端会话是内存态，重启即失；
 * 前端负责把对话内容留在本地，刷新/重启后仍可查看历史。
 * ------------------------------------------------------------------------- */
function loadLocal() {
  try {
    state.blocks = JSON.parse(localStorage.getItem(LS_TRANSCRIPTS) || "{}");
  } catch { state.blocks = {}; }
  try {
    state.usage = JSON.parse(localStorage.getItem(LS_USAGE) || "{}");
  } catch { state.usage = {}; }
  state.projectView = localStorage.getItem(LS_PROJECT_VIEW) || "all";
}
function saveLocal() {
  clearTimeout(saveLocal._t);
  saveLocal._t = setTimeout(() => {
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
function transcript(sid) {
  if (!state.blocks[sid]) state.blocks[sid] = [];
  return state.blocks[sid];
}

/* ---------------------------------------------------------------------------
 * API 封装
 * ------------------------------------------------------------------------- */
/** 服务端开启 Bearer 认证（AUTH_TOKEN）时的访问令牌，持久在 localStorage */
const LS_AUTH_TOKEN = "lg-agent-auth-token";

function getAuthToken() {
  try { return localStorage.getItem(LS_AUTH_TOKEN) || ""; } catch { return ""; }
}

/** 401 时收集 token：预填上次的值；取消则抛错阻止继续（不弹第二次） */
async function ensureAuthToken(hint) {
  const token = await uiPrompt(hint || "服务已开启访问认证，请输入访问令牌（服务端 .env 的 AUTH_TOKEN）：", {
    title: "访问认证", okText: "连接",
    default: getAuthToken(), password: true,
  });
  if (token == null) throw new Error("未提供访问令牌，请求已取消");
  const trimmed = token.trim();
  try { localStorage.setItem(LS_AUTH_TOKEN, trimmed); } catch { /* 隐私模式 */ }
  return trimmed;
}

/**
 * 401 自愈的 fetch 包装：带 Bearer 头；收到 401 弹框收集 token 后重试一次。
 * 权限/同源类 403 不重试（弹框也解决不了），错误文案直接透传。
 */
async function authFetch(path, options = {}, retried = false) {
  const token = getAuthToken();
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", "Bearer " + token);
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && !retried) {
    await ensureAuthToken("访问令牌无效（可能与服务端不一致），请重新输入：");
    return authFetch(path, options, true);
  }
  return res;
}

async function api(path, options) {
  const res = await authFetch(path, options);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ---------------------------------------------------------------------------
 * 项目文件夹（本地 💻 / 云端 ☁️ Git 仓库）
 * ------------------------------------------------------------------------- */
function projectById(id) {
  return state.projects.find((p) => p.id === id);
}

function projectIcon(p) { return p?.type === "cloud" ? "☁️" : "📁"; }

async function loadProjects() {
  try {
    const data = await api("/api/projects");
    state.projects = data.projects || [];
    if (state.projectView !== "all" && !projectById(state.projectView)) state.projectView = "all";
    renderProjectSwitcher();
    renderSessions();
  } catch { /* 服务重启等 */ }
}

function showProjectMenu(show) {
  $("project-menu").classList.toggle("hidden", !show);
}

function renderProjectSwitcher() {
  const view = state.projectView;
  const active = view === "all" ? null : projectById(view);
  $("project-btn-icon").textContent = active ? projectIcon(active) : "🗂";
  $("project-btn-text").textContent = active ? active.name : "全部项目";

  const menu = $("project-menu");
  menu.innerHTML = "";

  const all = document.createElement("button");
  all.className = "pm-item" + (view === "all" ? " active" : "");
  all.innerHTML = `<span class="pm-ic">🗂</span><span>全部项目</span><span class="pm-check">${view === "all" ? "✓" : ""}</span>`;
  all.addEventListener("click", async () => { state.projectView = "all"; saveLocal(); showProjectMenu(false); setSidebarOpen(false); renderProjectSwitcher(); renderSessions(); });
  menu.appendChild(all);

  for (const p of state.projects) {
    const item = document.createElement("div");
    item.className = "pm-item" + (view === p.id ? " active" : "");
    item.style.display = "flex";
    item.innerHTML = `
      <span class="pm-ic">${projectIcon(p)}</span>
      <span class="pm-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
      <span class="pm-sub ${p.type}">${p.type === "cloud" ? "云端" : "本地"}</span>
      ${p.type === "cloud" ? '<button class="pm-x pm-refresh" title="git pull 刷新缓存">⟳</button>' : ""}
      ${p.builtin ? "" : '<button class="pm-x pm-del" title="删除项目">✕</button>'}
      <span class="pm-check">${view === p.id ? "✓" : ""}</span>`;
    item.querySelector(".pm-name").textContent = p.name;
    item.addEventListener("click", (e) => {
      if (e.target.closest(".pm-x")) return; // 删除/刷新按钮单独处理
      state.projectView = p.id;
      saveLocal();
      showProjectMenu(false);
      setSidebarOpen(false); // 窄屏抽屉：选中项目即收起
      renderProjectSwitcher();
      renderSessions();
    });
    const refresh = item.querySelector(".pm-refresh");
    if (refresh) refresh.addEventListener("click", async (e) => {
      e.stopPropagation();
      refresh.textContent = "…";
      try {
        await api(`/api/projects/${p.id}/refresh`, { method: "POST" });
      } catch (err) { uiAlert(`刷新失败：${err.message}`, "刷新云端文件夹"); }
      refresh.textContent = "⟳";
    });
    const del = item.querySelector(".pm-del");
    if (del) del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await uiConfirm(
        `删除项目「${p.name}」？${p.type === "cloud" ? "\n云端缓存副本将一并删除。" : ""}\n其会话会迁移到 learn-agent 项目。`,
        { title: "删除项目", okText: "删除", danger: true }
      );
      if (!ok) return;
      try {
        await api(`/api/projects/${p.id}`, { method: "DELETE" });
        await loadProjects();
        if (state.projectView === p.id) { state.projectView = "all"; saveLocal(); }
        renderProjectSwitcher();
        renderSessions();
      } catch (err) { uiAlert(`删除失败：${err.message}`, "删除项目"); }
    });
    menu.appendChild(item);
  }

  const divider = document.createElement("div");
  divider.className = "pm-divider";
  menu.appendChild(divider);

  const addLocal = document.createElement("button");
  addLocal.className = "pm-item pm-manage";
  addLocal.textContent = "💻 添加本地文件夹（服务器路径）";
  addLocal.addEventListener("click", () => { showProjectMenu(false); addProjectFolder("local"); });
  menu.appendChild(addLocal);

  const addCloud = document.createElement("button");
  addCloud.className = "pm-item pm-manage";
  addCloud.textContent = "☁️ 添加云端文件夹（Git 仓库）";
  addCloud.addEventListener("click", () => { showProjectMenu(false); addProjectFolder("cloud"); });
  menu.appendChild(addCloud);
}

async function addProjectFolder(type) {
  let body;
  if (type === "cloud") {
    const url = await uiPrompt(
      "输入云端 Git 仓库地址（将自动 clone 到本地缓存）：\n例如 https://github.com/user/repo.git",
      { title: "添加云端文件夹（Git 仓库）", placeholder: "https://github.com/user/repo.git" }
    );
    if (!url || !url.trim()) return;
    const name = await uiPrompt("项目显示名称（留空则取仓库名）：", {
      title: "添加云端文件夹（Git 仓库）",
      placeholder: "留空 = 取仓库名",
    });
    body = { type: "cloud", url: url.trim(), name: name?.trim() || undefined };
  } else {
    const path = await uiPrompt(
      "输入服务器上的文件夹绝对路径：\n⚠ 这会把该目录暴露给网页端浏览，仅建议本地/可信环境使用",
      { title: "添加本地文件夹（服务器路径）", placeholder: "例如 E:\\study 或 /home/user/project" }
    );
    if (!path || !path.trim()) return;
    body = { type: "local", path: path.trim() };
  }
  try {
    const res = await api("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    state.projects = res.projects;
    state.projectView = res.project.id;
    saveLocal();
    renderProjectSwitcher();
    renderSessions();
  } catch (err) {
    uiAlert(`${type === "cloud" ? "云端仓库" : "本地文件夹"}添加失败：${err.message}`, "添加项目");
  }
}

/* ---------------------------------------------------------------------------
 * 侧栏会话列表（按项目分组）
 * ------------------------------------------------------------------------- */
function renderSessions() {
  const list = $("session-list");
  list.innerHTML = "";

  // 按项目过滤 + 分组（保持 projects 定义顺序；无匹配项目的会话归入「其他」）
  const filtered = state.sessions.filter(
    (s) => state.projectView === "all" || s.projectId === state.projectView
  );
  const groups = [];
  const byId = new Map();
  for (const p of state.projects) {
    const g = { project: p, sessions: [] };
    groups.push(g);
    byId.set(p.id, g);
  }
  const other = { project: null, sessions: [] };
  for (const s of filtered) {
    (byId.get(s.projectId) || other).sessions.push(s);
  }
  if (other.sessions.length) groups.push(other);

  for (const g of groups) {
    if (!g.sessions.length) continue;
    const head = document.createElement("div");
    head.className = "proj-group-head" + (g.project?.type === "cloud" ? " cloud" : "");
    head.innerHTML = `<span class="g-icon">${g.project ? projectIcon(g.project) : "📁"}</span><span class="g-name"></span><span class="p-type-tag">${g.project ? (g.project.type === "cloud" ? "云端" : "本地") : "已移除"}</span>`;
    head.querySelector(".g-name").textContent = g.project?.name ?? "未归属";
    list.appendChild(head);
    for (const s of g.sessions) list.appendChild(renderSessionItem(s));
  }
  if (!list.children.length) {
    const empty = document.createElement("div");
    empty.className = "fs-empty";
    empty.textContent = state.projectView === "all" ? "还没有会话，点上方「＋ 新建对话」" : "该项目下还没有会话";
    list.appendChild(empty);
  }
}

function renderSessionItem(s) {
  const item = document.createElement("div");
  item.className = "session-item" + (s.id === state.currentId ? " active" : "") + (s.stale ? " stale" : "");
  item.title = s.stale ? "服务已重启，该会话仅可查看历史记录" : "";

  const title = document.createElement("div");
  title.className = "s-title";
  title.textContent = s.title;
  item.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "s-meta";
  const tag = document.createElement("span");
  tag.className = "s-demo";
  tag.textContent = sessionTagText(s);
  meta.appendChild(tag);
  const time = document.createElement("span");
  time.textContent = new Date(s.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  meta.appendChild(time);
  if (s.pendingApproval) {
    const pend = document.createElement("span");
    pend.textContent = "⏸ 待审批";
    pend.style.color = "var(--amber)";
    meta.appendChild(pend);
  }
  item.appendChild(meta);

  const del = document.createElement("button");
  del.className = "s-del";
  del.textContent = "✕";
  del.title = "删除会话";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!s.stale) { try { await api(`/api/sessions/${s.id}`, { method: "DELETE" }); } catch { /* 忽略 */ } }
    state.sessions = state.sessions.filter((x) => x.id !== s.id);
    delete state.blocks[s.id];
    saveLocal();
    if (state.currentId === s.id) {
      state.currentId = null;
      renderSessions();
      showWelcomeState();
    } else {
      renderSessions();
    }
  });
  item.appendChild(del);

  item.addEventListener("click", () => selectSession(s.id));
  return item;
}

/* ---------------------------------------------------------------------------
 * 会话选择 / 新建 / 欢迎页
 * ------------------------------------------------------------------------- */
function showWelcomeState() {
  closeComposerMenu();
  $("session-title").textContent = "未选择会话";
  $("demo-badge").classList.add("hidden");
  welcomeEl.classList.remove("hidden");
  messagesEl.innerHTML = "";
  $("context-bar").classList.add("hidden");
  inputEl.disabled = true;
  sendBtn.disabled = true;
  inputEl.placeholder = "先选择一个 Demo 新建会话…";
}

function showChatState(session) {
  welcomeEl.classList.add("hidden");
  $("session-title").textContent = session.title;
  const badge = $("demo-badge");
  const profile = profileMetaForSession(session);
  badge.textContent = session.kind === "demo"
    ? (DEMO_BADGE_TEXT[session.demo] || `示例 ${session.demo}`)
    : session.kind === "external"
      ? `🔌 外部 · ${state.externalAgents.find((a) => a.id === session.agentId)?.name ?? "Agent"}`
      : profile ? `${profile.icon} ${profile.label}` : "未知 Agent";
  badge.classList.remove("hidden");
  // 历史会话（服务重启后仅存于本地）只读：发送必然 404，直接禁用输入
  const stale = Boolean(session.stale);
  inputEl.disabled = stale;
  sendBtn.disabled = stale;
  inputEl.placeholder = stale
    ? "这是历史会话（服务已重启），仅供查看 —— 点击「＋ 新建对话」继续"
    : "给 Agent 发送消息…（Enter 发送 / Shift+Enter 换行）";
  renderPermChip(session);
}

/* ---------------------------------------------------------------------------
 * 会话权限模式：输入框上方 🛡 chip（只读 / 审批 / 自动），随会话切换联动
 * 只读 = 改世界工具一律拒绝；审批 = 高风险先确认（默认）；自动 = 全部直接执行。
 * ------------------------------------------------------------------------- */
const PERMISSION_MODES = [
  { id: "readonly", label: "只读", desc: "只允许只读工具：写文件 / 执行命令 / 发消息 / 控制电脑一律拒绝" },
  { id: "approve", label: "审批", desc: "高风险操作执行前弹审批卡片，人工批准才执行（默认）" },
  { id: "auto", label: "自动", desc: "全部工具直接执行，不再逐项审批（信任当前会话时使用）" },
];

/** 权限 chip 只对有 Agent 执行力的会话显示（demo / external / 历史失效会话隐藏） */
function renderPermChip(session) {
  const group = $("perm-group");
  const chip = $("cm-perm");
  if (!group || !chip) return;
  const current = session || state.sessions.find((x) => x.id === state.currentId);
  const available = current && !current.stale && (current.kind === "agent" || current.kind === "estate");
  group.classList.toggle("hidden", !available);
  if (!available) return;
  const mode = PERMISSION_MODES.find((m) => m.id === (current.permissionMode || "approve"));
  const text = document.querySelector("#cm-perm .cm-text");
  if (text) text.textContent = `权限·${mode?.label || "审批"}`;
  chip.title = `会话权限模式：${mode?.label || "审批"} —— ${mode?.desc || ""}`;
  // 弹出菜单开着时同步刷新勾选
  if (!$("cm-perm-menu")?.classList.contains("hidden")) renderPermMenu($("cm-perm-menu"));
}

function renderPermMenu(menu) {
  const current = state.sessions.find((x) => x.id === state.currentId);
  const active = current?.permissionMode || "approve";
  menu.innerHTML = "";
  const sec = document.createElement("div");
  sec.className = "cm-sec";
  const head = document.createElement("span");
  head.textContent = "会话权限模式";
  const sub = document.createElement("span");
  sub.className = "cm-sub";
  sub.textContent = "当前会话";
  sec.append(head, sub);
  menu.appendChild(sec);
  for (const mode of PERMISSION_MODES) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "cm-item" + (mode.id === active ? " active" : "");
    item.innerHTML = `<span class="ck">${mode.id === active ? "✓" : ""}</span><span class="cm-label"></span>`;
    item.querySelector(".cm-label").textContent = mode.label;
    item.title = mode.desc;
    item.addEventListener("click", async () => {
      if (mode.id === active || !state.currentId) { closeCmMenus(); return; }
      item.disabled = true;
      try {
        await api(`/api/sessions/${state.currentId}/permission`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: mode.id }),
        });
        const session = state.sessions.find((x) => x.id === state.currentId);
        if (session) session.permissionMode = mode.id;
        renderPermChip();
      } catch (err) {
        uiAlert(`切换失败：${err.message}`, "会话权限");
      }
      closeCmMenus();
    });
    menu.appendChild(item);
  }
  const desc = document.createElement("div");
  desc.className = "cm-desc";
  desc.textContent = PERMISSION_MODES.find((m) => m.id === active)?.desc || "";
  menu.appendChild(desc);
}

function selectSession(sid) {
  if (state.streaming) { uiAlert("当前正在生成回复，请先停止或等待完成", "请稍候"); return; }
  closeComposerMenu();
  state.currentId = sid;
  setSidebarOpen(false); // 窄屏抽屉：选中即收起
  const s = state.sessions.find((x) => x.id === sid);
  renderSessions();
  renderAll();
  if (s) showChatState(s);
  updateContextBar();
  chatScroll.scrollTop = chatScroll.scrollHeight;
  hydrateFromServer(s); // 本地没有该会话的记录 → 从服务端拉取回放（修复历史会话打开为空）
}

/** 历史回放中的 interrupt 只代表「当时暂停过」，服务端无 pending 时不再可操作 */
function markInterruptsResolved(sid) {
  for (const block of transcript(sid)) {
    if (block.t !== "assistant" || !Array.isArray(block.parts)) continue;
    for (const part of block.parts) {
      if (part.status !== "pending") continue;
      if (part.p === "approval") part.status = "resolved";
      if (part.p === "clarification") part.status = "answered";
    }
  }
}

/** 服务端仍有 pending 时，只有历史里最后一张 interrupt 卡可操作；更早的必须收起。 */
function markLatestInterruptPending(sid) {
  let latest = null;
  for (const block of transcript(sid)) {
    if (block.t !== "assistant" || !Array.isArray(block.parts)) continue;
    for (const part of block.parts) {
      if (part.p === "approval" || part.p === "clarification") latest = part;
    }
  }
  if (latest) latest.status = "pending";
}

/** 历史会话回放：localStorage 里没有这个会话的对话记录时（换浏览器 / 清过缓存），
 *  从服务端拉取每轮「用户消息 + 事件流」，用与实时流完全相同的 handleEvent 重放渲染。 */
async function hydrateFromServer(s) {
  if (!s || s.stale) return;                       // 服务重启后的残留会话：服务端也没有记录
  if (transcript(s.id).length) return;             // 本地已有 → 不拉
  try {
    const data = await api(`/api/sessions/${s.id}/transcript`);
    const arr = transcript(s.id);
    if (arr.length) return;                        // 竞态防护：等待期间本地已写入
    for (const rec of data.records || []) {
      const userBlock = { t: "user", text: rec.user, ...(rec.files?.length ? { files: rec.files } : {}) };
      const ablock = { t: "assistant", parts: [] };
      arr.push(userBlock, ablock);
      for (const ev of rec.events || []) handleEvent(ev, ablock);
      finalize(ablock);
    }
    // 回放中的 interrupt 是历史事件；先统一标成「已处理」，服务端仍有 pending
    // 时只把最后一张卡恢复为可操作，避免旧卡片在刷新后误点（尤其是多轮审批/澄清）。
    if (typeof data.pendingApproval === "boolean") {
      markInterruptsResolved(s.id);
      if (data.pendingApproval) markLatestInterruptPending(s.id);
    }
    saveLocal();
    if (state.currentId === s.id) {
      renderAll();
      updateContextBar();
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }
    // 回放中的 interrupt 事件会把会话标成「待审批」——以服务端的真实状态纠正
    // （审批早已处理过时，重放的那次 interrupt 只是历史记录）
    if (typeof data.pendingApproval === "boolean") {
      s.pendingApproval = data.pendingApproval;
      renderSessions();
    }
  } catch { /* 服务端也没有记录（会话从未对话过 / 服务重启过）→ 保持现状 */ }
}

async function createSession(kind, demo, prefill, agentId) {
  // 新会话归属当前选中的项目（「全部项目」视图下归到默认项目）
  const projectId = state.projectView !== "all" ? state.projectView : "default";
  const data = await api("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(demo
      ? { kind: "demo", demo, projectId }
      : { kind: kind || "agent", projectId, ...(kind === "external" ? { agentId, title: prefill || undefined } : {}) }),
  });
  state.sessions.unshift({ ...data, stale: false });
  state.currentId = data.id;
  renderSessions();
  showChatState(state.sessions[0]);
  renderAll();
  closeModal();
  if (prefill) {
    inputEl.value = prefill;
    autoGrow();
    inputEl.focus();
  }
}

/* ---------------------------------------------------------------------------
 * 外部 Agent（第三方 Git 仓库接入）
 * ------------------------------------------------------------------------- */
async function loadExternalAgents() {
  try {
    state.externalAgents = (await api("/api/external-agents")).agents || [];
  } catch {
    state.externalAgents = []; // 旧服务进程没有该接口 → 静默降级
  }
  renderExternalCards();
}

function renderExternalCards() {
  const wrap = $("external-cards");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!state.externalAgents.length) {
    const empty = document.createElement("div");
    empty.className = "ext-empty";
    empty.textContent = "还没有接入外部 Agent —— 粘贴一个 Git 仓库地址即可（仓库里放一份 agent.json 说明如何启动效果最佳）";
    wrap.appendChild(empty);
    return;
  }
  for (const a of state.externalAgents) {
    const card = document.createElement("button");
    card.className = "demo-card ext-card" + (a.command ? "" : " ext-incomplete");
    card.type = "button";
    card.innerHTML = `
      <div class="d-head"><span class="d-num">🔌</span><span class="d-name"></span>
        <button class="ext-del" title="移除该外部 Agent">✕</button></div>
      <div class="d-desc"></div>
      <div class="d-eg"></div>`;
    card.querySelector(".d-name").textContent = a.name;
    card.querySelector(".d-desc").textContent = a.description || a.url;
    card.querySelector(".d-eg").textContent = a.command
      ? `$ ${a.command} ${a.args.join(" ")}`
      : "⚠ 待补全启动命令";
    card.querySelector(".ext-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!(await uiConfirm(`移除外部 Agent「${a.name}」？\n其 clone 缓存会一并删除；已创建的会话将无法继续发送。`, { title: "移除外部 Agent", okText: "移除", danger: true }))) return;
      try {
        const res = await api(`/api/external-agents/${a.id}`, { method: "DELETE" });
        state.externalAgents = res.agents || [];
        renderExternalCards();
      } catch (err) { uiAlert(`移除失败：${err.message}`, "外部 Agent"); }
    });
    // 🔑 凭证注入开关：高风险（网关 Key 会进入第三方仓库的子进程环境），强制二次确认
    card.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = !a.passCredentials;
      const ok = await uiConfirm(
        next
          ? `开启凭证注入？\n当前网关 API Key / 地址将进入「${a.name}」子进程的环境变量。\n只对可信、开源且看过代码的仓库开启！`
          : `关闭「${a.name}」的凭证注入？其后子进程将拿不到网关 Key。`,
        { title: "凭证注入", okText: next ? "开启" : "关闭", danger: next }
      );
      if (!ok) return;
      try {
        const res = await api(`/api/external-agents/${a.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passCredentials: next, confirmCredentials: true }),
        });
        const idx = state.externalAgents.findIndex((x) => x.id === a.id);
        if (idx >= 0) state.externalAgents[idx] = res.agent;
        renderExternalCards();
      } catch (err) { uiAlert(`设置失败：${err.message}`, "凭证注入"); }
    });
    card.addEventListener("click", async () => {
      try {
        if (!a.command) {
          await completeExternalAgent(a); // 待补全：先要一条启动命令
          return;
        }
        await createSession("external", null, null, a.id);
      } catch (err) { uiAlert("创建外部 Agent 会话失败：" + err.message, "外部 Agent"); }
    });
    wrap.appendChild(card);
  }
}

/** 接入流程：Git 地址 → clone + 自动发现 → 必要时补启动命令 */
async function addExternalFlow() {
  const url = await uiPrompt(
    "输入第三方 Agent 的 Git 仓库地址：\n服务端会 clone 到本地并自动识别启动方式（agent.json > package.json > 常见入口）",
    { title: "接入外部 Agent", placeholder: "https://github.com/user/agent-repo" }
  );
  if (!url || !url.trim()) return;
  const addBtn = $("add-external-btn");
  const prevText = addBtn?.textContent;
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = "⏳ 克隆中…（最长 2 分钟）"; }
  try {
    const res = await api("/api/external-agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.trim() }),
    });
    state.externalAgents = res.agents || [];
    renderExternalCards();
    if (res.agent.command) {
      await uiAlert(
        `已接入「${res.agent.name}」\n启动命令：${res.agent.command} ${res.agent.args.join(" ")}${res.hint ? `\n\n${res.hint}` : ""}`,
        "接入成功"
      );
    } else {
      await uiAlert(`仓库已 clone，但没有识别出启动方式。\n${res.hint || ""}`, "需要补全启动命令");
      await completeExternalAgent(res.agent);
    }
  } catch (err) {
    uiAlert(`接入失败：${err.message}`, "外部 Agent");
  } finally {
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = prevText ?? "＋ 接入外部 Agent（Git 地址）"; }
  }
}

/** 为「待补全」的外部 Agent 询问并保存启动命令（如 node cli.js） */
async function completeExternalAgent(agent) {
  const cmdLine = await uiPrompt(
    `为「${agent.name}」输入启动命令（在仓库目录内执行）：\n用户消息会替换 args 里的 {{prompt}} 占位符；没有占位符时通过 stdin 传入`,
    { title: "补全启动命令", placeholder: "例如 node cli.js --prompt {{prompt}}" }
  );
  if (!cmdLine || !cmdLine.trim()) return;
  const parts = cmdLine.trim().split(/\s+/);
  try {
    const res = await api(`/api/external-agents/${agent.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: parts[0], args: parts.slice(1) }),
    });
    const idx = state.externalAgents.findIndex((x) => x.id === agent.id);
    if (idx >= 0) state.externalAgents[idx] = res.agent;
    renderExternalCards();
    await createSession("external", null, null, agent.id);
  } catch (err) {
    uiAlert(`保存失败：${err.message}`, "外部 Agent");
  }
}

/* ---------------------------------------------------------------------------
 * 消息渲染（全量）
 * ------------------------------------------------------------------------- */
function renderAll() {
  messagesEl.innerHTML = "";
  partEls.clear();
  blockBodies.clear();
  const sid = state.currentId;
  if (!sid) return;
  for (const block of transcript(sid)) mountBlock(block);
  scrollBottom(true);
}

/** 把一个 block 挂到消息流末尾 */
function mountBlock(block) {
  if (block.t === "user") {
    const wrap = document.createElement("div");
    wrap.className = "msg-user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    // 附件 chips（文件上下文来源：项目 / 远程 / 本地上传）
    if (block.files?.length) {
      const chips = document.createElement("div");
      chips.className = "f-chips";
      for (const f of block.files) {
        const c = document.createElement("span");
        c.className = "f-chip";
        c.innerHTML = `${f.image ? "🖼" : "📎"} <span class="fname"></span><span class="fsrc"></span>`;
        c.querySelector(".fname").textContent = f.name;
        c.querySelector(".fsrc").textContent = f.source;
        chips.appendChild(c);
      }
      bubble.appendChild(chips);
    }
    const textDiv = document.createElement("div");
    textDiv.textContent = block.text;
    bubble.appendChild(textDiv);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    block._el = wrap;
    return;
  }
  if (block.t === "notice") {
    const el = document.createElement("div");
    el.className = "notice-block" + (block.loading ? " loading" : "");
    messagesEl.appendChild(el);
    block._el = el;
    renderNoticeBlock(block);
    return;
  }
  if (block.t === "error") {
    const el = document.createElement("div");
    el.className = "error-block";
    el.textContent = "⚠️ " + block.text;
    messagesEl.appendChild(el);
    block._el = el;
    return;
  }
  // assistant
  const wrap = document.createElement("div");
  wrap.className = "msg-assistant";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "⚡";
  const body = document.createElement("div");
  body.className = "assistant-body";
  wrap.appendChild(avatar);
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  block._el = wrap;
  blockBodies.set(block, body);

  for (const part of block.parts) mountPart(block, part);
  if (!block.parts.length) mountTyping(block);
  if (block._usage) updateTurnCaption(block);
}

function renderNoticeBlock(block) {
  const el = block._el;
  if (!el) return;
  el.classList.toggle("loading", Boolean(block.loading));
  el.innerHTML = `<div class="notice-title"></div><div class="notice-text"></div>`;
  el.querySelector(".notice-title").textContent = block.title || "提示";
  el.querySelector(".notice-text").textContent = block.text || "";
  if (block.summary) {
    const details = document.createElement("details");
    details.className = "notice-details";
    const summary = document.createElement("summary");
    summary.textContent = "查看压缩摘要";
    const pre = document.createElement("pre");
    pre.textContent = block.summary;
    details.append(summary, pre);
    el.appendChild(details);
  }
}

function mountTyping(block) {
  const body = blockBodies.get(block);
  if (!body || block._typing) return;
  const t = document.createElement("div");
  t.className = "typing";
  t.innerHTML = "<i></i><i></i><i></i>";
  body.appendChild(t);
  block._typing = t;
}
function unmountTyping(block) {
  if (block._typing) { block._typing.remove(); block._typing = null; }
}

/** 把一个 part 挂到 assistant 正文里，并记录 DOM 引用 */
function mountPart(block, part) {
  const body = blockBodies.get(block);
  if (!body) return;
  unmountTyping(block);

  if (part.p === "text") {
    const el = document.createElement("div");
    el.className = "md";
    body.appendChild(el);
    partEls.set(part, { el });
    renderTextPart(part);
    return;
  }

  if (part.p === "node") {
    const chip = document.createElement("span");
    chip.className = "node-chip";
    chip.textContent = `${nodeIcon(part.name)} ${nodeLabel(part.name)}`;
    const row = document.createElement("div");
    row.appendChild(chip);
    body.appendChild(row);
    partEls.set(part, { el: row });
    return;
  }

  if (part.p === "tool") {
    const card = document.createElement("div");
    card.className = "tool-card running";
    card.innerHTML = `
      <div class="tool-head">
        <span class="tool-icon"></span>
        <span class="tool-name"></span>
        <span class="tool-args-preview"></span>
        <span class="tool-status"><span class="spinner"></span>运行中</span>
        <span class="chevron">▶</span>
      </div>
      <div class="tool-body">
        <div class="tool-section"><div class="tool-label">参数 (流式)</div><pre class="args-pre"></pre></div>
        <div class="tool-section"><div class="tool-label">结果</div><pre class="result-pre">…</pre></div>
      </div>`;
    card.querySelector(".tool-icon").textContent = TOOL_ICONS[part.name] || "🔧";
    card.querySelector(".tool-name").textContent = part.name || "tool";
    card.querySelector(".tool-head").addEventListener("click", () => card.classList.toggle("open"));
    mountToolCard(block, card);
    partEls.set(part, { el: card });
    updateToolCard(part);
    return;
  }

  if (part.p === "approval") {
    const el = document.createElement("div");
    el.className = "approval-card";
    renderApprovalCard(part, el);
    body.appendChild(el);
    partEls.set(part, { el });
    return;
  }

  if (part.p === "clarification") {
    const el = document.createElement("div");
    el.className = "approval-card clarification-card";
    renderClarificationCard(part, el);
    body.appendChild(el);
    partEls.set(part, { el });
    return;
  }
}

/* ---------------------------------------------------------------------------
 * 工具调用抽屉：一个助手块里连续调用 ≥ TOOL_DRAWER_MIN 个工具时，
 * 全部收进可展开/收起的下拉容器（流式与历史回放走同一条挂载路径）。
 * 单个工具保持原样平铺；审批/澄清卡片永远不进抽屉（需要用户看见）。
 * ------------------------------------------------------------------------- */
const TOOL_DRAWER_MIN = 2;

/** 挂载工具卡：不足阈值直接平铺；达标后把裸卡迁入抽屉 */
function mountToolCard(block, card) {
  const body = blockBodies.get(block);
  if (!body) return;
  const toolCount = block.parts.filter((p) => p.p === "tool").length;
  if (toolCount < TOOL_DRAWER_MIN) {
    body.appendChild(card);
    return;
  }
  const drawer = ensureToolDrawer(block, body);
  // 第二个工具出现时才建抽屉：先建容器插到首卡位置，再把 body 里已有的裸卡迁入
  for (const bare of [...body.querySelectorAll(":scope > .tool-card")]) {
    drawer.items.appendChild(bare);
  }
  drawer.items.appendChild(card);
  refreshToolDrawer(block);
}

/** 创建（或复用）当前块的抽屉容器；插入位置 = 第一张工具卡处 */
function ensureToolDrawer(block, body) {
  if (block._drawerEl?.isConnected) return block._drawer;
  const wrap = document.createElement("div");
  wrap.className = "tool-drawer";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "drawer-head";
  // innerHTML 搭骨架 + textContent 填文案（§5.5 防 XSS 约定）
  head.innerHTML = `<span class="drawer-caret">▸</span><span class="drawer-icon">🔧</span><span class="drawer-label"></span><span class="drawer-sub"></span>`;
  const items = document.createElement("div");
  items.className = "drawer-items hidden";
  head.addEventListener("click", () => {
    block._drawerOpen = !block._drawerOpen;
    syncToolDrawer(block);
  });
  wrap.append(head, items);
  const firstCard = body.querySelector(":scope > .tool-card");
  if (firstCard) body.insertBefore(wrap, firstCard);
  else body.appendChild(wrap);
  block._drawerEl = wrap;
  block._drawer = { wrap, head, items };
  return block._drawer;
}

/** 刷新抽屉汇总文案与展开态（新卡挂载 / 结果回填 / 流结束时调用） */
function refreshToolDrawer(block) {
  const drawer = block._drawer;
  if (!drawer || !block._drawerEl?.isConnected) return;
  const tools = block.parts.filter((p) => p.p === "tool");
  const running = tools.filter((t) => !t.result).length;
  const errors = tools.filter((t) => t.result?.isError).length;
  drawer.head.querySelector(".drawer-label").textContent = `${tools.length} 个工具调用`;
  drawer.head.querySelector(".drawer-sub").textContent = running
    ? `${running} 个运行中…`
    : errors ? `${errors} 个失败` : "全部完成";
  syncToolDrawer(block);
}

function syncToolDrawer(block) {
  const drawer = block._drawer;
  if (!drawer) return;
  drawer.items.classList.toggle("hidden", !block._drawerOpen);
  drawer.wrap.classList.toggle("open", Boolean(block._drawerOpen));
}

function renderClarificationCard(part, el) {
  const req = part.req;
  el.innerHTML = `
    <div class="approval-title">🧭 需求澄清（请选择一个方向）</div>
    <div class="approval-desc"></div>
    <div class="clarify-options"></div>
    <div class="clarify-custom hidden"></div>
    <div class="approval-actions"></div>`;
  el.querySelector(".approval-desc").textContent = req.question || "请补充关键信息后继续";
  const options = el.querySelector(".clarify-options");
  const actions = el.querySelector(".approval-actions");

  if (part.status === "pending") {
    for (const opt of Array.isArray(req.options) ? req.options : []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "clarify-option";
      const label = document.createElement("span");
      label.className = "clarify-option-label";
      label.textContent = `${opt.id}. ${opt.label}`;
      button.appendChild(label);
      if (opt.description) {
        const desc = document.createElement("span");
        desc.className = "clarify-option-desc";
        desc.textContent = opt.description;
        button.appendChild(desc);
      }
      button.addEventListener("click", () =>
        decideClarification(part, opt.id, `${opt.label}${opt.description ? `（${opt.description}）` : ""}`)
      );
      options.appendChild(button);
    }

    if (req.allowCustom !== false) {
      const custom = el.querySelector(".clarify-custom");
      custom.classList.remove("hidden");
      const input = document.createElement("input");
      input.className = "clarify-input";
      input.type = "text";
      input.maxLength = 2000;
      input.placeholder = "也可以直接输入补充说明…";
      const submit = document.createElement("button");
      submit.type = "button";
      submit.className = "btn btn-approve";
      submit.textContent = "提交";
      const send = () => {
        const value = input.value.trim();
        if (value) decideClarification(part, value, value);
      };
      submit.addEventListener("click", send);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          send();
        }
      });
      custom.append(input, submit);
    }
  } else {
    el.classList.add("done-approve");
    const verdict = document.createElement("div");
    verdict.className = "approval-verdict";
    verdict.textContent = part.answer ? `已选择：${part.answer}` : "此前已处理";
    actions.appendChild(verdict);
  }
}

function renderTextPart(part) {
  const refs = partEls.get(part);
  if (!refs) return;
  refs.el.innerHTML = renderMarkdown(part.text) + (part.streaming ? '<span class="cursor"></span>' : "");
}


function updateToolCard(part) {
  const refs = partEls.get(part);
  if (!refs) return;
  const card = refs.el;
  const firstLine = (part.result?.content || part.argsText || "").split("\n")[0] || "";
  card.querySelector(".tool-args-preview").textContent = firstLine.slice(0, 120);
  const argsPre = card.querySelector(".args-pre");
  argsPre.textContent = fmtArgs(part);

  const status = card.querySelector(".tool-status");
  if (part.result) {
    card.classList.remove("running");
    card.classList.add(part.result.isError ? "err" : "ok");
    status.className = "tool-status " + (part.result.isError ? "err" : "ok");
    const unsupported = part.result.isError && /当前 Agent 不支持工具/.test(String(part.result.content));
    status.textContent = unsupported ? "✕ 不支持" : part.result.isError ? "✕ 失败" : "✓ 完成";
    card.querySelector(".result-pre").textContent = part.result.content;
    card.querySelector(".result-pre").className = "result-pre" + (part.result.isError ? " err" : "");
    // 知识检索专属：解析 JSON 结果，渲染「命中来源」卡片
    if (part.name === "retrieve_docs") renderRagHitsInToolCard(part, card);
    // 房产专属：解析 JSON 结果，渲染房源列表 / 内嵌地图 / 户型图 / 安装引导
    if (part.name && part.name.startsWith("house_")) renderEstateInToolCard(part, card);
  }
}

function renderApprovalCard(part, el) {
  const req = part.req;
  el.innerHTML = `
    <div class="approval-title">🛂 需要人工审批（Human-in-the-loop）</div>
    <div class="approval-desc"></div>
    <div class="approval-args"></div>
    <div class="approval-actions"></div>`;
  el.querySelector(".approval-desc").textContent = `Agent 请求执行高风险工具「${req.toolName}」：${req.description}`;
  el.querySelector(".approval-args").textContent = JSON.stringify(req.args, null, 2);
  const actions = el.querySelector(".approval-actions");

  if (part.status === "pending") {
    const ok = document.createElement("button");
    ok.className = "btn btn-approve";
    ok.textContent = "✓ 批准并执行";
    ok.addEventListener("click", () => decideApproval(part, "approved"));
    const no = document.createElement("button");
    no.className = "btn btn-reject";
    no.textContent = "✕ 拒绝";
    no.addEventListener("click", () => decideApproval(part, "rejected"));
    actions.append(ok, no);
  } else {
    const resolved = part.status === "resolved";
    el.classList.add(part.status === "approved" || resolved ? "done-approve" : "done-reject");
    const v = document.createElement("div");
    v.className = "approval-verdict";
    v.textContent = resolved
      ? "此前已处理"
      : part.status === "approved" ? "✅ 你批准了本次操作" : "🚫 你拒绝了本次操作";
    actions.appendChild(v);
  }
}

/* ---------------------------------------------------------------------------
 * 流式事件挂载（增量）
 * ------------------------------------------------------------------------- */
function appendToken(ablock, text) {
  const parts = ablock.parts;
  let last = parts[parts.length - 1];
  if (!last || last.p !== "text" || !last.streaming) {
    last = { p: "text", text: "", streaming: true };
    parts.push(last);
    mountPart(ablock, last);
  }
  last.text += text;
  scheduleTextRender(last);
  scrollBottom();
}

function scheduleTextRender(part) {
  if (textTimers.has(part)) return;
  textTimers.set(part, setTimeout(() => {
    textTimers.delete(part);
    renderTextPart(part);
  }, 55));
}

function upsertToolCall(ablock, ev) {
  let part = [...ablock.parts].reverse().find((p) => p.p === "tool" && p.id === ev.id);
  if (!part) {
    part = { p: "tool", id: ev.id, name: ev.name || "", argsText: "", result: null };
    ablock.parts.push(part);
    mountPart(ablock, part);
  } else if (ev.name && !part.name) {
    part.name = ev.name;
    const refs = partEls.get(part);
    if (refs) {
      refs.el.querySelector(".tool-name").textContent = ev.name;
      refs.el.querySelector(".tool-icon").textContent = TOOL_ICONS[ev.name] || "🔧";
    }
  }
  part.argsText += ev.argsFragment || "";
  updateToolCard(part);
  scrollBottom();
}

function fillToolResult(ablock, ev) {
  const part = ablock.parts.find((p) => p.p === "tool" && p.id === ev.id) ||
    [...state.blocks[state.currentId] || []]
      .flatMap((b) => (b.t === "assistant" ? b.parts : []))
      .reverse().find((p) => p.p === "tool" && p.id === ev.id);
  if (!part) return;
  part.result = { content: ev.content, isError: Boolean(ev.isError) };
  updateToolCard(part);
  refreshToolDrawer(ablock);
  scrollBottom();
}

function addNodeChip(ablock, name) {
  const last = ablock.parts[ablock.parts.length - 1];
  if (last && last.p === "node" && last.name === name) return; // 相邻去重
  const part = { p: "node", name };
  ablock.parts.push(part);
  mountPart(ablock, part);
  scrollBottom();
}

function addInterrupt(ablock, payload) {
  if (payload?.type === "clarification") {
    const part = { p: "clarification", req: payload, status: "pending" };
    ablock.parts.push(part);
    mountPart(ablock, part);
  } else {
    const part = { p: "approval", req: payload, status: "pending" };
    ablock.parts.push(part);
    mountPart(ablock, part);
  }
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (s) s.pendingApproval = true;
  renderSessions();
  scrollBottom(true);
}

async function decideApproval(part, status) {
  if (state.streaming) return;
  part.status = status;
  const refs = partEls.get(part);
  if (refs) renderApprovalCard(part, refs.el);
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (s) s.pendingApproval = false;
  renderSessions();
  saveLocal();
  await runResume({ decision: status === "approved" ? "approve" : "reject" });
}

async function decideClarification(part, choice, label) {
  if (state.streaming) return;
  const value = String(choice || "").trim();
  if (!value) return;
  part.status = "answered";
  part.answer = label || value;
  const refs = partEls.get(part);
  if (refs) {
    refs.el.className = "approval-card clarification-card done-approve";
    renderClarificationCard(part, refs.el);
  }
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (s) s.pendingApproval = false;
  renderSessions();
  saveLocal();
  await runResume({ choice: value });
}

function addErrorBlock(ablock, message) {
  const block = { t: "error", text: message };
  transcript(state.currentId).push(block);
  mountBlock(block);
  scrollBottom(true);
}

/** finalize：结束流式态，清空光标 / 清理空块 */
function finalize(ablock) {
  if (ablock) {
    if (!ablock.parts.length) {
      // 整轮无输出（请求失败 / 立即中止）→ 移除空助手块
      if (ablock._el) ablock._el.remove();
      const arr = transcript(state.currentId);
      const i = arr.indexOf(ablock);
      if (i >= 0) arr.splice(i, 1);
    } else {
      for (const p of ablock.parts) {
        if (p.p === "text" && p.streaming) {
          p.streaming = false;
          renderTextPart(p);
        }
      }
      // 流结束：抽屉汇总定格为最终状态（无「运行中」残留）
      refreshToolDrawer(ablock);
    }
  }
  state.streaming = null;
  stopBtn.classList.add("hidden");
  sendBtn.classList.remove("hidden");
  sendBtn.disabled = !state.currentId;
  setStatus("idle");
  saveLocal();
}

function setStatus(mode) {
  const el = $("status-dot");
  el.className = "status " + mode;
}

/* ---------------------------------------------------------------------------
 * SSE 消费
 * ------------------------------------------------------------------------- */
async function consumeSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* 忽略坏帧 */ }
        }
      }
    }
  }
}

function handleEvent(ev, ablock) {
  switch (ev.type) {
    case "token": appendToken(ablock, ev.text); break;
    case "tool_call": upsertToolCall(ablock, ev); break;
    case "tool_result": fillToolResult(ablock, ev); break;
    case "node": addNodeChip(ablock, ev.name); break;
    case "ai_message": {
      const last = ablock.parts[ablock.parts.length - 1];
      if (!last || last.p !== "text" || last.text !== ev.content) {
        const part = { p: "text", text: ev.content, streaming: true };
        ablock.parts.push(part);
        mountPart(ablock, part);
      }
      break;
    }
    case "interrupt": addInterrupt(ablock, ev.payload); break;
    case "usage": {
      // 上下文容量 ≈ 最近一次模型调用的 输入 + 输出；缓存占比 = cache_read / 输入
      const u = state.usage[state.currentId] || (state.usage[state.currentId] = {});
      u.lastInput = ev.inputTokens;
      u.lastOutput = ev.outputTokens;
      u.lastCache = ev.cacheReadTokens || 0;
      u.contextTokens = ev.inputTokens + ev.outputTokens;
      ablock._usage = { lastInput: ev.inputTokens, lastOutput: ev.outputTokens, lastCache: u.lastCache };
      updateTurnCaption(ablock);
      updateContextBar();
      saveLocal();
      break;
    }
    case "shutdown": {
      // 服务端优雅退出的最后一帧：常驻顶部提示；刷新时若服务已恢复则自然消失
      let banner = document.getElementById("shutdown-banner");
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "shutdown-banner";
        banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;padding:8px 16px;" +
          "background:#8a5a00;color:#fff;text-align:center;font-size:13px";
        document.body.appendChild(banner);
      }
      banner.textContent = ev.message || "服务正在关闭，请稍后刷新页面重连";
      break;
    }
    case "error": addErrorBlock(ablock, ev.message); break;
    case "done": break;
  }
}

/* ---------------------------------------------------------------------------
 * 发送 / 审批恢复 / 停止
 * ------------------------------------------------------------------------- */
async function send() {
  const text = inputEl.value.trim();
  if (!text || !state.currentId || state.streaming || state.compacting) return;
  const cur = state.sessions.find((x) => x.id === state.currentId);
  if (cur?.stale) return; // 历史会话不可发送
  closeComposerMenu();
  // 附件引用：项目/远程文件传路径（服务端读取校验），上传传 uploadId
  const fileRefs = state.pendingFiles.map((f) => f.kind === "upload"
    ? { kind: "upload", uploadId: f.uploadId, name: f.name }
    : { kind: "fs", path: f.path, name: f.name });
  const filesMeta = state.pendingFiles.map((f) => ({
    name: f.name,
    source: f.preview ? "图片" : f.source,
    image: Boolean(f.preview),
  }));
  inputEl.value = "";
  autoGrow();

  const arr = transcript(state.currentId);
  const userBlock = { t: "user", text, ...(filesMeta.length ? { files: filesMeta } : {}) };
  const ablock = { t: "assistant", parts: [] };
  arr.push(userBlock, ablock);
  mountBlock(userBlock);
  mountBlock(ablock);
  saveLocal();
  state.pendingFiles = [];
  renderAttachChips();

  // 首条消息自动作为会话标题
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (s && !s._renamed) {
    s.title = text.slice(0, 24) + (text.length > 24 ? "…" : "");
    s._renamed = true;
    $("session-title").textContent = s.title;
    renderSessions();
  }
  await streamTurn(`/api/chat`, {
    sessionId: state.currentId,
    message: text,
    ...(fileRefs.length ? { files: fileRefs } : {}),
  }, ablock);
}

async function runResume(payload) {
  if (!state.currentId || state.streaming) return;
  const ablock = { t: "assistant", parts: [] };
  transcript(state.currentId).push(ablock);
  mountBlock(ablock);
  await streamTurn(`/api/resume`, { sessionId: state.currentId, ...payload }, ablock);
}

async function streamTurn(url, body, ablock) {
  const ctrl = new AbortController();
  state.streaming = { ctrl, sid: state.currentId, ablock };
  stopBtn.classList.remove("hidden");
  sendBtn.classList.add("hidden");
  setStatus("busy");
  const wasNear = nearBottom();

  try {
    const res = await authFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await consumeSSE(res, (ev) => handleEvent(ev, ablock));
  } catch (err) {
    if (err.name !== "AbortError") addErrorBlock(ablock, `请求失败：${err.message}`);
  } finally {
    finalize(ablock);
    if (wasNear) scrollBottom(true);
  }
}

function stopStreaming() {
  if (state.streaming) state.streaming.ctrl.abort();
}

/* ---------------------------------------------------------------------------
 * 滚动
 * ------------------------------------------------------------------------- */
function nearBottom() {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 110;
}
function scrollBottom(force) {
  if (force || nearBottom()) chatScroll.scrollTop = chatScroll.scrollHeight;
}

/* ---------------------------------------------------------------------------
 * 输入框
 * ------------------------------------------------------------------------- */
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  // 发送按钮随内容点亮：空输入保持灰态，有内容才变成主色渐变
  sendBtn.classList.toggle("is-ready", inputEl.value.trim().length > 0);
}

/* ---------------------------------------------------------------------------
 * 输入辅助：/ 命令（压缩上下文）与 @ 文件搜索
 * 规则：/ 或 @ 必须是当前 token 的开头（行首或空白后），避免正文里的邮箱被误触发。
 * @ 选中后不插入 @路径 文本，而是加入既有附件 chips —— 文件内容仍由服务端授权读取。
 * ------------------------------------------------------------------------- */
function closeComposerMenu() {
  composerMenu.kind = null;
  composerMenu.items = [];
  composerMenu.active = 0;
  composerMenu.trigger = null;
  composerMenu.loading = false;
  composerMenu.error = "";
  composerMenu.searchSeq += 1;
  clearTimeout(composerMenu.searchTimer);
  composerMenu.ctrl?.abort();
  composerMenu.ctrl = null;
  const menu = $("composer-menu");
  if (menu) {
    menu.classList.add("hidden");
    menu.innerHTML = "";
  }
}

function currentComposerTrigger() {
  if (!state.currentId || state.streaming || state.compacting || inputEl.disabled) return null;
  const cur = state.sessions.find((s) => s.id === state.currentId);
  if (cur?.stale) return null;
  const end = inputEl.selectionStart ?? 0;
  if (end !== inputEl.selectionEnd) return null;
  const match = inputEl.value.slice(0, end).match(/(^|\s)([/@])([^\s]*)$/);
  if (!match) return null;
  return {
    char: match[2],
    query: match[3],
    start: end - match[2].length - match[3].length,
    end,
  };
}

function slashCommandItems(query) {
  const q = query.trim().toLowerCase();
  return SLASH_COMMANDS
    .filter((cmd) => !q || cmd.label.toLowerCase().includes(q) || cmd.keywords.toLowerCase().includes(q) || cmd.id.includes(q))
    .map((cmd) => ({ type: "command", ...cmd }));
}

function refreshComposerMenu() {
  const trigger = currentComposerTrigger();
  if (!trigger) {
    closeComposerMenu();
    return;
  }

  composerMenu.trigger = trigger;
  composerMenu.active = 0;

  if (trigger.char === "/") {
    clearTimeout(composerMenu.searchTimer);
    composerMenu.ctrl?.abort();
    composerMenu.ctrl = null;
    composerMenu.kind = "slash";
    composerMenu.loading = false;
    composerMenu.error = "";
    composerMenu.items = slashCommandItems(trigger.query);
    renderComposerMenu();
    return;
  }

  // @：先显示加载态，再防抖请求服务端搜索（最多 20 条）
  composerMenu.kind = "file";
  composerMenu.items = [];
  composerMenu.loading = true;
  composerMenu.error = "";
  renderComposerMenu();
  clearTimeout(composerMenu.searchTimer);
  const query = trigger.query;
  composerMenu.searchTimer = setTimeout(() => {
    if (composerMenu.kind === "file" && composerMenu.trigger?.query === query) {
      void searchComposerFiles(query);
    }
  }, 140);
}

function renderComposerMenu() {
  const menu = $("composer-menu");
  if (!menu) return;
  if (!composerMenu.kind) {
    closeComposerMenu();
    return;
  }

  menu.classList.remove("hidden");
  menu.innerHTML = `<div class="composer-menu-head"><span></span><span></span></div>`;
  const head = menu.querySelector(".composer-menu-head");
  head.firstElementChild.textContent = composerMenu.kind === "slash"
    ? "命令"
    : `文件（最多 ${FILE_MENTION_LIMIT} 个）`;
  if (!composerMenu.loading && !composerMenu.error) {
    head.lastElementChild.textContent = composerMenu.items.length ? `${composerMenu.items.length} 个结果` : "";
  }

  if (composerMenu.loading) {
    const empty = document.createElement("div");
    empty.className = "composer-menu-empty";
    empty.textContent = "搜索文件中…";
    menu.appendChild(empty);
    return;
  }
  if (composerMenu.error) {
    const empty = document.createElement("div");
    empty.className = "composer-menu-empty";
    empty.textContent = `搜索失败：${composerMenu.error}`;
    menu.appendChild(empty);
    return;
  }
  if (!composerMenu.items.length) {
    const empty = document.createElement("div");
    empty.className = "composer-menu-empty";
    empty.textContent = composerMenu.kind === "slash" ? "没有匹配的命令" : "没有找到文件";
    menu.appendChild(empty);
    return;
  }

  composerMenu.items.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-item" + (index === composerMenu.active ? " active" : "");
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === composerMenu.active ? "true" : "false");
    button.innerHTML = `<span class="ci-icon"></span><span class="ci-main"><span class="ci-title"></span><span class="ci-desc"></span></span><span class="ci-meta"></span>`;
    button.querySelector(".ci-icon").textContent = item.type === "command" ? item.icon : "📄";
    button.querySelector(".ci-title").textContent = item.type === "command" ? item.label : item.file.name;
    button.querySelector(".ci-desc").textContent = item.type === "command"
      ? item.desc
      : `${item.file.rootName} / ${item.file.rel}`;
    button.querySelector(".ci-meta").textContent = item.type === "command" ? "Enter" : fmtSize(item.file.size);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectComposerItem(index);
    });
    menu.appendChild(button);
  });
  menu.querySelector(".composer-item.active")?.scrollIntoView({ block: "nearest" });
}

async function searchComposerFiles(query) {
  const seq = ++composerMenu.searchSeq;
  composerMenu.ctrl?.abort();
  const ctrl = new AbortController();
  composerMenu.ctrl = ctrl;
  try {
    const data = await api("/api/fs/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: ctrl.signal,
    });
    if (seq !== composerMenu.searchSeq || composerMenu.kind !== "file") return;
    composerMenu.items = (data.files || []).slice(0, FILE_MENTION_LIMIT).map((file) => ({ type: "file", file }));
    composerMenu.active = 0;
    composerMenu.loading = false;
    renderComposerMenu();
  } catch (err) {
    if (seq !== composerMenu.searchSeq || err.name === "AbortError") return;
    composerMenu.items = [];
    composerMenu.loading = false;
    composerMenu.error = err.message;
    renderComposerMenu();
  }
}

function selectComposerItem(index) {
  const item = composerMenu.items[index];
  const trigger = composerMenu.trigger;
  if (!item || !trigger) return;
  const value = inputEl.value;
  const next = value.slice(0, trigger.start) + value.slice(trigger.end);

  if (item.type === "command") {
    inputEl.value = next.replace(/\s+$/, "");
    closeComposerMenu();
    autoGrow();
    inputEl.focus();
    if (item.id === "compact") void compactContext();
    return;
  }

  if (!addPendingFile({
    kind: "fs",
    path: item.file.path,
    name: item.file.name,
    source: item.file.rootName || "项目文件",
  })) return;
  inputEl.value = next;
  closeComposerMenu();
  autoGrow();
  inputEl.focus();
}

function moveComposerActive(delta) {
  if (!composerMenu.kind || !composerMenu.items.length) return;
  const length = composerMenu.items.length;
  composerMenu.active = (composerMenu.active + delta + length) % length;
  renderComposerMenu();
}

/** 返回 true 表示事件已被输入菜单消费，调用方不要再走发送逻辑 */
function handleComposerKeydown(event) {
  if (!composerMenu.kind) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    closeComposerMenu();
    return true;
  }
  if (!composerMenu.items.length) return false;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveComposerActive(1);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveComposerActive(-1);
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    selectComposerItem(composerMenu.active);
    return true;
  }
  return false;
}

async function compactContext() {
  if (!state.currentId || state.streaming || state.compacting) return;
  const sid = state.currentId;
  const cur = state.sessions.find((s) => s.id === sid);
  if (cur?.stale) { uiAlert("历史会话不可压缩，请新建会话", "提示"); return; }

  const block = {
    t: "notice",
    title: "正在压缩上下文",
    text: "正在把当前会话整理成摘要，请稍候…",
    loading: true,
  };
  state.compacting = true;
  transcript(sid).push(block);
  mountBlock(block);
  scrollBottom(true);
  sendBtn.disabled = true;
  setStatus("busy");

  try {
    const res = await api(`/api/sessions/${sid}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    block.loading = false;
    block.title = "上下文已压缩";
    block.text = `原对话约 ${Number(res.beforeChars || 0).toLocaleString("zh-CN")} 字符 → 摘要 ${Number(res.afterChars || 0).toLocaleString("zh-CN")} 字符。后续对话会自动使用这份摘要。`;
    block.summary = res.summary || "";
    renderNoticeBlock(block);
    delete state.usage[sid];
    updateContextBar();
  } catch (err) {
    block.loading = false;
    block.title = "压缩失败";
    block.text = err.message;
    renderNoticeBlock(block);
  } finally {
    state.compacting = false;
    sendBtn.disabled = !state.currentId;
    setStatus(state.streaming ? "busy" : "idle");
    saveLocal();
  }
}

/* ---------------------------------------------------------------------------
 * 卡片与示例（新建对话弹窗 + 欢迎页共用）
 * ------------------------------------------------------------------------- */
function buildDemoCards(container) {
  container.innerHTML = "";

  // 通用 Agent（默认）：正常产品逻辑 —— 工具 + 文件上下文 + 多轮记忆 + 审批
  const general = AGENT_PROFILES.general;
  const agentCard = document.createElement("button");
  agentCard.className = "demo-card";
  agentCard.innerHTML = `
    <div class="d-head"><span class="d-num">${general.icon}</span><span class="d-name">${general.label} <span class="d-default">默认</span></span></div>
    <div class="d-desc">${general.description}</div>
    <div class="d-eg">${general.example}</div>`;
  agentCard.addEventListener("click", async () => {
    try { await createSession("agent", null, null); }
    catch (err) { uiAlert("创建对话失败：" + err.message, "创建对话"); }
  });
  container.appendChild(agentCard);

  // 内置示例（学习 Demo）
  for (const d of state.config.demos) {
    const card = document.createElement("button");
    card.className = "demo-card";
    card.innerHTML = `
      <div class="d-head"><span class="d-num">${d.id}</span><span class="d-name"></span></div>
      <div class="d-desc"></div>
      <div class="d-eg"></div>`;
    card.querySelector(".d-name").textContent = d.name;
    card.querySelector(".d-desc").textContent = d.desc;
    card.querySelector(".d-eg").textContent = "示例：" + d.example;
    card.addEventListener("click", async () => {
      try {
        await createSession("demo", d.id, d.example);
      } catch (err) { uiAlert("创建对话失败：" + err.message, "创建对话"); }
    });
    container.appendChild(card);
  }

  // 房产 Agent（贝壳）：真实找房 / 对比区位地图 / 户型图 / 预约带看
  const estate = AGENT_PROFILES.estate;
  const estateCard = document.createElement("button");
  estateCard.className = "demo-card";
  estateCard.innerHTML = `
    <div class="d-head"><span class="d-num">${estate.icon}</span><span class="d-name">${estate.label}</span></div>
    <div class="d-desc">${estate.description}</div>
    <div class="d-eg" id="estate-card-hint">示例：${estate.example}</div>`;
  estateCard.addEventListener("click", async () => {
    try { await createSession("estate"); }
    catch (err) { uiAlert("创建对话失败：" + err.message, "创建对话"); }
  });
  container.appendChild(estateCard);
}

function buildExampleChips() {
  const wrap = $("example-chips");
  wrap.innerHTML = "";
  for (const text of GENERAL_EXAMPLES) {
    const chip = document.createElement("button");
    chip.className = "ex-chip";
    chip.textContent = text;
    chip.addEventListener("click", async () => {
      try {
        await createSession("agent", null, text);
        await send();
      } catch (err) { uiAlert("创建对话失败：" + err.message, "创建对话"); }
    });
    wrap.appendChild(chip);
  }
}

function openModal() { $("modal-mask").classList.remove("hidden"); }
function closeModal() { $("modal-mask").classList.add("hidden"); }

/* ---------------------------------------------------------------------------
 * 设置（多供应商 × 多模型：添加 / 编辑 / 删除 / 切换 + 思考等级）
 * ------------------------------------------------------------------------- */

/** 顶栏按钮 / 侧栏 / 徽章的统一刷新 */
function applyConfigState(cfg) {
  state.config = cfg;
  const mock = Boolean(cfg.mock);
  $("mode-badge").classList.toggle("hidden", !mock);
  const sideModel = $("side-model");
  sideModel.classList.toggle("mock", mock);
  const active = (cfg.providers || []).find((p) => p.active);
  const activeModel = (active?.models || []).find((m) => m.active);
  const modelLabel = activeModel?.displayName || cfg.model;
  $("side-model-text").textContent = mock ? `模拟模式 · ${cfg.model}` : `${active ? active.name + " · " : ""}${modelLabel}`;
  const btnText = $("provider-btn-text");
  if (btnText) btnText.textContent = mock
    ? `模拟模式 · ${cfg.model}`
    : `${activeModel?.modality === "vision" ? "🖼 " : ""}${modelLabel}`;
  const reasonBadge = $("provider-btn-reason");
  if (reasonBadge) {
    const tag = activeModel && activeModel.reasoningLevel !== "default" ? activeModel.reasoningLabel : "";
    reasonBadge.textContent = tag;
    reasonBadge.classList.toggle("hidden", !tag);
    reasonBadge.title = tag ? `当前思考等级：${tag}` : "";
  }
  renderProviderMenu();
  renderComposerBar();
  updateContextBar();
  if (!$("settings-mask").classList.contains("hidden")) {
    renderProviderList();
    if (!$("provider-form-wrap").classList.contains("hidden")) renderModelPanel();
  }
}

/* ---------------------------------------------------------------------------
 * 输入框上方：模型 / 思考等级 快捷切换（ZCode 风格 composer bar）
 * ------------------------------------------------------------------------- */
function activeProviderOf() {
  return (state.config?.providers || []).find((p) => p.active) || null;
}
function activeModelEntryOf() {
  const p = activeProviderOf();
  return (p?.models || []).find((m) => m.active) || null;
}

/** 更新两个 chip 上的文字（applyConfigState 每次都会调用） */
function renderComposerBar() {
  const cfg = state.config;
  if (!cfg || !$("cm-model")) return;
  const m = activeModelEntryOf();
  const modelText = document.querySelector("#cm-model .cm-text");
  if (modelText) modelText.textContent = cfg.mock ? `模拟模式 · ${cfg.model}` : (m?.displayName || cfg.model);
  const r = cfg.reasoning || {};
  const thinkText = document.querySelector("#cm-thinking .cm-text");
  if (thinkText) {
    const lvl = (r.levels || []).find((l) => l.id === r.level);
    thinkText.textContent = `思考·${lvl?.label || r.label || "默认"}`;
  }
  // 弹出菜单开着时同步刷新内容
  if (!$("cm-model-menu")?.classList.contains("hidden")) renderModelMenu($("cm-model-menu"));
  if (!$("cm-thinking-menu")?.classList.contains("hidden")) renderThinkingMenu($("cm-thinking-menu"));
}

function closeCmMenus() {
  document.querySelectorAll(".cm-menu").forEach((el) => el.classList.add("hidden"));
  document.querySelectorAll(".cm-chip.on").forEach((el) => el.classList.remove("on"));
}

function toggleCmMenu(chipId, menuId, render) {
  const chip = $(chipId);
  const menu = $(menuId);
  if (!chip || !menu) return;
  const opening = menu.classList.contains("hidden");
  closeCmMenus();
  if (opening) {
    render(menu);
    menu.classList.remove("hidden");
    chip.classList.add("on");
  }
}

/** 模型菜单：按供应商分组列出全部「供应商 × 模型」组合，点击即切换 */
function renderModelMenu(menu) {
  const cfg = state.config;
  if (!cfg) return;
  menu.innerHTML = "";
  for (const p of cfg.providers || []) {
    const sec = document.createElement("div");
    sec.className = "cm-sec";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = p.name;
    const protoSpan = document.createElement("span");
    protoSpan.className = "cm-sub";
    protoSpan.textContent = p.protocol && p.protocol !== "openai" ? (PROTOCOL_LABEL[p.protocol] || p.protocol) : "";
    sec.append(nameSpan, protoSpan);
    menu.appendChild(sec);
    for (const m of p.models || []) {
      // 全局切换器里只给「当前正在使用的模型」打勾（启用中的供应商 × 它选中的模型），
      // 其他供应商各自选中的模型不打勾，避免菜单里同时出现多个 ✓
      const isCurrent = Boolean(p.active) && Boolean(m.active);
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cm-item" + (isCurrent ? " active" : "");
      item.innerHTML = `<span class="ck">${isCurrent ? "✓" : ""}</span><span class="cm-label"></span><span class="cm-sub">${m.modality === "vision" ? "🖼 多模态" : ""}</span>`;
      item.querySelector(".cm-label").textContent = m.displayName || m.name;
      item.title = isCurrent ? "当前模型" : `切换到 ${p.name} · ${m.name}`;
      item.addEventListener("click", async () => {
        if (isCurrent) { closeCmMenus(); return; }
        item.disabled = true;
        try {
          await api(`/api/config/providers/${p.id}/models/${m.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ makeActive: true }),
          });
          applyConfigState(await api("/api/config"));
        } catch (err) {
          uiAlert(`切换失败：${err.message}`, "切换模型");
        }
        closeCmMenus();
      });
      menu.appendChild(item);
    }
  }
  const divider = document.createElement("div");
  divider.className = "cm-divider";
  menu.appendChild(divider);
  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "cm-item";
  manage.innerHTML = `<span class="ck"></span><span class="cm-label">管理供应商与模型…</span>`;
  manage.addEventListener("click", () => { closeCmMenus(); openSettings(); });
  menu.appendChild(manage);
}

/** 思考等级菜单：选项来自当前模型方言（/api/config 的 reasoning.levels） */
function renderThinkingMenu(menu) {
  const r = state.config?.reasoning || {};
  menu.innerHTML = "";
  const sec = document.createElement("div");
  sec.className = "cm-sec";
  const head = document.createElement("span");
  head.textContent = `思考等级 · ${activeModelEntryOf()?.displayName || state.config?.model || ""}`;
  const sub = document.createElement("span");
  sub.className = "cm-sub";
  sub.textContent = r.dialectLabel || "";
  sec.append(head, sub);
  menu.appendChild(sec);
  for (const l of r.levels || []) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "cm-item" + (l.id === r.level ? " active" : "");
    item.innerHTML = `<span class="ck">${l.id === r.level ? "✓" : ""}</span><span class="cm-label"></span>`;
    item.querySelector(".cm-label").textContent = l.label;
    item.title = l.desc || "";
    item.addEventListener("click", async () => {
      if (l.id === r.level) { closeCmMenus(); return; }
      item.disabled = true;
      try {
        await api("/api/config/reasoning", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // 带上当前方言：确保「档位」按同一套划分方式解释
          body: JSON.stringify({ dialect: r.dialect && r.dialect !== "auto" ? r.dialect : undefined, level: l.id }),
        });
        applyConfigState(await api("/api/config"));
      } catch (err) {
        uiAlert(`设置失败：${err.message}`, "思考等级");
      }
      closeCmMenus();
    });
    menu.appendChild(item);
  }
  if (r.scheme) {
    const desc = document.createElement("div");
    desc.className = "cm-desc";
    desc.textContent = r.scheme;
    menu.appendChild(desc);
  }
}

/* ---------------------------------------------------------------------------
 * 上下文容量条 + 缓存占比
 * 数据来源：模型响应里的 usage（input ≈ 当时整段对话的上下文，
 * input_token_details.cache_read ≈ 提示词缓存命中）；分母来自网关 /models
 * 返回的 context_length（未知时不显示占比，只显示 token 数）。
 * ------------------------------------------------------------------------- */
function updateContextBar() {
  const bar = $("context-bar");
  const u = state.usage[state.currentId];
  if (!u || !u.contextTokens) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");

  const win = state.config?.contextWindow || null;
  const fill = $("ctx-fill");
  if (win) {
    const pct = Math.min(100, (u.contextTokens / win) * 100);
    fill.style.width = Math.max(1.5, pct) + "%";
    fill.className = "ctx-fill" + (pct > 92 ? " danger" : pct > 80 ? " warn" : "");
    $("ctx-text").textContent = `上下文 ${fmtTokens(u.contextTokens)} / ${fmtTokens(win)} tokens（${pct.toFixed(1)}%）`;
  } else {
    fill.style.width = "0%";
    fill.className = "ctx-fill";
    $("ctx-text").textContent = `上下文 ${fmtTokens(u.contextTokens)} tokens · 容量未知（设置里「获取列表」后显示占比）`;
  }

  const cacheEl = $("ctx-cache");
  if (u.lastInput > 0 && u.lastCache > 0) {
    cacheEl.textContent = `缓存命中 ${Math.round((u.lastCache / u.lastInput) * 100)}%`;
    cacheEl.classList.remove("hidden");
  } else {
    cacheEl.classList.add("hidden");
  }
}

/** 助手回合末尾的用量小字：↑ 输入 · ↓ 输出 · 缓存 N% */
function updateTurnCaption(ablock) {
  const u = ablock._usage;
  if (!u) return;
  const body = blockBodies.get(ablock);
  if (!body) return;
  let el = usageEls.get(ablock);
  if (!el || !el.isConnected) {
    el = document.createElement("div");
    el.className = "usage-caption";
    body.appendChild(el);
    usageEls.set(ablock, el);
  }
  const cache = u.lastCache > 0 && u.lastInput > 0 ? ` · 缓存 ${Math.round((u.lastCache / u.lastInput) * 100)}%` : "";
  el.textContent = `↑ ${u.lastInput.toLocaleString("zh-CN")} · ↓ ${u.lastOutput.toLocaleString("zh-CN")}${cache}`;
}

/* ----- 顶栏快捷切换菜单：模型菜单（按供应商分组）+ 思考等级档位 ----- */
function showProviderMenu(show) {
  $("provider-menu").classList.toggle("hidden", !show);
}

/**
 * 顶栏 ▾ 菜单 = 「所有供应商的所有模型」清单。
 * 旧版这里只列供应商、每个供应商只挂一个模型，于是「同一个网关下的第二个模型」
 * 根本没有入口（下拉里看起来只有一个模型）—— 现在按供应商分组列出全部模型，
 * 点任意一行即切换「供应商 + 模型」，并在顶部给出当前模型的思考等级档位。
 */
function renderProviderMenu() {
  const menu = $("provider-menu");
  menu.innerHTML = "";
  const cfg = state.config || {};
  const providers = cfg.providers || [];
  const activeProvider = providers.find((p) => p.active);
  const activeModel = (activeProvider?.models || []).find((m) => m.active);

  // ── ① 当前模型的思考等级：档位 chips（档位随供应商方言变化）──
  const r = cfg.reasoning;
  if (r && activeModel) {
    const box = document.createElement("div");
    box.className = "pm-reason-box";

    const head = document.createElement("div");
    head.className = "pm-reason-head";
    const title = document.createElement("span");
    title.textContent = `⚡ ${activeModel.displayName} · 思考等级`;
    const now = document.createElement("em");
    now.className = "pm-reason-now";
    now.textContent = r.label;
    now.title = r.scheme;
    head.append(title, now);
    box.appendChild(head);

    const chips = document.createElement("div");
    chips.className = "pm-chips";
    for (const lv of r.levels || []) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "pm-chip" + (lv.id === r.level ? " active" : "");
      chip.textContent = lv.label;
      chip.title = lv.desc;
      chip.addEventListener("click", (e) => { e.stopPropagation(); setReasoningLevel(lv.id); });
      chips.appendChild(chip);
    }
    box.appendChild(chips);

    const scheme = document.createElement("div");
    scheme.className = "pm-scheme";
    scheme.textContent = (r.auto ? `自动识别为「${r.dialectLabel}」（${r.vendor}）· ` : "") + r.scheme;
    box.appendChild(scheme);
    if (r.error) {
      const err = document.createElement("div");
      err.className = "pm-scheme err";
      err.textContent = `⚠ ${r.error}`;
      box.appendChild(err);
    }
    menu.appendChild(box);
  }

  // ── ② 供应商分组 → 组内每个模型一行 ──
  for (const p of providers) {
    const group = document.createElement("div");
    group.className = "pm-group";

    const head = document.createElement("div");
    head.className = "pm-group-head";
    const gname = document.createElement("span");
    gname.className = "pm-g-name";
    gname.textContent = p.name;
    gname.title = p.baseURL;
    head.appendChild(gname);
    if (p.protocol && p.protocol !== "openai") {
      const proto = document.createElement("span");
      proto.className = "pm-g-badge";
      proto.textContent = PROTOCOL_LABEL[p.protocol] || p.protocol;
      head.appendChild(proto);
    }
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "pm-g-edit";
    edit.textContent = "编辑";
    edit.title = "在设置里编辑这个供应商与它的模型";
    edit.addEventListener("click", (e) => { e.stopPropagation(); showProviderMenu(false); openSettings(p.id); });
    head.appendChild(edit);
    group.appendChild(head);

    if (!p.models || !p.models.length) {
      const empty = document.createElement("div");
      empty.className = "pm-empty";
      empty.textContent = "还没有模型 —— 点「编辑」添加";
      group.appendChild(empty);
    }

    for (const m of p.models || []) {
      const current = Boolean(p.active) && Boolean(m.active);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pm-item" + (current ? " active" : "");
      row.title = `${m.name} · ${p.baseURL}\n思考等级：${m.reasoningLabel}（${m.reasoningDialect}）`;
      row.innerHTML = `<span class="pm-check">${current ? "✓" : ""}</span>`
        + `<span class="pm-name"></span>`
        + `<span class="pm-model"></span>`;
      row.querySelector(".pm-name").textContent = `${m.modality === "vision" ? "🖼 " : ""}${m.displayName}`;
      const tag = reasoningTag(m);
      const right = row.querySelector(".pm-model");
      right.textContent = tag || (m.displayName === m.name ? "" : m.name);
      if (tag) right.classList.add("hot");
      row.addEventListener("click", async () => {
        showProviderMenu(false);
        if (!current) await activateModel(p.id, m.id);
      });
      group.appendChild(row);
    }
    menu.appendChild(group);
  }

  const divider = document.createElement("div");
  divider.className = "pm-divider";
  menu.appendChild(divider);
  const manage = document.createElement("button");
  manage.className = "pm-item pm-manage";
  manage.textContent = "⚙ 管理供应商与模型（添加 / 编辑 / 删除）";
  manage.addEventListener("click", () => { showProviderMenu(false); openSettings(); });
  menu.appendChild(manage);
}

/* ----- 设置弹窗：供应商列表 + 每个供应商的模型 ----- */
let settingsFocusProviderId = null; // 从菜单「编辑」进来时高亮的供应商

function openSettings(focusProviderId) {
  showProviderMenu(false);
  settingsFocusProviderId = focusProviderId || null;
  api("/api/config").then(applyConfigState).catch(() => {});
  closeProviderForm();
  $("settings-mask").classList.remove("hidden");
}

/* ----- 记忆弹窗：跨会话长期记忆的查看 / 新增 / 删除 ----- */
function memStatus(text, cls) {
  const el = $("memories-status");
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  if (text) setTimeout(() => { if (el.textContent === text) { el.textContent = ""; el.className = "settings-status"; } }, 4000);
}

function renderMemoriesList(memories) {
  const list = $("memories-list");
  list.innerHTML = "";
  if (!memories.length) {
    const empty = document.createElement("p");
    empty.className = "memories-empty";
    empty.textContent = "还没有长期记忆。在对话里说「记住：…」或用下面的表单手动添加。";
    list.appendChild(empty);
    return;
  }
  for (const m of memories) {
    // innerHTML 搭骨架 + textContent 填正文（天然防注入，见 AGENTS.md §5.5）
    const row = document.createElement("div");
    row.className = "memory-item";
    row.innerHTML = `
      <div class="m-body">
        <div class="m-key"></div>
        <div class="m-content"></div>
        <div class="m-meta"></div>
      </div>
      <button class="p-del" title="删除这条记忆">删除</button>`;
    row.querySelector(".m-key").textContent = m.key;
    row.querySelector(".m-content").textContent = m.content;
    const when = new Date(m.updatedAt).toLocaleString();
    row.querySelector(".m-meta").textContent = `${m.source === "agent" ? "Agent 保存" : "手动添加"} · ${when}`;
    row.querySelector(".p-del").addEventListener("click", async () => {
      try {
        await api(`/api/memories/${encodeURIComponent(m.id)}`, { method: "DELETE" });
        await refreshMemories();
        memStatus("已删除", "ok");
      } catch (err) {
        memStatus(`✗ ${err.message}`, "err");
      }
    });
    list.appendChild(row);
  }
}

async function refreshMemories() {
  const data = await api("/api/memories");
  renderMemoriesList(data.memories || []);
  return data.memories || [];
}

async function saveMemoryFromForm() {
  const key = $("mem-key").value.trim();
  const content = $("mem-content").value.trim();
  if (!key || !content) { memStatus("主题与内容都要填", "err"); return; }
  try {
    await api("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, content }),
    });
    $("mem-key").value = "";
    $("mem-content").value = "";
    await refreshMemories();
    memStatus("已保存（下轮对话即生效）", "ok");
  } catch (err) {
    memStatus(`✗ ${err.message}`, "err");
  }
}

function openMemories() {
  $("memories-mask").classList.remove("hidden");
  refreshMemories().catch((err) => memStatus(`✗ ${err.message}`, "err"));
}

function renderProviderList() {
  const list = $("provider-list");
  list.innerHTML = "";
  const providers = state.config?.providers || [];
  for (const p of providers) {
    const row = document.createElement("div");
    row.className = "provider-row" + (p.active ? " active" : "")
      + (settingsFocusProviderId === p.id ? " focused" : "");
    row.innerHTML = `
      <div class="p-info">
        <div class="p-name"><span class="nm"></span><span class="p-badge ${p.hasKey ? "" : "nokey"}">${p.hasKey ? "✓ Key" : "无 Key"}</span>${p.protocol && p.protocol !== "openai" ? `<span class="p-badge proto">${PROTOCOL_LABEL[p.protocol] || p.protocol}</span>` : ""}${p.active ? '<span class="p-badge">启用中</span>' : ""}</div>
        <div class="p-detail"></div>
      </div>
      <div class="p-actions">
        <button class="p-use ${p.active ? "in-use" : ""}">${p.active ? "使用中" : "启用"}</button>
        <button class="p-edit">编辑</button>
        ${providers.length > 1 ? '<button class="p-del">删除</button>' : ""}
      </div>`;
    row.querySelector(".nm").textContent = p.name;
    row.querySelector(".p-detail").textContent = `${p.baseURL} · ${(p.models || []).length} 个模型`;
    if (!p.active) row.querySelector(".p-use").addEventListener("click", () => activateModel(p.id, null));
    row.querySelector(".p-edit").addEventListener("click", () => openProviderForm(p.id));
    const del = row.querySelector(".p-del");
    if (del) del.addEventListener("click", () => removeProvider(p.id, p.name));

    // 模型 chips：点一下就把「该供应商的这个模型」设为启用
    const chips = document.createElement("div");
    chips.className = "p-models";
    for (const m of p.models || []) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "p-model-chip" + (p.active && m.active ? " active" : "");
      chip.title = `${m.name}\n思考等级：${m.reasoningLabel}（${m.reasoningDialect}）`;
      chip.textContent = `${p.active && m.active ? "✓ " : ""}${m.displayName}${reasoningTag(m) ? ` · ${reasoningTag(m)}` : ""}`;
      chip.addEventListener("click", async () => {
        if (!(p.active && m.active)) await activateModel(p.id, m.id);
        else openProviderForm(p.id, m.id);
      });
      chips.appendChild(chip);
    }
    if (!(p.models || []).length) {
      const none = document.createElement("span");
      none.className = "p-model-none";
      none.textContent = "还没有模型，点「编辑」添加";
      chips.appendChild(none);
    }
    row.querySelector(".p-info").appendChild(chips);
    list.appendChild(row);
  }
  if (settingsFocusProviderId) {
    const el = list.querySelector(".provider-row.focused");
    if (el) el.scrollIntoView({ block: "nearest" });
  }
}

/* ----- 设置弹窗：编辑表单（供应商 + 它的模型列表 + 单个模型编辑） ----- */
let editingProviderId = null; // null = 新增模式，否则为正在编辑的供应商 id
let editingModelId = null;    // 正在「模型编辑面板」里编辑的模型 id
let pendingModels = [];       // 新增供应商模式下待提交的模型（[{name, modality, contextWindow}]）
let gatewayModels = [];       // 最近一次「获取列表」拿到的网关模型（[{id, contextWindow, supportsVision}]）

function currentEditingProvider() {
  return editingProviderId ? (state.config?.providers || []).find((x) => x.id === editingProviderId) : null;
}

function currentEditingModel() {
  const p = currentEditingProvider();
  return p && editingModelId ? (p.models || []).find((m) => m.id === editingModelId) : null;
}

function openProviderForm(providerId, focusModelId) {
  editingProviderId = providerId || null;
  editingModelId = null;
  const p = currentEditingProvider();
  $("pf-mode").textContent = p ? p.name : "新增供应商";
  $("pf-mode").className = "key-state" + (p ? " ok" : "");
  $("pf-name").value = p?.name || "";
  $("pf-base-url").value = p?.baseURL || "";
  $("pf-api-key").value = "";
  $("pf-api-key").type = "password";
  $("pf-protocol").value = p?.protocol || "openai";
  $("pf-key-state").textContent = p ? (p.hasKey ? `已保存 ${p.keyMasked}，留空则不修改` : "未保存 Key") : "";
  $("pf-key-state").className = "key-state" + (p?.hasKey ? " ok" : "");
  $("pf-model-new").value = "";
  gatewayModels = [];
  renderGatewayModels();
  if (!p) pendingModels = [];
  renderModelPanel();
  closeModelForm();
  setSettingsStatus("", "");
  $("provider-form-wrap").classList.remove("hidden");
  $("pf-name").focus();
  if (focusModelId && p) openModelForm(p.id, focusModelId);
}

function closeProviderForm() {
  editingProviderId = null;
  editingModelId = null;
  pendingModels = [];
  gatewayModels = [];
  $("provider-form-wrap").classList.add("hidden");
  closeModelForm();
}

function closeModelForm() {
  editingModelId = null;
  $("model-form-wrap").classList.add("hidden");
}

/** 模型列表：编辑模式下每行一个模型（可设启用 / 编辑 / 删除），新增模式下是待提交清单 */
function renderModelPanel() {
  const list = $("pf-model-list");
  list.innerHTML = "";
  const p = currentEditingProvider();
  $("pf-model-count").textContent = p
    ? `共 ${(p.models || []).length} 个 · 一个供应商可添加多个模型`
    : "保存供应商后再逐个添加模型（可先「获取列表」）";

  const models = p ? (p.models || []) : pendingModels.map((m) => ({ ...m, id: `pending:${m.name}`, reasoningLevel: "default", reasoningLabel: "供应商默认", displayName: m.name, active: false }));
  if (!models.length) {
    const empty = document.createElement("div");
    empty.className = "model-empty";
    empty.textContent = p ? "还没有模型：在下面输入模型名，或点「获取列表」从网关挑选（可加多个）" : "在下面输入模型名，或点「获取列表」从网关挑选（可加多个）";
    list.appendChild(empty);
    return;
  }

  for (const m of models) {
    const row = document.createElement("div");
    row.className = "model-row" + (m.active ? " active" : "") + (m.id === editingModelId ? " editing" : "");
    row.innerHTML = `
      <button type="button" class="m-pick" title="设为该供应商的启用模型">${m.active ? "✓" : "○"}</button>
      <div class="m-info">
        <div class="m-name"></div>
        <div class="m-detail"></div>
      </div>
      <div class="m-actions">
        <button type="button" class="m-edit">编辑</button>
        <button type="button" class="m-del">删除</button>
      </div>`;
    row.querySelector(".m-name").textContent = `${m.modality === "vision" ? "🖼 " : ""}${m.displayName || m.name}`;
    row.querySelector(".m-detail").textContent =
      `${m.name} · 思考等级 ${m.reasoningLabel || "供应商默认"}`
      + (m.manualContextWindow ? ` · 窗口 ${fmtTokens(m.manualContextWindow)}` : m.contextWindow ? ` · 窗口 ${fmtTokens(m.contextWindow)}（网关）` : "");
    const pick = row.querySelector(".m-pick");
    if (p) {
      pick.addEventListener("click", () => { if (!m.active) activateModel(p.id, m.id); });
      row.querySelector(".m-edit").addEventListener("click", () => openModelForm(p.id, m.id));
      row.querySelector(".m-del").addEventListener("click", () => removeModel(p.id, m.id, m.name));
    } else {
      pick.classList.add("ghost");
      pick.addEventListener("click", () => { pendingModels = pendingModels.filter((x) => x.name !== m.name); renderModelPanel(); });
      pick.textContent = "×";
      pick.title = "从待添加清单里移除";
      row.querySelector(".m-edit").textContent = "移除";
      row.querySelector(".m-edit").addEventListener("click", () => { pendingModels = pendingModels.filter((x) => x.name !== m.name); renderModelPanel(); });
      row.querySelector(".m-del").classList.add("hidden");
    }
    list.appendChild(row);
  }
}

/** 从网关拉取的模型清单：全部平铺成可点即添加的 chips（不再用会被输入过滤的 datalist） */
function renderGatewayModels() {
  const box = $("gateway-models");
  box.innerHTML = "";
  if (!gatewayModels.length) return;
  const label = document.createElement("div");
  label.className = "gw-label";
  label.textContent = `网关返回 ${gatewayModels.length} 个模型（点一下直接添加）：`;
  box.appendChild(label);
  const wrap = document.createElement("div");
  wrap.className = "gw-chips";
  const existing = new Set(
    (currentEditingProvider()?.models || []).map((m) => m.name).concat(pendingModels.map((m) => m.name))
  );
  for (const m of gatewayModels) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "gw-chip" + (existing.has(m.id) ? " added" : "");
    chip.textContent = (existing.has(m.id) ? "✓ " : "＋ ") + m.id
      + (m.contextWindow ? ` · ${fmtTokens(m.contextWindow)}` : "")
      + (m.supportsVision ? " · 🖼" : "")
      + (m.supportsReasoning ? " · ⚡" : "");
    chip.title = `${m.id}\n上下文：${m.contextWindow ?? "未知"}\n多模态：${m.supportsVision ? "是" : "未知"} · 支持推理：${m.supportsReasoning ? "是" : "未知"}`;
    chip.addEventListener("click", () => addModelByName(m.id, m));
    wrap.appendChild(chip);
  }
  box.appendChild(wrap);
}

/** 单个模型的编辑面板（模型名 / 显示名 / 多模态 / 上下文 / 思考等级） */
function openModelForm(providerId, modelId) {
  const p = (state.config?.providers || []).find((x) => x.id === providerId);
  const m = p && (p.models || []).find((x) => x.id === modelId);
  if (!p || !m) return;
  editingProviderId = p.id;
  editingModelId = m.id;
  $("mf-mode").textContent = `${p.name} · ${m.displayName}`;
  $("mf-mode").className = "key-state ok";
  $("mf-name").value = m.name;
  $("mf-label").value = m.displayName === m.name ? "" : m.displayName;
  $("mf-vision").checked = m.modality === "vision";
  $("mf-ctx").value = m.manualContextWindow ?? "";
  renderDialectSelect(m.reasoning?.dialect || "auto", m.reasoning?.level || "default", m.reasoning?.custom || "");
  $("model-form-wrap").classList.remove("hidden");
  renderModelPanel();
  $("mf-name").focus();
}

/** 「思考等级划分方式」下拉：自动识别 + 全部方言（每家供应商的档位都不一样） */
function renderDialectSelect(dialect, level, custom) {
  const dialects = state.config?.dialects || [];
  const dSel = $("mf-dialect");
  dSel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "自动识别（按网关地址 / 模型名判断）";
  dSel.appendChild(auto);
  for (const d of dialects) {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = `${d.label} —— ${d.vendor}`;
    opt.title = d.scheme;
    dSel.appendChild(opt);
  }
  dSel.value = dialect;
  renderLevelSelect(dialect, level, custom);
}

/** 「思考等级」下拉：档位来自选中的方言（OpenAI 五档 / 智谱两态 / Anthropic 预算…） */
function renderLevelSelect(dialect, level, custom) {
  const dialects = state.config?.dialects || [];
  const effective = dialect === "auto"
    ? (state.config?.reasoning?.dialect || "none")
    : dialect;
  const d = dialects.find((x) => x.id === effective);
  const lSel = $("mf-level");
  lSel.innerHTML = "";
  for (const lv of d?.levels || [{ id: "default", label: "供应商默认", desc: "" }]) {
    const opt = document.createElement("option");
    opt.value = lv.id;
    opt.textContent = lv.label;
    opt.title = lv.desc;
    lSel.appendChild(opt);
  }
  lSel.value = (d?.levels || []).some((l) => l.id === level) ? level : "default";
  $("mf-dialect-hint").textContent = dialect === "auto"
    ? `当前自动识别为「${state.config?.reasoning?.dialectLabel || "—"}」`
    : (d ? `请求字段 ${d.field}` : "");
  // 方言与协议不匹配时给出提示（llm.ts 会做近似换算，不会白选，但语义可能略有偏差）
  const protocol = currentEditingProvider()?.protocol || "openai";
  const mismatch = d?.protocols && !d.protocols.includes(protocol);
  $("mf-scheme").textContent = (d?.scheme || "")
    + (mismatch ? `\n⚠ 这个划分方式是为「${d.protocols.join(" / ")}」协议准备的，当前供应商用的是「${protocol}」协议：档位会按近似方式换算后发送（详见 README 的思考等级章节）。` : "");
  const showCustom = effective === "custom" && lSel.value === "custom";
  $("mf-custom").classList.toggle("hidden", !showCustom);
  if (showCustom && custom) $("mf-custom").value = custom;
  else if (!showCustom) $("mf-custom").value = "";
}

function setSettingsStatus(text, kind) {
  const el = $("settings-status");
  el.textContent = text;
  el.className = "settings-status" + (kind ? " " + kind : "");
}

/** 测试连接 / 拉取模型：新供应商用表单值；编辑已存供应商且 Key 留空 → 用已保存的 Key */
async function fetchGatewayModelChips() {
  const baseURL = $("pf-base-url").value.trim();
  const apiKeyRaw = $("pf-api-key").value.trim();
  if (!baseURL) { setSettingsStatus("✗ 请先填写 BASE_URL", "err"); return; }
  const body = { baseURL };
  if (apiKeyRaw) body.apiKey = apiKeyRaw;
  else if (editingProviderId) body.providerId = editingProviderId;
  body.protocol = $("pf-protocol").value;

  setSettingsStatus("正在连接网关…", "");
  try {
    const res = await api("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      gatewayModels = res.models || [];
      renderGatewayModels();
      setSettingsStatus(`✓ 连接成功，网关共 ${gatewayModels.length} 个模型 —— 下面点一下即可添加（也可以直接手动输入模型名）`, "ok");
      // 拉取成功会把 context_length 写入服务端缓存 → 刷新配置以更新容量条分母
      if (res.contextWindow) api("/api/config").then(applyConfigState).catch(() => {});
    } else {
      setSettingsStatus(`✗ ${res.error}`, "err");
    }
  } catch (err) {
    setSettingsStatus(`✗ ${err.message}`, "err");
  }
}

/** 把某个模型名加进「当前供应商」（编辑模式）或待添加清单（新增模式） */
async function addModelByName(name, meta) {
  const modelName = (name || "").trim();
  if (!modelName) { setSettingsStatus("✗ 模型名不能为空", "err"); return; }
  if (editingProviderId) {
    try {
      const res = await api(`/api/config/providers/${editingProviderId}/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: modelName,
          modality: meta?.supportsVision ? "vision" : undefined,
          contextWindow: meta?.contextWindow ?? undefined,
        }),
      });
      await applyConfigState(await api("/api/config"));
      $("pf-model-new").value = "";
      renderGatewayModels();
      setSettingsStatus(res.created ? `✓ 已添加模型「${modelName}」并设为该供应商的启用模型` : `✓ 「${modelName}」已存在，已更新并设为启用模型`, "ok");
      openModelForm(editingProviderId, res.model.id);
    } catch (err) {
      setSettingsStatus(`✗ ${err.message}`, "err");
    }
    return;
  }
  if (pendingModels.some((m) => m.name === modelName)) { setSettingsStatus("✗ 该模型已在待添加清单里", "err"); return; }
  pendingModels.push({ name: modelName, modality: meta?.supportsVision ? "vision" : "text", contextWindow: meta?.contextWindow ?? null });
  $("pf-model-new").value = "";
  renderModelPanel();
  renderGatewayModels();
  setSettingsStatus(`✓ 已加入待添加清单（保存供应商时一起提交，共 ${pendingModels.length} 个）`, "ok");
}

async function saveProvider() {
  const name = $("pf-name").value.trim();
  const baseURL = $("pf-base-url").value.trim();
  const apiKeyRaw = $("pf-api-key").value.trim();
  if (!name) { setSettingsStatus("✗ 名称不能为空", "err"); return; }
  if (!baseURL) { setSettingsStatus("✗ BASE_URL 不能为空", "err"); return; }

  const body = { name, baseURL, protocol: $("pf-protocol").value };
  if (apiKeyRaw) body.apiKey = apiKeyRaw; // 留空 = 不修改已保存的 Key

  try {
    if (editingProviderId) {
      const res = await api(`/api/config/providers/${editingProviderId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setSettingsStatus(res.activeChanged ? "✓ 已保存并应用到当前会话配置" : "✓ 已保存（该供应商未启用）", "ok");
    } else {
      if (!pendingModels.length) {
        setSettingsStatus("✗ 至少填一个模型名（可先点「获取列表」从网关选择）", "err");
        return;
      }
      body.models = pendingModels.map((m) => ({ name: m.name, modality: m.modality, contextWindow: m.contextWindow ?? undefined }));
      const res = await api("/api/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      editingProviderId = res.provider.id; // 保存后转为编辑态，便于继续加模型
      pendingModels = [];
      setSettingsStatus(`✓ 已添加供应商（${res.provider.models.length} 个模型）${res.activeChanged ? "并启用" : ""}`, "ok");
    }
    await applyConfigState(await api("/api/config"));
    // 保存成功后关闭设置弹窗；模型上下文等参数下次点模型「编辑」仍可继续配置。
    // 不调用 openProviderForm：它会重置表单并关闭模型编辑面板，造成“保存后还停在编辑态”。
    $("settings-mask").classList.add("hidden");
    closeProviderForm();
  } catch (err) {
    setSettingsStatus(`✗ ${err.message}`, "err");
  }
}

/** 保存「模型编辑面板」里的改动（含思考等级） */
async function saveModel() {
  const p = currentEditingProvider();
  const m = currentEditingModel();
  if (!p || !m) return;
  const name = $("mf-name").value.trim();
  if (!name) { setSettingsStatus("✗ 模型名不能为空", "err"); return; }
  const dialect = $("mf-dialect").value;
  const level = $("mf-level").value;
  const body = {
    name,
    label: $("mf-label").value.trim(),
    modality: $("mf-vision").checked ? "vision" : "text",
    contextWindow: $("mf-ctx").value.trim(), // 空串 = 清除手动上下文
    reasoning: {
      dialect,
      level,
      custom: dialect === "custom" ? $("mf-custom").value : "",
    },
  };
  try {
    const res = await api(`/api/config/providers/${p.id}/models/${m.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await applyConfigState(await api("/api/config"));
    openModelForm(p.id, m.id);
    setSettingsStatus(`✓ 已保存模型「${name}」· 思考等级 ${res.model.reasoningLabel}`, "ok");
  } catch (err) {
    setSettingsStatus(`✗ ${err.message}`, "err");
  }
}

async function removeModel(providerId, modelId, name) {
  if (!(await uiConfirm(`确定删除模型「${name}」？`, { title: "删除模型", okText: "删除", danger: true }))) return;
  try {
    await api(`/api/config/providers/${providerId}/models/${modelId}`, { method: "DELETE" });
    await applyConfigState(await api("/api/config"));
    if (editingModelId === modelId) closeModelForm();
    renderModelPanel();
    setSettingsStatus(`✓ 已删除模型「${name}」`, "ok");
  } catch (err) {
    setSettingsStatus(`✗ ${err.message}`, "err");
  }
}

/** 切换「供应商 + 模型」（顶栏下拉、供应商列表的模型 chip、设为启用模型 都走它） */
async function activateModel(providerId, modelId) {
  try {
    const res = await api("/api/config/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, modelId }),
    });
    await applyConfigState(await api("/api/config"));
    if (!$("settings-mask").classList.contains("hidden")) {
      setSettingsStatus(`✓ 已启用「${res.name} · ${res.model}」· 思考等级 ${res.reasoningLabel}${res.mock ? "（无 Key → 模拟模式）" : ""}`, "ok");
      renderModelPanel();
    }
  } catch (err) {
    if (!$("settings-mask").classList.contains("hidden")) setSettingsStatus(`✗ ${err.message}`, "err");
    else uiAlert(`切换失败：${err.message}`, "切换模型");
  }
}

/** 顶栏快捷调整当前模型的思考等级（档位来自该供应商的方言） */
async function setReasoningLevel(level) {
  try {
    await api("/api/config/reasoning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level }),
    });
    await applyConfigState(await api("/api/config"));
    const label = state.config?.reasoning?.label || level;
    if (!$("settings-mask").classList.contains("hidden")) {
      setSettingsStatus(`✓ 思考等级已切换为「${label}」`, "ok");
      const p = currentEditingProvider();
      if (p && editingModelId) openModelForm(p.id, editingModelId);
    }
  } catch (err) {
    uiAlert(`思考等级切换失败：${err.message}`, "思考等级");
  }
}

async function removeProvider(id, name) {
  if (!(await uiConfirm(`确定删除供应商「${name}」？（它下面的模型会一起删除）`, { title: "删除供应商", okText: "删除", danger: true }))) return;
  try {
    await api(`/api/config/providers/${id}`, { method: "DELETE" });
    await applyConfigState(await api("/api/config"));
    if (editingProviderId === id) closeProviderForm();
  } catch (err) {
    uiAlert(`删除失败：${err.message}`, "删除供应商");
  }
}

/* ---------------------------------------------------------------------------
 * 文件上下文：项目文件 / 远程文件夹 / 本地上传
 * ------------------------------------------------------------------------- */
state.pendingFiles = []; // [{kind:"fs"|"upload", path?, uploadId?, name, source}]
let fsCwd = null;        // 当前浏览目录（null = 默认项目根）
let fsParent = null;     // 上一级目录（根目录时为 null）

function refKey(f) { return f.kind === "upload" ? `up:${f.uploadId}` : `fs:${f.path}`; }

function renderAttachChips() {
  const wrap = $("attach-chips");
  wrap.innerHTML = "";
  if (!state.pendingFiles.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  for (const f of state.pendingFiles) {
    const chip = document.createElement("span");
    chip.className = "attach-chip" + (f.preview ? " has-thumb" : "");
    chip.innerHTML = `
      ${f.preview ? `<img class="thumb" alt="">` : "📎"}
      <span class="c-name"></span>
      <span class="c-src"></span>
      <button class="c-del" title="移除">✕</button>`;
    chip.querySelector(".c-name").textContent = f.name;
    chip.querySelector(".c-src").textContent = f.preview ? "图片" : f.source;
    if (f.preview) chip.querySelector(".thumb").src = f.preview;
    chip.querySelector(".c-del").addEventListener("click", () => {
      state.pendingFiles = state.pendingFiles.filter((x) => refKey(x) !== refKey(f));
      renderAttachChips();
      renderFsSelection();
    });
    wrap.appendChild(chip);
  }
}

function addPendingFile(f) {
  if (state.pendingFiles.length >= 5) { uiAlert("单条消息最多附加 5 个文件", "附件数量超限"); return false; }
  if (state.pendingFiles.some((x) => refKey(x) === refKey(f))) return true; // 已选
  state.pendingFiles.push(f);
  renderAttachChips();
  renderFsSelection();
  return true;
}

function removePendingFile(key) {
  state.pendingFiles = state.pendingFiles.filter((x) => refKey(x) !== key);
  renderAttachChips();
  renderFsSelection();
}

/* ----- 文件选择器弹窗 ----- */
async function openFsModal() {
  if (!state.currentId) { uiAlert("请先选择或新建会话", "提示"); return; }
  $("fs-mask").classList.remove("hidden");
  await browseFs(null); // 回到默认项目根
}

function closeFsModal() { $("fs-mask").classList.add("hidden"); }

async function browseFs(path) {
  const list = $("fs-list");
  list.innerHTML = `<div class="fs-empty">加载中…</div>`;
  try {
    const data = await api("/api/fs/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    fsCwd = data.path;
    fsParent = data.parent;
    $("fs-path").textContent = data.path;
    $("fs-up").disabled = !data.parent;
    const rootSel = $("fs-root");
    rootSel.innerHTML = "";
    for (const r of data.roots) {
      const opt = document.createElement("option");
      opt.value = r.path;
      opt.textContent = `${r.type === "cloud" ? "☁️" : "💻"} ${r.name}`;
      rootSel.appendChild(opt);
    }
    // 位置下拉显示「最长匹配」的授权根（项目根是 work 的子目录，应优先显示项目根）
    const best = data.roots
      .filter((r) => data.path === r.path || data.path.startsWith(r.path.replace(/[\\/]+$/, "") + "/") || data.path.startsWith(r.path.replace(/[\\/]+$/, "") + "\\"))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (best) rootSel.value = best.path;
    renderFsRows(data.entries);
  } catch (err) {
    list.innerHTML = `<div class="fs-empty">✗ ${err.message}</div>`;
  }
}

function isFileSelected(ref) {
  return state.pendingFiles.some((x) => refKey(x) === refKey(ref));
}

function renderFsSelection() {
  const el = $("fs-selected");
  if (!el) return;
  el.textContent = state.pendingFiles.length
    ? `已选 ${state.pendingFiles.length} 个：${state.pendingFiles.map((f) => f.name).join("、")}`
    : "未选择文件（点击文件名勾选，再点「完成」加到输入框）";
  // 同步列表勾选标记
  document.querySelectorAll(".fs-row[data-key]").forEach((row) => {
    const selected = state.pendingFiles.some((x) => refKey(x) === row.dataset.key);
    row.classList.toggle("selected", selected);
    const check = row.querySelector(".f-check");
    if (check) check.textContent = selected ? "✓" : "";
  });
}

function renderFsRows(entries) {
  const list = $("fs-list");
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `<div class="fs-empty">（空文件夹）</div>`;
    return;
  }
  for (const e of entries) {
    const row = document.createElement("button");
    const ref = { kind: "fs", path: (fsCwd ? fsCwd.replace(/[\\/]+$/, "") + "/" : "") + e.name, name: e.name };
    row.className = "fs-row" + (e.type === "dir" ? " dir" : "");
    if (e.type === "file") {
      row.dataset.key = refKey(ref);
      if (isFileSelected(ref)) row.classList.add("selected");
    }
    row.innerHTML = `<span class="f-icon">${e.type === "dir" ? "📁" : "📄"}</span><span class="f-name"></span><span class="f-check"></span><span class="f-size"></span>`;
    row.querySelector(".f-name").textContent = e.name;
    row.querySelector(".f-size").textContent = e.type === "file" ? fmtSize(e.size) : "";
    row.addEventListener("click", () => {
      if (e.type === "dir") browseFs(ref.path);
      else {
        if (isFileSelected(ref)) removePendingFile(refKey(ref));
        else addPendingFile(ref);
      }
    });
    list.appendChild(row);
  }
}


async function openRemoteFolder() {
  const p = await uiPrompt(
    "输入服务器上的文件夹绝对路径（例如 E:\\study 或 /home/user/project）：\n⚠ 这会把该目录暴露给网页端浏览，仅建议在本地/可信环境使用",
    { title: "打开远程文件夹", placeholder: "E:\\study 或 /home/user/project" }
  );
  if (!p || !p.trim()) return;
  try {
    const res = await api("/api/fs/open-remote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    });
    await browseFs(res.path);
  } catch (err) {
    uiAlert("打开失败：" + err.message, "打开远程文件夹");
  }
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
}

async function uploadLocalFiles(fileList) {
  for (const file of fileList) {
    const isImage = file.type.startsWith("image/");
    if (isImage && file.size > 4_500_000) { uiAlert(`「${file.name}」图片过大（>4.5MB）`, "文件过大"); continue; }
    if (!isImage && file.size > 800_000) { uiAlert(`「${file.name}」过大（>800KB），请压缩或拆分`, "文件过大"); continue; }
    try {
      let content, image = false, preview = null;
      if (isImage) {
        content = await readAsDataURL(file); // dataURL：多模态模型可直接消费
        image = true;
        preview = content;
      } else {
        content = await file.text();
      }
      const res = await api("/api/files/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, content, image }),
      });
      addPendingFile({
        kind: "upload", uploadId: res.id, name: res.name,
        source: isImage ? "图片" : "本地上传", preview,
      });
    } catch (err) {
      uiAlert(`「${file.name}」上传失败：${err.message}`, "上传失败");
    }
  }
}

/* ---------------------------------------------------------------------------
 * 拖拽上传 —— 不依赖系统文件选择框。
 * 场景：以自动化参数启动的浏览器（如 --disable-blink-features=AutomationControlled）
 * 会静默屏蔽 <input type=file> 的系统选择框，但 drop 事件通道不受影响。
 * ------------------------------------------------------------------------- */
let dragDepth = 0;

function setupDragDrop() {
  // 全页拖放浮层
  const overlay = document.createElement("div");
  overlay.id = "drop-overlay";
  overlay.className = "hidden";
  overlay.innerHTML = `<div class="drop-box">📎 松开鼠标，把文件附加到当前对话</div>`;
  document.body.appendChild(overlay);

  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  const finish = () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.classList.add("hidden"); };

  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    dragDepth += 1;
    overlay.classList.remove("hidden");
  });
  document.addEventListener("dragleave", () => { if (dragDepth) finish(); });
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    e.preventDefault(); // 阻止浏览器直接打开文件
    dragDepth = 0;
    overlay.classList.add("hidden");
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (!state.currentId) { uiAlert("请先选择或新建会话，再附加文件", "提示"); return; }
    uploadLocalFiles(files);
  });

  // 文件选择器弹窗内拖拽高亮
  const modal = $("fs-modal");
  if (modal) {
    modal.addEventListener("dragover", (e) => { e.preventDefault(); modal.classList.add("dragover"); });
    modal.addEventListener("dragleave", () => modal.classList.remove("dragover"));
    modal.addEventListener("drop", () => modal.classList.remove("dragover"));
  }
}

/* ---------------------------------------------------------------------------
 * 知识库（外部 RAG）：服务配置 / 文档入库 / 检索测试
 * 契约见 server/rag.ts —— 本地不存向量，只有「送出去过什么」的登记。
 * ------------------------------------------------------------------------- */
function setKbStatus(text, kind) {
  const el = $("kb-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (kind ? " " + kind : "");
}

function updateKbBadge() {
  const el = $("kb-entry-state");
  if (!el) return;
  const ready = Boolean(state.rag?.configured);
  el.textContent = ready ? "已连接" : "未配置";
  el.className = "kb-entry-state" + (ready ? " ready" : "");
}

async function loadRag() {
  try {
    state.rag = await api("/api/rag");
  } catch {
    state.rag = null; // 旧服务进程没有该接口 → 静默降级
  }
  updateKbBadge();
}

function openKb() {
  $("kb-mask").classList.remove("hidden");
  renderKb();
}

function closeKb() { $("kb-mask").classList.add("hidden"); }

function renderKb() {
  const rag = state.rag || {};
  $("kb-url").value = rag.baseURL || "";
  $("kb-collection").value = rag.collection || "default";
  $("kb-topk").value = rag.topK ?? 5;
  $("kb-key").value = "";
  $("kb-key-state").textContent = rag.hasKey ? `已保存 ${rag.apiKeyMasked}，留空则不修改` : (rag.configured ? "未保存 Key（服务无鉴权可不填）" : "");
  $("kb-key-state").className = "key-state" + (rag.hasKey ? " ok" : "");
  setKbStatus(rag.configured ? "" : "尚未配置外部 RAG 服务", rag.configured ? "" : "err");
  renderKbRoots();
  renderKbDocs();
  $("kb-hits").innerHTML = "";
}

/** 入库位置下拉：与文件选择器同一批授权根（项目根 + 已添加文件夹，带 💻/☁️ 标记） */
async function renderKbRoots() {
  const sel = $("kb-root");
  let roots = [{ path: "", name: "项目根（当前工作台仓库）", type: "local" }];
  try {
    const data = await api("/api/fs/list", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    roots = (data.roots || []).map((r) => ({ ...r, type: r.type || "local" }));
  } catch { /* 用默认项目根 */ }
  sel.innerHTML = "";
  for (const r of roots) {
    const opt = document.createElement("option");
    opt.value = r.path;
    opt.textContent = `${r.type === "cloud" ? "☁️" : "💻"} ${r.name}`;
    sel.appendChild(opt);
  }
}

function renderKbDocs() {
  const wrap = $("kb-docs");
  wrap.innerHTML = "";
  const docs = state.rag?.docs || [];
  if (!docs.length) {
    wrap.innerHTML = `<div class="fs-empty">还没有入库记录 —— 选择位置点「⬇ 全量入库」，或「✎ 粘贴文本」</div>`;
    return;
  }
  for (const d of docs) {
    const row = document.createElement("div");
    row.className = "fs-row kb-doc";
    row.innerHTML = `<span class="f-icon">📄</span><span class="f-name"></span><span class="f-size"></span><button class="pm-x kb-doc-del" title="从登记移除（并尝试删除外部对应文档）">✕</button>`;
    row.querySelector(".f-name").textContent = d.name;
    row.querySelector(".f-size").textContent = `${(d.bytes / 1000).toFixed(1)}k 字 · ${new Date(d.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} · ${d.source || ""}`;
    row.title = d.source || d.name;
    row.querySelector(".kb-doc-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const res = await api(`/api/rag/docs/${d.id}`, { method: "DELETE" });
        state.rag = res.rag;
        renderKbDocs();
      } catch (err) { uiAlert(`移除失败：${err.message}`, "知识库文档"); }
    });
    wrap.appendChild(row);
  }
}

async function saveKbConfig() {
  const baseURL = $("kb-url").value.trim();
  const apiKeyRaw = $("kb-key").value.trim();
  if (!baseURL) { setKbStatus("✗ 服务地址不能为空", "err"); return; }
  const body = {
    baseURL,
    collection: $("kb-collection").value.trim() || "default",
    topK: $("kb-topk").value || undefined,
  };
  if (apiKeyRaw) body.apiKey = apiKeyRaw; // 留空 = 不修改已存 Key
  try {
    const res = await api("/api/rag/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    state.rag = res.rag;
    updateKbBadge();
    renderKbDocs();
    setKbStatus(`✓ 配置已保存（集合 ${state.rag.collection}）`, "ok");
  } catch (err) { setKbStatus(`✗ ${err.message}`, "err"); }
}

async function testKb() {
  const baseURL = $("kb-url").value.trim();
  const apiKeyRaw = $("kb-key").value.trim();
  if (!baseURL) { setKbStatus("✗ 请先填写服务地址", "err"); return; }
  const body = { baseURL };
  if (apiKeyRaw) body.apiKey = apiKeyRaw;
  setKbStatus("正在连接 RAG 服务…", "");
  try {
    const res = await api("/api/rag/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setKbStatus(res.ok ? `✓ 服务可达（HTTP ${res.status}）—— 真实检索效果以入库后测试为准` : `✗ ${res.error}`, res.ok ? "ok" : "err");
  } catch (err) { setKbStatus(`✗ ${err.message}`, "err"); }
}

async function ingestKbFolder() {
  if (!state.rag?.configured) { setKbStatus("✗ 请先保存外部 RAG 服务配置", "err"); return; }
  const path = $("kb-root").value;
  const btn = $("kb-ingest");
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ 扫描入库中…（最长 90s）";
  try {
    const res = await api("/api/rag/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
    state.rag = res.rag;
    renderKbDocs();
    const s = res.summary || {};
    setKbStatus(`✓ 已入库 ${s.ingested ?? "?"} 个文本文件${s.chunks != null ? `，外部服务返回 ${s.chunks} 个切块` : ""}`, "ok");
  } catch (err) {
    setKbStatus(`✗ ${err.message}`, "err");
    uiAlert(`入库失败：${err.message}\n\n检查：① RAG 服务是否实现 /ingest；② 选择的文件夹是否包含文本文件`, "知识库入库");
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

async function pasteKbText() {
  const text = await uiPrompt("粘贴要入库的文本（切块与 embedding 由外部 RAG 服务完成）：", {
    title: "知识库 · 文本入库",
    placeholder: "任意说明文档 / 会议纪要 / 规范片段…",
  });
  if (!text || !text.trim()) return;
  try {
    const res = await api("/api/rag/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `手动文本 ${new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`, content: text }),
    });
    state.rag = res.rag;
    renderKbDocs();
    setKbStatus("✓ 文本已入库", "ok");
  } catch (err) { setKbStatus(`✗ ${err.message}`, "err"); }
}

async function searchKbTest() {
  const q = $("kb-query").value.trim();
  const wrap = $("kb-hits");
  if (!q) { setKbStatus("✗ 请输入检索词", "err"); return; }
  wrap.innerHTML = `<div class="fs-empty">检索中…</div>`;
  try {
    const res = await api("/api/rag/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }) });
    const hits = Array.isArray(res.hits) ? res.hits : [];
    setKbStatus(`✓ 命中 ${hits.length} 条`, "ok");
    wrap.innerHTML = "";
    if (!hits.length) wrap.innerHTML = `<div class="fs-empty">没有命中 —— 确认相关文档已入库</div>`;
    for (const h of hits) wrap.appendChild(renderRagHit(h, false));
  } catch (err) {
    wrap.innerHTML = "";
    setKbStatus(`✗ ${err.message}`, "err");
  }
}

async function clearKb() {
  if (!(await uiConfirm("清空集合会调用外部 RAG 服务的 /reset，并清空本地登记。\n确定继续？", { title: "清空知识库集合", okText: "清空", danger: true }))) return;
  try {
    const res = await api("/api/rag/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    state.rag = res.rag;
    renderKbDocs();
    $("kb-hits").innerHTML = "";
    setKbStatus("✓ 集合已清空", "ok");
  } catch (err) { setKbStatus(`✗ ${err.message}`, "err"); }
}

/* ----- RAG 命中片段渲染（面板检索 + 聊天工具卡片共用） ----- */
function renderRagHit(hit, compact) {
  const el = document.createElement("div");
  el.className = "rag-hit";
  const score = typeof hit.score === "number" ? hit.score.toFixed(3) : String(hit.score ?? "–");
  el.innerHTML = `
    <div class="rag-hit-head">
      <span class="rag-hit-name"></span>
      <span class="rag-hit-src"></span>
      <span class="rag-hit-score">score ${escapeHtml(score)}</span>
    </div>
    <div class="rag-hit-text"></div>`;
  el.querySelector(".rag-hit-name").textContent = hit.name || "未命名片段";
  el.querySelector(".rag-hit-src").textContent = hit.source || "";
  el.querySelector(".rag-hit-text").textContent = hit.text || "（无文本内容）";
  if (compact) el.querySelector(".rag-hit-text").style.maxHeight = "84px";
  return el;
}

/** retrieve_docs 专属结果渲染：从 JSON 结果里解析出「命中来源」卡片列表 */
function renderRagHitsInToolCard(part, card) {
  let wrap = card.querySelector(".rag-hits-wrap");
  if (!part.result || typeof part.result.content !== "string") return;
  let data;
  try { data = JSON.parse(part.result.content); } catch { return; }
  if (!data || typeof data !== "object") return;
  if (wrap) wrap.remove();
  const hits = Array.isArray(data.hits) ? data.hits : [];
  if (!hits.length && !data.error) return;
  wrap = document.createElement("div");
  wrap.className = "rag-hits-wrap";
  const title = document.createElement("div");
  title.className = "rag-hits-title";
  title.textContent = data.error
    ? "📚 检索失败：" + data.error
    : `📚 命中 ${hits.length} 条外部知识库片段（按相关度排序）`;
  wrap.appendChild(title);
  for (const h of hits.slice(0, 6)) wrap.appendChild(renderRagHit(h, true));
  card.querySelector(".tool-body").appendChild(wrap);
}

/* ---------------------------------------------------------------------------
 * 房产 Agent（贝壳）：侧栏入口 / 面板 / 工具卡专属渲染
 * ------------------------------------------------------------------------- */
async function loadEstate() {
  try {
    state.estate = await api("/api/estate");
  } catch {
    state.estate = null; // 旧服务进程没有该接口 → 静默降级
  }
  updateEstateBadge();
}

function updateEstateBadge() {
  const el = $("estate-entry-state");
  if (!el) return;
  const st = state.estate || {};
  el.textContent = st.installed ? `已装 ${st.version || ""}` : "未安装";
  el.className = "kb-entry-state" + (st.installed ? " ready" : "");
}

function openEstate() {
  $("estate-mask").classList.remove("hidden");
  renderEstatePanel();
}

function closeEstate() { $("estate-mask").classList.add("hidden"); }

function setEstateStatus(msg, cls) {
  const el = $("estate-status");
  if (!el) return;
  el.textContent = msg;
  el.className = "estate-status" + (cls ? " " + cls : "");
}

function renderEstatePanel() {
  const st = state.estate || { installed: false };
  if (st.installed) {
    setEstateStatus(`✓ 已安装贝壳 CLI${st.version ? " " + st.version : ""}${st.viaPATH ? "（来自系统 PATH）" : st.path ? "：" + st.path : ""}`, "ok");
  } else {
    setEstateStatus(st.error ? `✗ ${st.error}` : "未检测到贝壳 CLI：点下方按钮自动安装（仅支持 Windows，约 32MB）", "err");
  }
  $("estate-key").value = "";
  const s2 = $("estate-status2");
  s2.textContent = st.installed ? "CLI 就绪后即可保存 Key 开始找房" : "请先安装 CLI";
  s2.style.color = st.installed ? "" : "var(--amber)";
}

async function installBeikeCli() {
  const btn = $("estate-install");
  const s2 = $("estate-status2");
  btn.disabled = true;
  s2.textContent = "正在下载安装（约 30MB，视网络可能需要 1-2 分钟）…";
  s2.style.color = "var(--amber)";
  try {
    const res = await api("/api/estate/install", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    state.estate = { ...state.estate, ...res };
    updateEstateBadge();
    renderEstatePanel();
  } catch (err) {
    setEstateStatus(`✗ 安装失败：${err.message}`, "err");
    s2.textContent = "安装失败，可按官方文档手动安装后重试";
  } finally {
    btn.disabled = false;
  }
}

async function saveEstateKey() {
  const value = $("estate-key").value.trim();
  const s2 = $("estate-status2");
  if (!value) { s2.textContent = "✗ 请先粘贴贝壳 Key（building.ke.com 登录后显示）"; s2.style.color = "var(--red)"; return; }
  if (!state.estate?.installed) {
    s2.textContent = "✗ 请先安装 CLI 再保存 Key"; s2.style.color = "var(--red)"; return;
  }
  s2.textContent = "校验中…";
  try {
    const res = await api("/api/estate/key", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: value }),
    });
    s2.textContent = res.ok ? "✓ 校验通过，贝壳找房已可用（回到找房对话直接提需求）" : `✗ 校验未通过：${res.error || "未知错误"}`;
    s2.style.color = res.ok ? "" : "var(--red)";
    if (res.ok) $("estate-key").value = "";
  } catch (err) {
    s2.textContent = `✗ ${err.message}`;
    s2.style.color = "var(--red)";
  }
}

/* ----- 房产 JSON 结果 → 卡片渲染（房源列表 / 地图 / 户型图 / 二维码 / 安装引导） ----- */

function estateExtra(card) {
  let extra = card.querySelector(".estate-extra");
  if (extra) extra.remove();
  extra = document.createElement("div");
  extra.className = "estate-extra";
  card.querySelector(".tool-body").appendChild(extra);
  return extra;
}

function renderEstateInToolCard(part, card) {
  let data;
  try { data = JSON.parse(part.result?.content || ""); } catch { return; }
  if (!data || typeof data !== "object") return;

  // CLI 未安装 / 未授权 一类引导性错误 → 渲染一键安装卡
  if (data.error && data.setup === "beike-install") {
    const extra = estateExtra(card);
    const box = document.createElement("div");
    box.className = "estate-setup";
    box.innerHTML = `<div><b>🏠 贝壳 CLI 未就绪</b><div class="err-line"></div><a class="key-link" target="_blank" rel="noopener"></a></div>`;
    box.querySelector(".err-line").textContent = data.error;
    const keyA = box.querySelector(".key-link");
    keyA.textContent = "获取贝壳 Key（building.ke.com）";
    keyA.href = data.keyUrl || "https://building.ke.com/?action=get-key&source=beike_skill";
    const fix = document.createElement("button");
    fix.className = "btn btn-approve";
    fix.textContent = "⬇ 一键安装贝壳 CLI";
    if (!/^win/i.test(data.platform || "win")) fix.disabled = true;
    fix.addEventListener("click", async () => {
      fix.disabled = true;
      fix.textContent = "安装中…（约 1-2 分钟）";
      try {
        const res = await api("/api/estate/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        state.estate = { ...state.estate, ...res };
        updateEstateBadge();
        fix.textContent = `✓ 安装完成${res.version ? " " + res.version : ""}，请重新发送刚才的问题`;
      } catch (err) {
        fix.textContent = "安装失败：" + err.message;
      }
    });
    box.appendChild(fix);
    extra.appendChild(box);
    return;
  }

  // 房源搜索 → 列表卡
  const listings = Array.isArray(data.listings) ? data.listings : [];
  if (data.action === "search" || listings.length) {
    const extra = estateExtra(card);
    if (listings.length) {
      const title = document.createElement("div");
      title.className = "estate-extra-title";
      title.textContent = `🏙 ${data.city || ""} ${data.mode === "rent" ? "租房" : "买房"}结果 · ${listings.length} 套`;
      extra.appendChild(title);
      for (const h of listings.slice(0, 8)) {
        const row = document.createElement("div");
        row.className = "estate-house";
        row.innerHTML = `
          <img class="estate-house-thumb" alt="">
          <div class="estate-house-main">
            <div class="estate-house-title"></div>
            <div class="estate-house-meta"><span class="estate-house-price"></span><span class="m-area"></span><span class="m-addr"></span></div>
            <div class="estate-house-links"></div>
          </div>`;
        const img = row.querySelector(".estate-house-thumb");
        const src = safeImageSrc(h.cover || h.coverImage || h.image);
        if (src) img.src = src; else img.remove();
        row.querySelector(".estate-house-title").textContent = h.title || h.community || h.name || h.id || "（无标题）";
        row.querySelector(".estate-house-price").textContent = typeof h.price === "object" ? (h.price.unit || "") : (h.price || "");
        row.querySelector(".m-area").textContent = h.area || h.areaSize || "";
        row.querySelector(".m-addr").textContent = h.addressText || h.address || h.region || "";
        const links = row.querySelector(".estate-house-links");
        let linkAdded = false;
        for (const [label, v] of Object.entries(h.links || { detail: h.url || h.detailUrl })) {
          const href = safeHref(String(v));
          if (!href) continue;
          const a = document.createElement("a");
          a.className = "estate-link";
          a.textContent = label === "detail" ? "贝壳页面" : label;
          a.href = href; a.target = "_blank"; a.rel = "noopener";
          links.appendChild(a); linkAdded = true;
        }
        if (!linkAdded) links.remove();
        extra.appendChild(row);
      }
    } else if (data.error) {
      const miss = document.createElement("div");
      miss.className = "estate-missed";
      miss.textContent = "🔍 " + data.error;
      extra.appendChild(miss);
    }
    return;
  }

  // 区位对比 → 内嵌 OSM 地图 + 各平台跳转链接
  if (data.action === "map") {
    const extra = estateExtra(card);
    const points = Array.isArray(data.points) ? data.points : [];
    const embed = String(data.embedUrl || "");
    if (points.length && /^https:\/\/www\.openstreetmap\.org\//i.test(embed)) {
      const mapBox = document.createElement("div");
      mapBox.className = "estate-map-embed";
      const iframe = document.createElement("iframe");
      iframe.src = embed;
      iframe.loading = "lazy";
      iframe.title = "候选房源分布地图";
      mapBox.appendChild(iframe);
      extra.appendChild(mapBox);
    }
    for (const p of points) {
      const row = document.createElement("div");
      row.className = "estate-point";
      row.innerHTML = `<div class="estate-point-main"><div class="estate-point-name"></div><div class="estate-point-addr"></div></div><div class="estate-point-links"></div>`;
      row.querySelector(".estate-point-name").textContent = p.name || "未知点位";
      row.querySelector(".estate-point-addr").textContent = p.address || "";
      const links = row.querySelector(".estate-point-links");
      for (const [label, v] of Object.entries(p.links || {})) {
        const href = safeHref(String(v));
        if (!href) continue;
        const a = document.createElement("a");
        a.className = "estate-link";
        a.textContent = label;
        a.href = href; a.target = "_blank"; a.rel = "noopener";
        links.appendChild(a);
      }
      extra.appendChild(row);
    }
    if (data.note) {
      const note = document.createElement("div");
      note.className = "estate-missed";
      note.textContent = data.note;
      extra.appendChild(note);
    }
    return;
  }

  // 户型图 → 图片网格
  if (data.action === "material") {
    const images = Array.isArray(data.images) ? data.images : [];
    const extra = estateExtra(card);
    if (images.length) {
      const grid = document.createElement("div");
      grid.className = "estate-material-grid";
      for (const src of images) {
        const s = safeImageSrc(src);
        if (!s) continue;
        const img = document.createElement("img");
        img.src = s; img.alt = "户型图"; img.loading = "lazy";
        grid.appendChild(img);
      }
      extra.appendChild(grid);
    }
    const href = safeHref(data.vr || data.detailUrl || data.url);
    if (href) {
      const a = document.createElement("a");
      a.className = "estate-material-link";
      a.textContent = "▶ 打开贝壳 VR / 详情页";
      a.href = href; a.target = "_blank"; a.rel = "noopener";
      extra.appendChild(a);
    }
    if (!extra.childElementCount) extra.remove();
    return;
  }

  // 经纪人加微 → 二维码
  if (data.action === "qrcode") {
    const extra = estateExtra(card);
    const src = safeImageSrc(data.qrcode || data.image);
    if (src) {
      const img = document.createElement("img");
      img.src = src; img.alt = "经纪人微信二维码";
      img.style.cssText = "width:180px;border-radius:8px;border:1px solid var(--line)";
      extra.appendChild(img);
    }
    if (data.note) {
      const note = document.createElement("div");
      note.className = "estate-material-link";
      note.textContent = data.note;
      extra.appendChild(note);
    }
    if (!extra.childElementCount) extra.remove();
    return;
  }
}

/* ---------------------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------------------- */
async function init() {
  loadLocal();
  // Electron 桌面端标记：样式层据此开启「顶栏拖拽 + 右上角给原生控制键让位」
  if (window.desktop?.isElectron) document.body.classList.add("in-desktop");

  // 配置
  try {
    state.config = await api("/api/config");
  } catch (err) {
    uiAlert("无法连接服务：" + err.message, "连接失败");
    return;
  }
  applyConfigState(state.config);
  const footNote = $("side-foot-note");
  if (footNote)   footNote.textContent = `点击模型名可修改配置 · ${APP_VERSION.replace(/^web-\d{4}-/, "v")}`;
  await loadProjects();
  await loadExternalAgents();
  await loadRag();
  await loadEstate();

  // 能力自检：前端具备但服务端缺失的接口 → 说明服务进程是旧代码启动的，提示重启。
  // （静态文件每次请求都读磁盘，浏览器能拿到新脚本；但路由是进程启动时固化的）
  try {
    const probe = await fetch("/api/fs/list", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(getAuthToken() ? { Authorization: "Bearer " + getAuthToken() } : {}) },
      body: "{}",
    });
    if (probe.status === 404) {
      showFatalBanner(
        "服务端版本过旧：缺少文件接口（/api/fs/list 返回 404）。\n" +
        "请完全停止当前的 npm run web 进程后重新运行，再刷新本页面。"
      );
    }
  } catch { /* 网络问题另有报错 */ }

  // 会话列表：服务端（内存态）+ 本地元数据（标题覆盖 / 重启后残留标记失效）
  let serverSessions = [];
  try { serverSessions = await api("/api/sessions"); } catch { /* 服务刚重启等 */ }
  const localMetas = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]");
  const localById = new Map(localMetas.map((m) => [m.id, m]));
  state.sessions = serverSessions.map((s) => ({
    ...s,
    stale: false,
    title: localById.get(s.id)?.title || s.title,
  }));
  // 本地有、服务端没有 → 说明服务重启过，标记为「仅可查看历史」
  const serverIds = new Set(serverSessions.map((s) => s.id));
  const stale = localMetas
    .filter((m) => !serverIds.has(m.id))
    .map((m) => ({
      id: m.id, stale: true, title: m.title || "历史会话",
      kind: m.kind || (m.demo ? "demo" : "agent"), demo: m.demo || null,
      createdAt: m.createdAt || 0, pendingApproval: false,
    }));
  state.sessions.push(...stale);

  buildDemoCards($("demo-cards"));
  buildDemoCards($("modal-cards"));
  buildExampleChips();
  renderPermChip(); // 初始态无选中会话 → 权限 chip 隐藏（选中 agent/estate 会话后再出现）

  // 事件绑定（on()：元素缺失时告警但不中断，避免单个弹窗缺失拖垮全部交互）
  const on = (id, event, fn) => {
    const el = $(id);
    if (el) el.addEventListener(event, fn);
    else console.warn("[init] 未找到元素 #" + id + "，已跳过绑定");
  };

  on("new-chat-btn", "click", () => { setSidebarOpen(false); openModal(); });
  on("add-external-btn", "click", addExternalFlow);
  on("modal-close", "click", closeModal);
  on("modal-mask", "click", (e) => { if (e.target === $("modal-mask")) closeModal(); });

  // 主题：顶栏 ☀️/🌙 切换 + 持久化
  updateThemeBtn();
  on("theme-btn", "click", toggleTheme);

  // 窄屏抽屉侧栏：☰ 开关 / 遮罩关闭 / Esc 关闭
  on("sidebar-toggle", "click", () => setSidebarOpen(!$("sidebar").classList.contains("open")));
  on("sidebar-scrim", "click", () => setSidebarOpen(false));

  // 输入框上方：模型 / 思考等级 / 会话权限快捷切换
  on("cm-model", "click", (e) => { e.stopPropagation(); toggleCmMenu("cm-model", "cm-model-menu", renderModelMenu); });
  on("cm-thinking", "click", (e) => { e.stopPropagation(); toggleCmMenu("cm-thinking", "cm-thinking-menu", renderThinkingMenu); });
  on("cm-perm", "click", (e) => { e.stopPropagation(); toggleCmMenu("cm-perm", "cm-perm-menu", renderPermMenu); });

  // 供应商 / 模型：设置弹窗 + 顶栏切换器
  const closeSettings = () => { $("settings-mask").classList.add("hidden"); closeProviderForm(); };
  on("settings-btn", "click", openSettings);
  on("side-model", "click", openSettings);

  // 跨会话长期记忆弹窗
  const closeMemories = () => { $("memories-mask").classList.add("hidden"); };
  on("memories-btn", "click", openMemories);
  on("mem-add-btn", "click", saveMemoryFromForm);
  on("memories-mask", "click", (e) => { if (e.target === $("memories-mask")) closeMemories(); });
  on("provider-btn", "click", (e) => {
    e.stopPropagation();
    const menu = $("provider-menu");
    api("/api/config").then(applyConfigState).catch(() => {});
    showProviderMenu(menu.classList.contains("hidden"));
  });
  document.addEventListener("click", (e) => {
    const sw = document.querySelector(".provider-switch");
    if (!sw || !sw.contains(e.target)) showProviderMenu(false);
    const pw = document.querySelector(".project-switch");
    if (!pw || !pw.contains(e.target)) showProjectMenu(false);
    // composer 弹出菜单：点击组外关闭（组内交给各自的 item 处理器）
    if (!e.target.closest(".cm-group")) closeCmMenus();
    if (!e.target.closest("#composer-menu") && e.target !== inputEl) closeComposerMenu();
  });

  // 项目文件夹：切换 / 添加（本地 / 云端）
  on("project-btn", "click", async (e) => {
    e.stopPropagation();
    const menu = $("project-menu");
    await loadProjects();
    showProjectMenu(menu.classList.contains("hidden"));
  });
  on("settings-mask", "click", (e) => { if (e.target === $("settings-mask")) closeSettings(); });
  on("add-provider-btn", "click", () => openProviderForm(null));
  on("pf-cancel-edit", "click", closeProviderForm);
  on("pf-key-toggle", "click", () => {
    const keyInput = $("pf-api-key");
    keyInput.type = keyInput.type === "password" ? "text" : "password";
  });
  // 测试连接 / 获取列表 → 渲染成「点一下即添加」的网关模型清单
  on("pf-fetch-models", "click", fetchGatewayModelChips);
  on("pf-test", "click", fetchGatewayModelChips);
  on("pf-save", "click", saveProvider);
  // 模型：手动添加（输入框回车 / ＋ 按钮）
  on("pf-model-add-btn", "click", () => addModelByName($("pf-model-new").value, null));
  if ($("pf-model-new")) {
    $("pf-model-new").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addModelByName($("pf-model-new").value, null); }
    });
  }
  // 模型编辑面板：思考等级（方言 / 档位）与保存、删除、设为启用
  on("mf-save", "click", saveModel);
  on("mf-activate", "click", () => {
    const p = currentEditingProvider();
    const m = currentEditingModel();
    if (p && m) activateModel(p.id, m.id);
  });
  on("mf-delete", "click", () => {
    const p = currentEditingProvider();
    const m = currentEditingModel();
    if (p && m) removeModel(p.id, m.id, m.name);
  });
  on("mf-dialect", "change", () => renderLevelSelect($("mf-dialect").value, "default", ""));
  on("mf-level", "change", () => renderLevelSelect($("mf-dialect").value, $("mf-level").value, $("mf-custom").value));

  // 文件上下文：📎 附件 / 文件选择器 / 远程文件夹 / 本地上传
  on("attach-btn", "click", openFsModal);
  on("fs-done", "click", closeFsModal);
  on("fs-mask", "click", (e) => { if (e.target === $("fs-mask")) closeFsModal(); });
  on("fs-up", "click", () => { if (fsParent) browseFs(fsParent); });
  on("fs-root", "change", (e) => browseFs(e.target.value));
  on("fs-remote", "click", openRemoteFolder);
  on("fs-upload-btn", "click", () => {
    // 显式触发文件输入：比 label 转发更可靠（所有浏览器在用户手势里都会弹系统选择框）
    $("fs-upload-input").click();
  });
  on("fs-upload-help", "click", () => {
    uiAlert(
      "「上传本地文件」依赖浏览器的系统文件选择框。如果点击后没有任何反应：\n\n" +
      "1. 把文件从资源管理器直接拖拽到本窗口 —— 推荐走这条通道（拖拽不依赖系统选择框）\n" +
      "2. 截图/复制的文件可直接 Ctrl+V 粘贴到输入框附加\n" +
      "3. 本机环境因素也会拦截选择框：企业策略浏览器、安全软件外壳扩展、" +
      "自动化参数启动（页面顶部黄条有 --disable-blink-features 提示即属于此）\n" +
      "4. 可在其他网站（如网页邮箱的添加附件）测试选择框是否同样失效，以确定是本机环境问题",
      "上传没反应？"
    );
  });
  on("fs-upload-input", "change", (e) => {
    if (e.target.files?.length) uploadLocalFiles([...e.target.files]);
    e.target.value = "";
  });
  setupDragDrop();

  // 知识库（外部 RAG）：配置 / 测试 / 入库 / 检索 / 清空
  on("kb-btn", "click", () => { setSidebarOpen(false); openKb(); });
  on("kb-close", "click", closeKb);
  on("kb-mask", "click", (e) => { if (e.target === $("kb-mask")) closeKb(); });
  on("kb-save", "click", saveKbConfig);
  on("kb-test", "click", testKb);
  on("kb-key-toggle", "click", () => {
    const keyInput = $("kb-key");
    keyInput.type = keyInput.type === "password" ? "text" : "password";
  });
  on("kb-ingest", "click", ingestKbFolder);
  on("kb-paste", "click", pasteKbText);
  on("kb-search-btn", "click", searchKbTest);
  on("kb-query", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); searchKbTest(); } });
  on("kb-clear", "click", clearKb);

  // 房产数据源（贝壳 CLI）：面板开关 / 检测 / 安装 / 保存 Key
  on("estate-btn", "click", () => { setSidebarOpen(false); openEstate(); });
  on("estate-close", "click", closeEstate);
  on("estate-mask", "click", (e) => { if (e.target === $("estate-mask")) closeEstate(); });
  on("estate-check", "click", async () => {
    setEstateStatus("探测中…");
    try { state.estate = await api("/api/estate"); }
    catch (err) { state.estate = { installed: false, error: err.message }; }
    updateEstateBadge();
    renderEstatePanel();
  });
  on("estate-install", "click", installBeikeCli);
  on("estate-key-save", "click", saveEstateKey);
  on("estate-key-toggle", "click", () => {
    const keyInput = $("estate-key");
    keyInput.type = keyInput.type === "password" ? "text" : "password";
  });

  on("send-btn", "click", send);
  on("stop-btn", "click", stopStreaming);
  inputEl.addEventListener("input", () => {
    autoGrow();
    refreshComposerMenu();
  });
  inputEl.addEventListener("keydown", (e) => {
    if (handleComposerKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener("click", refreshComposerMenu);
  inputEl.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) refreshComposerMenu();
  });
  // 粘贴上传：剪贴板里是文件（如截图、复制的文件）时直接作为附件，纯文本走默认输入
  inputEl.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    if (!state.currentId) { uiAlert("请先选择或新建会话，再附加文件", "提示"); return; }
    uploadLocalFiles(files);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      cancelActiveDialog(); // 兜底：焦点不在弹窗内时也能 Esc 关闭（未打开时是 no-op）
      closeComposerMenu();
      closeModal();
      closeSettings();
      closeMemories();
      closeFsModal();
      closeKb();
      closeEstate();
      showProviderMenu(false);
      setSidebarOpen(false);
      closeCmMenus();
    }
    if (e.key === "Enter" && ["pf-name", "pf-base-url", "pf-api-key"].includes(e.target.id)) {
      e.preventDefault();
      saveProvider();
    }
    if (e.key === "Enter" && ["mem-key", "mem-content"].includes(e.target.id)) {
      e.preventDefault();
      saveMemoryFromForm();
    }
    if (e.key === "Enter" && ["kb-url", "kb-collection", "kb-topk"].includes(e.target.id)) {
      e.preventDefault();
      saveKbConfig();
    }
    if (e.key === "Enter" && ["mf-name", "mf-label"].includes(e.target.id)) {
      e.preventDefault();
      saveModel();
    }
  });

  renderSessions();
  if (state.sessions.length) selectSession(state.sessions[0].id);
  else showWelcomeState();
}

// 入口兜底：init 抛错时在页面上直接可见（否则所有按钮都静默失效）
init().catch((err) => {
  console.error("[init] 初始化失败：", err);
  showFatalBanner("初始化失败：" + (err && err.stack ? err.stack : err));
});
