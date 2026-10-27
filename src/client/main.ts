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
import { api } from "./core/api.js";
import { APP_VERSION, LS_SESSIONS, loadLocal, saveLocal, state } from "./core/state.js";
import { cancelActiveDialog, showFatalBanner, uiAlert, uiConfirm, uiPrompt } from "./ui/dialog.js";
import { renderAll } from "./render/messages.js";
import { registerToolEnhancer } from "./render/tool-enhancers.js";
import { icon, initIconHydration } from "./ui/icon.js";
import { bindScrollToBottom } from "./ui/scroll-to-bottom.js";
import { handleComposerKeydown, refreshComposerMenu, closeComposerMenu, bindCompactAction } from "./composer/menu.js";
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
import { loadRag, openKb, closeKb, saveKbConfig, testKb, ingestKbFolder, pasteKbText, searchKbTest, clearKb, renderRagHitsInToolCard } from "./views/rag.js";
import { closeEstate, installBeikeCli, openEstate, saveEstateKey, loadEstate, renderEstateInToolCard } from "./views/estate.js";
import { closeProviderForm, openProviderForm, saveModel } from "./views/model-form.js";
import {
  activateModel, fetchGatewayModelChips, removeProvider, saveProvider,
} from "./views/model-actions.js";
import { currentlySelectedProvider, renderProviderList } from "./views/model-panel.js";
import { renderProviderMenu, showProviderMenu } from "./views/model-menu.js";
import { setSettingsFocus } from "./views/model-store.js";
import { closeSettingsPage, openSettings, showSettingsView } from "./views/settings.js";
import { refreshBackups } from "./views/settings-backup.js";
import { refreshStats } from "./views/settings-stats.js";
import { saveMemoryFromForm } from "./views/settings-memories.js";
import { saveCommandFromForm, refreshCommands } from "./views/settings-commands.js";
import { saveSkillFromForm } from "./views/settings-skills.js";
import { saveMcpFromForm } from "./views/settings-mcp.js";
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
/* ---------------------------------------------------------------------------
 * 接线：视图层互相需要的回调统一在这里注入
 * ------------------------------------------------------------------------- */
registerToolEnhancer((part) => part.name === "retrieve_docs", renderRagHitsInToolCard);
registerToolEnhancer((part) => Boolean(part.name?.startsWith("house_")), renderEstateInToolCard);
bindProjectsChanged(() => renderSessions());
bindShellCreate(createSession);
bindExtCreate(createSession);
bindCompactAction(compactContext);

/* ---------------------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------------------- */
async function init(): Promise<void> {
  loadLocal();
  initIconHydration();
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
  if (footNote) footNote.textContent = `点击模型名可修改配置 · ${APP_VERSION.replace(/^web-\d{4}-/, "v")}`;
  await loadProjects();
  await loadExternalAgents();
  await loadRag();
  await loadEstate();
  // 用户自定义命令：预热带进斜杠菜单（失败静默，命令不可用不影响对话）
  await loadUserCommands().catch(() => {});

  // 能力自检：前端具备但服务端缺失的接口 → 说明服务进程是旧代码启动的，提示重启。
  // （静态文件每次请求都读磁盘，浏览器能拿到新脚本；但路由是进程启动时固化的）
  try {
    const probe = await fetch("/api/fs/list", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(getAuthTokenSafe() ? { Authorization: "Bearer " + getAuthTokenSafe() } : {}) },
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

  on("new-chat-btn", "click", () => { setSidebarOpen(false); openModal(); });
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
  document.querySelectorAll<HTMLElement>(".settings-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showSettingsView(btn.dataset.settingsView || "models"));
  });
  on("stats-refresh", "click", refreshStats);
  on("mem-add-btn", "click", () => { void saveMemoryFromForm(); });
  on("cmd-add-btn", "click", () => { void saveCommandFromForm(); });
  on("cmd-name", "keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter") { ke.preventDefault(); void saveCommandFromForm(); }
  });
  on("cmd-title", "keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter") { ke.preventDefault(); void saveCommandFromForm(); }
  });
  on("skill-add-btn", "click", () => { void saveSkillFromForm(); });
  on("skill-id", "keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter") { ke.preventDefault(); void saveSkillFromForm(); }
  });
  on("mcp-add-btn", "click", () => { void saveMcpFromForm(); });
  on("mcp-command", "keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter") { ke.preventDefault(); void saveMcpFromForm(); }
  });

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
  on("provider-btn", "click", (e) => {
    e.stopPropagation();
    const menu = $("provider-menu");
    api<AppConfig>("/api/config").then(applyConfigState).catch(() => {});
    showProviderMenu(menu?.classList.contains("hidden") ?? false);
  });
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const sw = document.querySelector(".provider-switch");
    if (!sw || !sw.contains(target)) showProviderMenu(false);
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
  on("add-provider-btn", "click", () => openProviderForm(null));
  on("provider-use-btn", "click", () => {
    const p = currentlySelectedProvider();
    if (p && !p.active) void activateModel(p.id, null);
  });
  on("provider-edit-btn", "click", () => {
    const p = currentlySelectedProvider();
    if (p) openProviderForm(p.id);
  });
  on("provider-delete-btn", "click", () => {
    const p = currentlySelectedProvider();
    if (p) void removeProvider(p.id, p.name);
  });
  on("backup-create-btn", "click", async () => {
    try {
      const res = await api<{ hint?: string; name: string }>("/api/backup", { method: "POST" });
      uiAlert(res.hint || `备份已创建：${res.name}`, "备份完成");
      await refreshBackups();
    } catch (err) {
      uiAlert(`备份失败：${(err as Error).message}`, "备份");
    }
  });
  on("provider-modal-close", "click", closeProviderForm);
  on("provider-modal-mask", "click", (e) => {
    if (e.target === $("provider-modal-mask")) closeProviderForm();
  });
  on("pf-cancel-edit", "click", closeProviderForm);
  on("pf-key-toggle", "click", () => toggleSecretInput("pf-key-toggle", "pf-api-key"));
  // 弹窗内测试连接 / 拉取模型 → 加入本次新增的初始模型
  on("pf-test", "click", () => { void fetchGatewayModelChips("pending"); });
  on("pf-new-fetch-models", "click", () => { void fetchGatewayModelChips("pending"); });
  on("pf-new-model-add-btn", "click", () => {
    void import("./views/model-actions.js").then((m) => m.addPendingModelByName(
      ($("pf-new-model-name") as HTMLInputElement | null)?.value || "", null
    ));
  });
  on("pf-new-model-name", "keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter") {
      ke.preventDefault();
      void import("./views/model-actions.js").then((m) => m.addPendingModelByName(
        ($("pf-new-model-name") as HTMLInputElement | null)?.value || "", null
      ));
    }
  });
  on("pf-save", "click", () => { void saveProvider(); });
  // 右栏已存供应商：获取列表或手动添加模型
  on("pf-fetch-models", "click", () => { void fetchGatewayModelChips("detail"); });
  on("pf-model-add-btn", "click", () => {
    void import("./views/model-actions.js").then((m) => m.addModelByName(
      ($("pf-model-new") as HTMLInputElement | null)?.value || "", null
    ));
  });
  $("pf-model-new")?.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter") {
      ke.preventDefault();
      void import("./views/model-actions.js").then((m) => m.addModelByName(
        ($("pf-model-new") as HTMLInputElement | null)?.value || "", null
      ));
    }
  });
  // 模型编辑面板：思考等级（方言 / 档位）与保存、删除、设为启用
  on("mf-save", "click", () => { void saveModel(); });
  on("mf-activate", "click", () => {
    void import("./views/model-store.js").then((m) => {
      const p = m.currentEditingProvider();
      const model = m.currentEditingModel();
      if (p && model) void activateModel(p.id, model.id);
    });
  });
  on("mf-delete", "click", () => {
    void import("./views/model-store.js").then((m) => {
      const p = m.currentEditingProvider();
      const model = m.currentEditingModel();
      if (p && model) void import("./views/model-actions.js").then((a) => a.removeModel(p.id, model.id, model.name));
    });
  });
  on("mf-dialect", "change", () => {
    void import("./views/model-form.js").then((m) => {
      m.renderLevelSelect(
        ($("mf-dialect") as HTMLSelectElement | null)?.value || "auto",
        "default",
        ($("mf-custom") as HTMLInputElement | null)?.value || ""
      );
    });
  });
  on("mf-level", "change", () => {
    void import("./views/model-form.js").then((m) => {
      m.renderLevelSelect(
        ($("mf-dialect") as HTMLSelectElement | null)?.value || "auto",
        ($("mf-level") as HTMLSelectElement | null)?.value || "default",
        ($("mf-custom") as HTMLInputElement | null)?.value || ""
      );
    });
  });

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
  on("kb-close", "click", closeKb);
  on("kb-mask", "click", (e) => { if (e.target === $("kb-mask")) closeKb(); });
  on("kb-save", "click", () => { void saveKbConfig(); });
  on("kb-test", "click", () => { void testKb(); });
  on("kb-key-toggle", "click", () => toggleSecretInput("kb-key-toggle", "kb-key"));
  on("kb-ingest", "click", () => { void ingestKbFolder(); });
  on("kb-paste", "click", () => { void pasteKbText(); });
  on("kb-search-btn", "click", () => { void searchKbTest(); });
  on("kb-query", "keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter") { ke.preventDefault(); void searchKbTest(); }
  });
  on("kb-clear", "click", () => { void clearKb(); });

  // 房产数据源（贝壳 CLI）：面板开关 / 检测 / 安装 / 保存 Key
  on("estate-close", "click", closeEstate);
  on("estate-mask", "click", (e) => { if (e.target === $("estate-mask")) closeEstate(); });
  on("estate-check", "click", async () => {
    const { setEstateStatus, renderEstatePanelForUi } = await import("./views/estate.js");
    setEstateStatus("探测中…");
    try { state.estate = await api("/api/estate"); }
    catch (err) { state.estate = { installed: false, error: (err as Error).message }; }
    renderEstatePanelForUi();
  });
  on("estate-install", "click", () => { void installBeikeCli(); });
  on("estate-key-save", "click", () => { void saveEstateKey(); });
  on("estate-key-toggle", "click", () => toggleSecretInput("estate-key-toggle", "estate-key"));

  on("send-btn", "click", () => { void send(); });
  on("stop-btn", "click", stopStreaming);
  inputEl.addEventListener("input", () => {
    import("./core/dom.js").then((m) => m.autoGrowImpl());
    refreshComposerMenu();
  });
  inputEl.addEventListener("keydown", (e) => {
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
      // 供应商弹窗是第一层：只关它，不要把背后的设置页一起关掉。
      if (isProviderFormOpen()) {
        e.preventDefault();
        closeProviderForm();
        return;
      }
      cancelActiveDialog(); // 兜底：焦点不在弹窗内时也能 Esc 关闭（未打开时是 no-op）
      closeComposerMenu();
      closeModal();
      closeSettingsPage();
      closeFsModal();
      closeKb();
      closeEstate();
      showProviderMenu(false);
      setSidebarOpen(false);
      closeCmMenus();
    }
    if (e.key === "Enter" && ["pf-name", "pf-base-url", "pf-api-key"].includes(target.id)) {
      e.preventDefault();
      void saveProvider();
    }
    if (e.key === "Enter" && ["mem-key", "mem-content"].includes(target.id)) {
      e.preventDefault();
      void saveMemoryFromForm();
    }
    if (e.key === "Enter" && ["kb-url", "kb-collection", "kb-topk"].includes(target.id)) {
      e.preventDefault();
      void saveKbConfig();
    }
    if (e.key === "Enter" && ["mf-name", "mf-label"].includes(target.id)) {
      e.preventDefault();
      void saveModel();
    }
  });

  renderSessions();
  const first = state.sessions[0];
  if (first) selectSession(first.id);
  else showWelcomeState();


}

function getAuthTokenSafe(): string {
  try { return localStorage.getItem("lg-agent-auth-token") || ""; } catch { return ""; }
}

/** 供应商连接弹窗是否打开（Esc 分层关闭用） */
function isProviderFormOpen(): boolean {
  const mask = $("provider-modal-mask");
  return Boolean(mask) && !mask?.classList.contains("hidden");
}

// 入口兜底：init 抛错时在页面上直接可见（否则所有按钮都静默失效）
init().catch((err) => {
  console.error("[init] 初始化失败：", err);
  showFatalBanner("初始化失败：" + (err && (err as Error).stack ? (err as Error).stack : String(err)));
});
