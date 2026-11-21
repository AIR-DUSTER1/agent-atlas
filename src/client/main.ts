/**
 * ============================================================
 * main.ts — 前端入口：初始化与事件绑定
 * ============================================================
 * 职责：拉配置与会话列表、构建静态卡片、绑定全部 DOM 事件、首屏渲染。
 * 设计立场：
 *  - 这里是唯一「把各模块接到 DOM 上」的地方；业务逻辑一律在各自模块里，
 *    新增按钮只在这里加一行绑定，不在模块内部偷偷 addEventListener；
 *  - on() 在元素缺失时告警但不中断 —— 单个弹窗骨架缺失不该拖垮整页交互；
 *  - init 抛错会在页面上挂红色横幅（showFatalBanner），避免「按钮全静默失效」。
 */

import { $, chatScroll, inputEl, sendBtn, setSidebarOpen, stopBtn, toggleTheme, updateThemeBtn, desktopBridge } from "./core/dom.js";
import { api, authFetch } from "./core/api.js";
import { LS_SESSIONS, loadLocal, saveLocal, state } from "./core/state.js";
import { formatBuildLabel, logBuildInfo } from "./core/build-info.js";
import { cancelActiveDialog, showFatalBanner, uiAlert, uiConfirm, uiPrompt } from "./ui/dialog.js";
import { renderAll } from "./render/messages.js";
import { registerToolEnhancer } from "./render/tool-enhancers.js";
import { installClientErrorReporting } from "./observability/client-errors.js";
import { icon, initIconHydration } from "./ui/icon.js";
import { enhanceConfigFields, installConfigFieldHydration } from "./ui/config-control.js";
import { bindScrollToBottom } from "./ui/scroll-to-bottom.js";
import { handleComposerKeydown, refreshComposerMenu, closeComposerMenu, bindCompactAction } from "./composer/menu.js";
import { exitGoalMode, handleGoalKeydown, syncGoalDraftFromInput } from "./composer/goal.js";
import { applyConfigState, renderModelMenu, renderThinkingMenu, toggleCmMenu, updateContextBar } from "./views/composer-bar.js";
import { loadProjects, renderProjectSwitcher, showProjectMenu, addProjectFolder, bindProjectsChanged } from "./views/projects.js";
import { renderSessions, loadSessionList } from "./views/sessions.js";
import {
  closeCmMenus, hydrateFromServer, renderPermChip, renderPermMenu, selectSession, showChatState, showWelcomeState,
} from "./views/navigation.js";
import { buildDemoCards, buildExampleChips, closeModal, openModal } from "./views/shell.js";
import { bindCreateSession as bindShellCreate } from "./views/shell.js";
import { addExternalFlow, bindCreateSession as bindExtCreate, loadExternalAgents } from "./views/external.js";
import {
  closeFsModal, openFsModal, openRemoteFolder, renderAttachChips, setupDragDrop, uploadLocalFiles,
} from "./views/attachments.js";
import { loadRag, openKb, closeKb, renderRagHitsInToolCard } from "./views/rag.js";
import { closeEstate, openEstate, loadEstate, renderEstateInToolCard } from "./views/estate.js";

import { bindSettingsNavigation, closeSettingsPage, openSettings } from "./views/settings.js";
import { bindTracingSettings } from "./views/settings-tracing.js";
import { loadPluginState } from "./views/settings-plugins.js";
import { isSubagentEditorOpen } from "./views/settings-subagents.js";
import { createBackup, refreshBackups } from "./views/settings-backup.js";
import { refreshStats } from "./views/stats/index.js";
import { bindBrowserDock, renderBrowserInToolCard } from "./views/browser-use.js";
import { closeMcpEditor, isMcpEditorOpen } from "./views/settings-mcp.js";
import { loadUserCommands } from "./composer/menu.js";
import { createSession, finalize, send, stopStreaming, closeModalImpl, openModalImpl } from "./stream/turn.js";
import { compactContext } from "./actions/compact.js";
import type { AppConfig, Session } from "./modules/types.js";

/** 密码框显示/隐藏：同时更新图标与 aria-label，避免无文字按钮状态不可读。 */
function toggleSecretInput(buttonId: string, inputId: string): void {
  const input = $(inputId) as HTMLInputElement | null;
  const button = $(buttonId);
  if (!input || !button) return;
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  button.replaceChildren(icon(reveal ? "EyeOff" : "Eye", { size: 15 }));
  button.setAttribute("aria-label", reveal ? "隐藏密钥" : "显示密钥");
}

/** 无项目时用主区 Agent 选择页代替新建弹窗，避免先落到无上下文的空会话。 */
function openNewSessionChooser(): void {
  setSidebarOpen(false);
  if (state.projects.length === 0) {
    state.currentId = null;
    renderSessions();
    showWelcomeState("agent-picker");
    chatScroll.scrollTop = 0;
    return;
  }
  openModal();
}
/* ---------------------------------------------------------------------------
 * 接线：视图层互相需要的回调统一在这里注入
 * ------------------------------------------------------------------------- */
registerToolEnhancer((part) => part.name === "retrieve_docs", renderRagHitsInToolCard);
registerToolEnhancer((part) => Boolean(part.name?.startsWith("house_")), renderEstateInToolCard);
registerToolEnhancer((part) => Boolean(part.name?.startsWith("browser_")), renderBrowserInToolCard);
bindProjectsChanged(() => renderSessions());
bindShellCreate(createSession);
bindExtCreate(createSession);
bindCompactAction(async () => {
  await compactContext();
});

/* ---------------------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------------------- */
async function init(): Promise<void> {
  document.documentElement.dataset.appReady = "loading";
  enhanceConfigFields();
  // M4 4.2 起 Vue 面板挂载在启动注水之后：动态补齐公共配置控件标记
  installConfigFieldHydration();
  loadLocal();
  initIconHydration();
  // M4 4.6：执行流程面板 + 附件 chips 启动即挂载（由 store 驱动显示）
  void import("./apps/workflow-plan-vue.js").then((m) => m.mountWorkflowPlanVue()).catch(() => {});
  void import("./apps/attach-chips-vue.js").then((m) => m.mountAttachChipsVue()).catch(() => {});
  void import("./apps/context-meter-vue.js").then((m) => m.mountContextMeterVue()).catch(() => {});
  bindScrollToBottom();
  // Electron 桌面端标记：样式层据此开启「顶栏拖拽 + 右上角给原生控制键让位」
  if (desktopBridge()?.isElectron) document.body.classList.add("in-desktop");

  // 配置
  try {
    state.config = await api<AppConfig>("/api/config");
  } catch (err) {
    uiAlert("无法连接服务：" + (err as Error).message, "连接失败");
    return;
  }
  applyConfigState(state.config);
  const footNote = $("side-foot-note");
  if (footNote) footNote.textContent = `点击模型名可修改配置 · ${formatBuildLabel()}`;
  await loadProjects();
  await loadExternalAgents();
  await loadRag();
  await loadEstate();
  await loadPluginState();
  // 用户自定义命令：预热带进斜杠菜单（失败静默，命令不可用不影响对话）
  await loadUserCommands().catch(() => {});

  // 能力自检：前端具备但服务端缺失的接口 → 说明服务进程是旧代码启动的，提示重启。
  // （静态文件每次请求都读磁盘，浏览器能拿到新脚本；但路由是进程启动时固化的）
  try {
    const probe = await authFetch("/api/fs/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  let serverSessions: Session[] = [];
  try { serverSessions = await api<Session[]>("/api/sessions"); } catch { /* 服务刚重启等 */ }
  const localMetas = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Array<Partial<Session>>;
  const localById = new Map(localMetas.map((m) => [m.id as string, m]));
  state.sessions = serverSessions.map((s) => ({
    ...s,
    stale: false,
    title: localById.get(s.id)?.title || s.title,
  }));
  // 本地有、服务端没有 → 说明服务重启过，标记为「仅可查看历史」
  const serverIds = new Set(serverSessions.map((s) => s.id));
  const stale = localMetas
    .filter((m) => m.id && !serverIds.has(m.id))
    .map((m) => ({
      id: m.id as string, stale: true, title: m.title || "历史会话",
      kind: (m.kind || (m.demo ? "demo" : "agent")) as Session["kind"],
      demo: m.demo || null, projectId: m.projectId || "default",
      createdAt: m.createdAt || 0, pendingApproval: false,
    }));
  state.sessions.push(...stale);

  buildDemoCards($("demo-cards"));
  buildDemoCards($("modal-cards"));
  buildExampleChips();
  renderPermChip(); // 初始态无选中会话 → 权限 chip 隐藏（选中 agent/estate 会话后再出现）

  // 事件绑定（on()：元素缺失时告警但不中断，避免单个弹窗缺失拖垮全部交互）
  const on = (id: string, event: string, fn: (e: Event) => void): void => {
    const el = $(id);
    if (el) el.addEventListener(event, fn);
    else console.warn("[init] 未找到元素 #" + id + "，已跳过绑定");
  };

  on("new-chat-btn", "click", openNewSessionChooser);
  on("add-external-btn", "click", () => { void addExternalFlow(); });
  on("modal-close", "click", closeModal);
  on("modal-mask", "click", (e) => { if (e.target === $("modal-mask")) closeModal(); });

  // 主题：顶栏 ☀️/🌙 切换 + 持久化
  updateThemeBtn();
  on("theme-btn", "click", toggleTheme);
  // 空会话快捷起步：只填充输入框，不替用户自动发送
  document.querySelectorAll<HTMLButtonElement>("[data-empty-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      inputEl.value = button.dataset.emptyPrompt ?? "";
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.focus();
    });
  });

  // 窄屏抽屉侧栏：☰ 开关 / 遮罩关闭 / Esc 关闭
  on("sidebar-toggle", "click", () => setSidebarOpen(!$("sidebar")?.classList.contains("open")));
  on("sidebar-scrim", "click", () => setSidebarOpen(false));

  // 输入框上方：模型 / 思考等级 / 会话权限快捷切换
  on("cm-model", "click", (e) => {
    e.stopPropagation();
    toggleCmMenu("cm-model", "cm-model-menu", renderModelMenu);
  });
  on("cm-thinking", "click", (e) => {
    e.stopPropagation();
    toggleCmMenu("cm-thinking", "cm-thinking-menu", renderThinkingMenu);
  });
  on("cm-perm", "click", (e) => {
    e.stopPropagation();
    toggleCmMenu("cm-perm", "cm-perm-menu", renderPermMenu);
  });

  // 独立设置页：左下入口 / 返回 / 分区导航
  on("settings-btn", "click", () => openSettings("models"));
  on("side-model", "click", () => openSettings("models"));
  on("settings-back-btn", "click", closeSettingsPage);
  bindSettingsNavigation();
  bindTracingSettings();
  // M4 4.1/4.2：命令页 / 子代理 / MCP 面板事件由 Vue 组件接管（挂载发生在进入分区时）
  on("stats-refresh", "click", refreshStats);
  // M4 4.2：技能面板事件全部由 Vue 组件接管（挂载发生在进入 skills 分区时）


  // 侧栏：会话搜索（本地实时过滤）+ 批量清理旧会话
  $("session-search")?.addEventListener("input", () => renderSessions());
  on("cleanup-btn", "click", async () => {
    const daysRaw = await uiPrompt("清理创建时间超过多少天的会话？（默认 30）", {
      title: "批量清理旧会话",
      placeholder: "30",
    });
    if (daysRaw === null) return;
    const days = Number(String(daysRaw).trim() || "30");
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      uiAlert("请输入 1-365 之间的整数天数", "批量清理旧会话");
      return;
    }
    const ok = await uiConfirm(
      `确定删除所有创建超过 ${days} 天的会话吗？\n（journal 与检查点会同步清理，删除后不可恢复）`,
      { title: "批量清理旧会话", okText: "删除" }
    );
    if (!ok) return;
    try {
      const res = await api<{ removed: number }>("/api/sessions/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daysBefore: days }),
      });
      uiAlert(`已清理 ${res.removed} 个超过 ${days} 天的会话`, "批量清理完成");
      await loadSessionList();
    } catch (err) {
      uiAlert(`清理失败：${(err as Error).message}`, "批量清理旧会话");
    }
  });
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const pw = document.querySelector(".project-switch");
    if (!pw || !pw.contains(target)) showProjectMenu(false);
    // composer 弹出菜单：点击组外关闭（组内交给各自的 item 处理器）
    if (!target.closest(".cm-group")) closeCmMenus();
    if (!target.closest("#composer-menu") && target !== inputEl) closeComposerMenu();
  });

  // 项目文件夹：切换 / 添加（本地 / 云端）
  on("project-btn", "click", async (e) => {
    e.stopPropagation();
    const menu = $("project-menu");
    await loadProjects();
    showProjectMenu(menu?.classList.contains("hidden") ?? false);
  });
  on("backup-create-btn", "click", () => { void createBackup(); });
  // M4 4.3：供应商/模型面板与弹窗事件全部由 Vue 组件接管（stores/models 驱动）
  // 供应商连接弹窗启动即挂载（默认隐藏，开关由 store.providerFormOpen 驱动）
  void import("./apps/provider-form-vue.js").then((m) => m.mountProviderFormVue()).catch(() => {});

  // 文件上下文：📎 附件 / 文件选择器 / 远程文件夹 / 本地上传
  on("attach-btn", "click", () => { void openFsModal(); });
  on("fs-done", "click", closeFsModal);
  on("fs-mask", "click", (e) => { if (e.target === $("fs-mask")) closeFsModal(); });
  on("fs-up", "click", () => { void import("./views/attachments.js").then((m) => m.goParent()); });
  on("fs-root", "change", (e) => {
    void import("./views/attachments.js").then((m) => m.browseFs((e.target as HTMLSelectElement).value));
  });
  on("fs-remote", "click", () => { void openRemoteFolder(); });
  on("fs-upload-btn", "click", () => {
    // 显式触发文件输入：比 label 转发更可靠（所有浏览器在用户手势里都会弹系统选择框）
    ($("fs-upload-input") as HTMLInputElement | null)?.click();
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
    const input = e.target as HTMLInputElement;
    if (input.files?.length) void uploadLocalFiles(input.files);
    input.value = "";
  });
  setupDragDrop();

  // 知识库（外部 RAG）：配置 / 测试 / 入库 / 检索 / 清空
  // M4 4.4：知识库弹窗事件全部由 Vue 组件接管（stores/rag 驱动）

  // M4 4.4：贝壳弹窗事件全部由 Vue 组件接管（stores/estate 驱动）
  // 弹窗遮罩点击空白关闭（mount 容器在组件模板之外，原生挂监听）
  void import("./apps/estate-panel-vue.js").then((m) => {
    m.mountEstatePanelVue();
    const mask = $("estate-mask");
    mask?.addEventListener("click", (e) => { if (e.target === mask) void closeEstate(); });
  }).catch(() => {});

  bindBrowserDock();

  // 求职数据源（内置采集）：面板开关 / 数据目录 / 登录 / 自检
  // M4 4.4：求职弹窗启动即挂载（默认隐藏，开关由 store.jobOpen 驱动）
  void import("./apps/job-panel-vue.js").then((m) => m.mountJobPanelVue()).catch(() => {});

  on("send-btn", "click", () => { void send(); });
  on("stop-btn", "click", stopStreaming);
  // Goal 徽标：点击退出连续任务模式
  on("goal-chip", "click", () => exitGoalMode());
  inputEl.addEventListener("input", () => {
    syncGoalDraftFromInput();
    import("./core/dom.js").then((m) => m.autoGrowImpl());
    refreshComposerMenu();
  });
  inputEl.addEventListener("keydown", (e) => {
    if (handleGoalKeydown(e)) return;
    if (handleComposerKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  inputEl.addEventListener("click", refreshComposerMenu);
  inputEl.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) refreshComposerMenu();
  });
  // 粘贴上传：剪贴板里是文件（如截图、复制的文件）时直接作为附件，纯文本走默认输入
  inputEl.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    if (!state.currentId) { uiAlert("请先选择或新建会话，再附加文件", "提示"); return; }
    void uploadLocalFiles(files);
  });
  document.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (e.key === "Escape") {
      if (isSubagentEditorOpen()) {
        e.preventDefault();
        return;
      }
      // 供应商弹窗是第一层：只关它，不要把背后的设置页一起关掉。
      if (isProviderFormOpen()) {
        e.preventDefault();
        void import("./views/model-form.js").then((m) => m.closeProviderForm());
        return;
      }
      if (isMcpEditorOpen()) {
        e.preventDefault();
        closeMcpEditor();
        return;
      }
      cancelActiveDialog(); // 兜底：焦点不在弹窗内时也能 Esc 关闭（未打开时是 no-op）
      closeComposerMenu();
      closeModal();
      closeSettingsPage();
      closeFsModal();
      closeKb();
      closeEstate();
      setSidebarOpen(false);
      closeCmMenus();
    }
  });

  state.currentId = null;
  renderSessions();
  const first = state.sessions[0];
  if (state.projects.length === 0) showWelcomeState("agent-picker");
  else if (first) selectSession(first.id);
  else showWelcomeState();
  document.documentElement.dataset.appReady = "true";


}

/** 供应商连接弹窗是否打开（Esc 分层关闭用） */
function isProviderFormOpen(): boolean {
  const mask = $("provider-modal-mask");
  return Boolean(mask) && !mask?.classList.contains("hidden");
}

// 入口兜底：init 抛错时在页面上直接可见（否则所有按钮都静默失效）
logBuildInfo();
installClientErrorReporting();
init().catch((err) => {
  document.documentElement.dataset.appReady = "error";
  console.error("[init] 初始化失败：", err);
  showFatalBanner("初始化失败：" + (err && (err as Error).stack ? (err as Error).stack : String(err)));
});
