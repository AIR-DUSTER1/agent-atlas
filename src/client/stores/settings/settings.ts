/**
 * ============================================================
 * stores/settings.ts — 设置壳（导航 / 分区切换）（框架迁移 M4 批次 4.5）
 * ============================================================
 * 职责：设置页分区导航的唯一状态源（当前分区、搜索词、分区可见性）。
 * 设计立场：
 *  - 过渡期分区内容仍是 include 进来的 legacy 片段（各自独立 Vue 面板），
 *    Vue 只接管导航与分区显隐 —— 4.6 之后内容也随对话核心迁移；
 *  - 分区懒加载入口保持在 views/settings.ts（refreshXxx 桥），
 *    组件只负责「切到哪个分区」这件事。
 */
import { defineStore } from "pinia";
import "../pinia.js";

export type SettingsView =
  | "models" | "plugins" | "subagents" | "routing" | "tracing"
  | "memories" | "commands" | "skills" | "mcp" | "stats" | "users";

export interface SettingsNavGroup {
  id: string;
  title: string;
  items: SettingsNavItem[];
}

export interface SettingsNavItem {
  view: SettingsView;
  icon: string;
  title: string;
  description: string;
  /** 默认隐藏（用户管理：pg 且非 admin 时隐藏；file 模式可见）。 */
  hiddenByDefault?: boolean;
}

/** 导航清单：与 settings.html 静态版逐字对齐（组顺序 / 文案 / 图标）。 */
export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    id: "workbench",
    title: "agentatlas",
    items: [
      { view: "models", icon: "Settings", title: "模型与供应商", description: "网关、Key、模型与备份" },
      { view: "plugins", icon: "Plug", title: "插件", description: "RAG、数据源与浏览器 / 电脑控制" },
      { view: "subagents", icon: "Bot", title: "子代理", description: "模型、启停与动态委派能力" },
      { view: "routing", icon: "Waypoints", title: "路由决策", description: "按请求自动挑子代理" },
      { view: "tracing", icon: "Activity", title: "链路追踪", description: "LangSmith 可选上报与脱敏" },
    ],
  },
  {
    id: "extensions",
    title: "扩展",
    items: [
      { view: "memories", icon: "Brain", title: "记忆与个性化", description: "默认上下文与相关性记忆" },
      { view: "commands", icon: "Command", title: "自定义命令", description: "斜杠菜单里的提示词模板" },
      { view: "skills", icon: "BookOpen", title: "技能库", description: "按关键词自动加载的领域指南" },
      { view: "mcp", icon: "Server", title: "MCP 服务器", description: "接入外部工具（默认需审批）" },
    ],
  },
  {
    id: "system",
    title: "系统",
    items: [
      { view: "users", icon: "User", title: "用户管理", description: "多用户账号、密码与访问令牌", hiddenByDefault: true },
    ],
  },
  {
    id: "data",
    title: "数据",
    items: [
      { view: "stats", icon: "BarChart3", title: "使用统计", description: "Token 用量与会话运行" },
    ],
  },
];

export const SETTINGS_VIEWS: SettingsView[] = SETTINGS_NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => item.view));

export const useSettingsStore = defineStore("settings", {
  state: () => ({
    /** 当前分区（默认 models）。 */
    current: "models" as SettingsView,
    search: "",
    /** 被动态隐藏的分区（users 对非 admin）。 */
    hiddenViews: [] as SettingsView[],
  }),
  getters: {
    /** 搜索过滤后的导航组（空组自动隐藏，命中项加 search-hit）。 */
    filteredGroups(): Array<SettingsNavGroup & { items: Array<SettingsNavItem & { hit: boolean }> }> {
      const term = this.search.trim().toLowerCase();
      return SETTINGS_NAV_GROUPS
        .filter((group) => !group.items.every((item) => this.hiddenViews.includes(item.view)))
        .map((group) => {
          const items = group.items
            .filter((item) => !this.hiddenViews.includes(item.view))
            .filter((item) => !term || `${item.title}${item.description}`.toLowerCase().includes(term))
            .map((item) => ({ ...item, hit: Boolean(term) }));
          return { ...group, items };
        })
        .filter((group) => group.items.length > 0);
    },
  },
  actions: {
    show(view: string): SettingsView {
      const next = (SETTINGS_VIEWS as string[]).includes(view) ? view as SettingsView : "models";
      this.current = next;
      return next;
    },
    setHidden(view: SettingsView, hidden: boolean): void {
      const present = this.hiddenViews.includes(view);
      if (hidden && !present) this.hiddenViews.push(view);
      if (!hidden && present) this.hiddenViews = this.hiddenViews.filter((item) => item !== view);
    },
  },
});
