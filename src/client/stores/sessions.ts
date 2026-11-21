/**
 * ============================================================
 * stores/sessions.ts — 侧栏会话树（框架迁移 M4 批次 4.5）
 * ============================================================
 * 职责：会话列表的过滤/分组/折叠与展示派生；所有副作用留在 legacy 桥。
 * 设计立场：
 *  - 搜索是纯本地过滤（标题 + 本浏览器缓存的消息文本），零请求；
 *  - 分组顺序跟 projects 定义一致，未归属会话归「未归属」组；
 *  - 项目分组是树的一级节点；折叠状态只存 projectId 列表（core state 的
 *    state.projCollapsed，localStorage 持久化），不缓存 DOM 引用；
 *  - 搜索时强制展开：命中结果被折叠藏起来看起来就像「没搜到」；
 *  - 纯函数在 modules/session-tree.ts（无 pinia 依赖），本 store 只做派生。
 */
import { defineStore } from "pinia";
import { state } from "../core/state.js";
import { sessionMatchesProjectView } from "../modules/project-view.js";
import {
  ORPHAN_GROUP_KEY,
  sessionDayGroup,
  sessionMatchesSearch,
  sessionTagText,
  sessionTimeLabel,
} from "../modules/session-tree.js";
import type { ProjectEntry, Session } from "../modules/types.js";
import "./pinia.js";

/** 树上一个可渲染节点：分组头、时间分隔行或会话项。 */
export type SessionTreeNode =
  | { kind: "group"; key: string; name: string; cloud: boolean; count: number; collapsed: boolean; interactive: boolean; typeTag: string }
  | { kind: "day"; key: string; label: string }
  | { kind: "session"; key: string; session: Session };

export interface SessionViewItem {
  id: string;
  title: string;
  tag: string;
  time: string;
  active: boolean;
  stale: boolean;
  running: boolean;
  pending: boolean;
}

/** 组件侧命令面：会话切换 / 导出 / 删除 / 折叠都回 legacy 桥处理。 */
declare global {
  interface Window {
    __agentatlasSessionCommands?: {
      select?: (id: string) => void;
      exportSession?: (id: string) => void;
      removeSession?: (id: string) => void;
      toggleGroup?: (key: string) => void;
    };
    __agentatlasSessionListeners?: Set<() => void>;
  }
}

/** legacy 桥发布更新：唤醒已挂载的会话树重新取数。 */
export function publishSessions(): void {
  for (const listener of window.__agentatlasSessionListeners ?? []) listener();
}

export const useSessionsStore = defineStore("sessions", {
  state: () => ({
    /** 搜索词（侧栏输入框 v-model，纯本地过滤）。 */
    term: "",
    /** 每次外部状态变化自增，触发派生重算（core state 不是响应式的）。 */
    revision: 0,
  }),
  getters: {
    /** 过滤后的会话（项目视图 + 搜索词）。 */
    filtered(): Session[] {
      // ⚠ core state 不是 reactive：不加这一行，pinia 会把这个 getter 的
      // 结果永久缓存（唯一依赖是 term），会话增删后列表永不更新。
      void this.revision;
      const term = this.term.trim();
      return state.sessions.filter(
        (session) => sessionMatchesProjectView(state.projectView, session.projectId) && sessionMatchesSearch(session, term),
      );
    },
    /** 分组后的渲染节点序列（保持 projects 定义顺序，未归属在最后）。 */
    tree(): SessionTreeNode[] {
      void this.revision;
      const term = this.term.trim();
      const filtered = this.filtered;
      const groups: Array<{ key: string; project: ProjectEntry | null; sessions: Session[] }> = [];
      const byId = new Map<string, { key: string; project: ProjectEntry | null; sessions: Session[] }>();
      for (const project of state.projects) {
        const group = { key: project.id, project: project as ProjectEntry | null, sessions: [] as Session[] };
        groups.push(group);
        byId.set(project.id, group);
      }
      const other = { key: ORPHAN_GROUP_KEY, project: null as ProjectEntry | null, sessions: [] as Session[] };
      for (const session of filtered) (byId.get(session.projectId) || other).sessions.push(session);
      if (other.sessions.length) groups.push(other);

      const nodes: SessionTreeNode[] = [];
      for (const group of groups) {
        if (!group.sessions.length) continue;
        // 搜索时强制展开：命中结果若被折叠藏起来，看起来就像「没搜到」。
        const collapsed = !term && state.projCollapsed.includes(group.key);
        const cloud = group.project?.type === "cloud";
        nodes.push({
          kind: "group",
          key: group.key,
          name: group.project?.name ?? "未归属",
          cloud,
          count: group.sessions.length,
          collapsed,
          interactive: !term,
          typeTag: group.project ? (cloud ? "云端" : "本地") : group.key === ORPHAN_GROUP_KEY ? "无项目" : "已移除",
        });
        if (collapsed) continue;
        const sorted = [...group.sessions].sort((left, right) => right.createdAt - left.createdAt);
        let day = "";
        for (const session of sorted) {
          const nextDay = sessionDayGroup(session.createdAt);
          if (nextDay !== day) {
            day = nextDay;
            nodes.push({ kind: "day", key: `${group.key}:${day}`, label: day });
          }
          nodes.push({ kind: "session", key: session.id, session });
        }
      }
      return nodes;
    },
    /** 会话项展示字段（模板不再读 core state）。 */
    items(): Record<string, SessionViewItem> {
      const map: Record<string, SessionViewItem> = {};
      for (const node of this.tree) {
        if (node.kind !== "session") continue;
        const session = node.session;
        map[session.id] = {
          id: session.id,
          title: session.title,
          tag: sessionTagText(session),
          time: sessionTimeLabel(session.createdAt),
          active: session.id === state.currentId,
          stale: Boolean(session.stale),
          running: Boolean(state.streams[session.id]),
          pending: Boolean(session.pendingApproval),
        };
      }
      return map;
    },
    /** 空态文案（区分搜索无命中 / 无会话 / 项目为空）。 */
    emptyText(): string {
      if (this.term.trim()) return "没有命中搜索的会话";
      if (state.projectView === "all") return "还没有会话，点上方「＋ 新建对话」";
      if (state.projectView === "__none__") return "还没有不选择项目的会话，点上方「＋ 新建对话」";
      return "该项目下还没有会话";
    },
    isEmpty(): boolean {
      return this.tree.length === 0;
    },
  },
  actions: {
    /** 外部状态变更后调用（core state 非响应式，需显式 bump）。 */
    refresh(): void {
      this.revision += 1;
    },
    setTerm(term: string): void {
      this.term = term;
      this.revision += 1;
    },
  },
});
