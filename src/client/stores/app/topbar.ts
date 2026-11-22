/**
 * ============================================================
 * stores/topbar.ts — 顶栏会话头与权限 chip（M4 批次 4.5）
 * ============================================================
 * 职责：正文标题 / 面包屑 / 示例徽标 / 权限 chip 文案与菜单项的展示派生。
 * 设计立场：
 *  - 数据都在 core state，store 只做派生并靠 revision 触发重算；
 *  - 「哪些会话有权限切换」的判定统一走 modules/session-kind 的共享谓词
 *    （历史上这里硬编码 agent||estate，加求职 Agent 时漏改，导致求职会话
 *     根本没有权限入口）；
 *  - 切换权限的 API 调用与失败提示留在 legacy 桥。
 */
import { defineStore } from "pinia";
import { state } from "../../core/state.js";
import { profileMetaForSession } from "../../modules/agent-profile.js";
import { isAgentKind } from "../../modules/session-kind.js";
import { PERMISSION_MODES, type PermissionMode } from "../../modules/permission-modes.js";
import { PRODUCT_NAME } from "../../modules/product.js";
import type { PermissionModeId, Session } from "../../modules/types.js";
import "../pinia.js";

export { PERMISSION_MODES, type PermissionMode };

const DEMO_BADGE_TEXT: Record<number, string> = {
  1: "示例 1 · 基础 ReAct", 2: "示例 2 · 对话记忆",
  3: "示例 3 · 人工审批", 4: "示例 4 · 多 Agent",
};

/** 欢迎态：普通欢迎页 vs 无项目时的 Agent 选择页。 */
export type WelcomeMode = "default" | "agent-picker";

declare global {
  interface Window {
    __agentatlasTopbarCommands?: {
      setPermission?: (mode: PermissionModeId) => void;
    };
    __agentatlasTopbarListeners?: Set<() => void>;
  }
}

export function publishTopbar(): void {
  for (const listener of window.__agentatlasTopbarListeners ?? []) listener();
}

export const useTopbarStore = defineStore("topbar", {
  state: () => ({
    revision: 0,
    /** 当前欢迎态（由 showWelcomeState 写入）。 */
    welcomeMode: "default" as WelcomeMode,
    /** 会话头：标题 / 面包屑 / 徽标文案与可见性。 */
    sessionTitle: "未选择会话",
    breadcrumb: PRODUCT_NAME as string,
    badgeText: "",
    badgeVisible: false,
    /** 欢迎页标题与副标题（欢迎态与插件开关共同决定）。 */
    welcomeTitle: PRODUCT_NAME as string,
    welcomeSubtitle: "可扩展的 Agent 工具集：编程、文件、知识库与电脑操作统一入口，高风险动作先请求确认",
    cardsLabel: "选择 Agent 或内置示例",
    pickingAgent: false,
    /** 权限 chip：仅在具备 Agent 执行力的会话显示。 */
    permVisible: false,
    permModeId: "approve" as PermissionModeId,
    permLabel: "审批",
    permDesc: PERMISSION_MODES[1]!.desc,
  }),
  getters: {
    permText(): string {
      return `权限·${this.permLabel}`;
    },
    permTitle(): string {
      return `会话权限模式：${this.permLabel} —— ${this.permDesc}`;
    },
    /** 权限菜单配置：勾选态按当前模式。 */
    permItems(): Array<PermissionMode & { active: boolean }> {
      return PERMISSION_MODES.map((mode) => ({ ...mode, active: mode.id === this.permModeId }));
    },
  },
  actions: {
    refresh(): void {
      this.revision += 1;
    },
    /** 无项目时的 Agent 选择页副标题（插件开关影响 Agent 列表描述）。 */
    agentPickerSubtitle(): string {
      const hasEstatePlugin = state.plugins?.enabled.estate !== false;
      return `当前还没有添加项目。先选择${hasEstatePlugin ? "通用 Agent 或租房 / 房产 Agent" : "通用 Agent"}，直接开始即可；需要文件上下文时再到左上角添加项目。`;
    },
    /** 欢迎态（showWelcomeState 调用）：同时重置会话头。 */
    applyWelcome(mode: WelcomeMode): void {
      this.welcomeMode = mode;
      const pickingAgent = mode === "agent-picker";
      this.pickingAgent = pickingAgent;
      this.sessionTitle = pickingAgent ? "选择 Agent" : "选择会话";
      this.breadcrumb = pickingAgent
        ? "新会话"
        : state.projectView === "__none__"
          ? "不选择项目"
          : state.projects.find((project) => project.id === state.projectView)?.name ?? PRODUCT_NAME;
      this.welcomeTitle = pickingAgent ? "选择一个 Agent 开始新会话" : PRODUCT_NAME;
      this.welcomeSubtitle = pickingAgent
        ? this.agentPickerSubtitle()
        : "可扩展的 Agent 工具集：编程、文件、知识库与电脑操作统一入口，高风险动作先请求确认";
      this.cardsLabel = pickingAgent ? "选择 Agent" : "选择 Agent 或内置示例";
      this.badgeVisible = false;
      this.badgeText = "";
      this.refresh();
    },
    /** 会话态（showChatState 调用）：标题、面包屑、示例徽标与权限 chip。 */
    applySession(session: Session): void {
      this.welcomeMode = "default";
      this.pickingAgent = false;
      this.sessionTitle = session.title;
      this.breadcrumb = state.projects.find((project) => project.id === session.projectId)?.name ?? "未归属项目";
      const profile = profileMetaForSession(session);
      this.badgeText = session.kind === "demo"
        ? (DEMO_BADGE_TEXT[session.demo || 0] || `示例 ${session.demo}`)
        : session.kind === "external"
          ? `🔌 外部 · ${state.externalAgents.find((agent) => agent.id === session.agentId)?.name ?? "Agent"}`
          : profile ? `${profile.icon} ${profile.label}` : "未知 Agent";
      this.badgeVisible = true;
      this.applyPermission(session);
      this.refresh();
    },
    /** 插件启停后刷新选择页副标题。 */
    refreshPluginCopy(): void {
      if (this.welcomeMode !== "agent-picker") return;
      this.welcomeSubtitle = this.agentPickerSubtitle();
      this.refresh();
    },
    /** 权限 chip：按共享谓词判定可用性并同步文案。 */
    applyPermission(session?: Session): void {
      const current = session ?? state.sessions.find((item) => item.id === state.currentId);
      this.permVisible = Boolean(current) && !current?.stale && isAgentKind(current?.kind);
      if (!this.permVisible) return;
      const mode = PERMISSION_MODES.find((item) => item.id === (current?.permissionMode || "approve")) ?? PERMISSION_MODES[1]!;
      this.permModeId = mode.id;
      this.permLabel = mode.label;
      this.permDesc = mode.desc;
      this.refresh();
    },
  },
});
