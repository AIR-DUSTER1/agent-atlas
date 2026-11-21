/**
 * ============================================================
 * stores/shell.ts — 欢迎页 Agent 卡片与示例 chips（M4 批次 4.5）
 * ============================================================
 * 职责：从 AGENT_PROFILES + 内置 demos + 插件开关派生可渲染的卡片清单。
 * 设计立场：
 *  - Agent 文案只有一个来源（AGENT_PROFILES），组件不写死名称/描述；
 *  - 找房 / 求职 Agent 是插件入口，插件停用即隐藏（不能创建空能力会话）；
 *  - 创建会话的副作用在 legacy 桥（stream/turn.ts 的 createSession），
 *    组件经 window 命令面发意图。
 */
import { defineStore } from "pinia";
import { state } from "../core/state.js";
import { AGENT_PROFILES } from "../modules/agent-profile.js";
import type { SessionKind } from "../modules/types.js";

/** 侧栏欢迎页的四个通用示例（点一下即建会话并预填）。 */
export const GENERAL_EXAMPLES = [
  "帮我算一下 (128+512)*3，再看看现在几点了",
  "查一下北京的天气，适合穿什么",
  "给 boss@example.com 发一封邮件，主题是周报",
  "附加一个文件，帮我总结它的要点（用附件按钮选择）",
];

/** 一张 Agent / 示例卡片。 */
export interface AgentCardModel {
  key: string;
  icon: string;
  name: string;
  description: string;
  example: string;
  badge?: string;
  /** 点击后创建的会话类型与参数。 */
  kind: SessionKind | null;
  demo: number | null;
  prefill: string | null;
}

declare global {
  interface Window {
    __agentatlasShellCommands?: {
      create?: (kind: SessionKind | null, demo?: number | null, prefill?: string | null) => void;
    };
    __agentatlasShellListeners?: Set<() => void>;
  }
}

/** legacy 桥发布更新（插件启停 / 配置加载后重建卡片）。 */
export function publishShell(): void {
  for (const listener of window.__agentatlasShellListeners ?? []) listener();
}

export const useShellStore = defineStore("shell", {
  state: () => ({
    revision: 0,
  }),
  getters: {
    examples(): string[] {
      return GENERAL_EXAMPLES;
    },
    /** 欢迎页与新会话弹窗共用的卡片清单（顺序即产品顺序）。 */
    cards(): AgentCardModel[] {
      void this.revision;
      const list: AgentCardModel[] = [];
      const general = AGENT_PROFILES.general;
      list.push({
        key: "general",
        icon: general.icon,
        name: general.label,
        badge: "默认",
        description: general.description,
        example: general.example,
        kind: "agent",
        demo: null,
        prefill: null,
      });
      const estate = AGENT_PROFILES.estate;
      if (state.plugins?.enabled.estate !== false) {
        list.push({
          key: "estate",
          icon: estate.icon,
          name: estate.label,
          description: estate.description,
          example: estate.example,
          kind: "estate",
          demo: null,
          prefill: null,
        });
      }
      const job = AGENT_PROFILES.job;
      if (state.plugins?.enabled.job !== false) {
        list.push({
          key: "job",
          icon: job.icon,
          name: job.label,
          description: job.description,
          example: job.example,
          kind: "job",
          demo: null,
          prefill: null,
        });
      }
      for (const demo of state.config?.demos || []) {
        list.push({
          key: `demo-${demo.id}`,
          icon: String(demo.id),
          name: demo.name,
          description: demo.desc,
          example: demo.example,
          kind: "demo",
          demo: demo.id,
          prefill: demo.example,
        });
      }
      return list;
    },
  },
  actions: {
    refresh(): void {
      this.revision += 1;
    },
  },
});
