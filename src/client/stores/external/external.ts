/**
 * ============================================================
 * stores/external.ts — 外部 Agent（框架迁移 M4 批次 4.4）
 * ============================================================
 * 职责：外部 Agent 卡片列表与接入/移除/凭证注入写回。
 * 设计立场：接入 = 在服务器上运行第三方代码，凭证注入默认关闭且强制二次确认（组件层）。
 */
import { defineStore } from "pinia";
import { api } from "../../core/api.js";
import { state } from "../../core/state.js";
import type { ExternalAgent } from "../../modules/types.js";
import "../pinia.js";

export const useExternalStore = defineStore("external", {
  state: () => ({
    agents: [] as ExternalAgent[],
    cloning: false,
  }),
  actions: {
    async load(): Promise<void> {
      try {
        const data = await api<{ agents?: ExternalAgent[] }>("/api/external-agents");
        this.agents = data.agents || [];
      } catch {
        this.agents = []; // 旧服务进程没有该接口 → 静默降级
      }
      state.externalAgents = this.agents;
    },
    async remove(id: string): Promise<void> {
      const res = await api<{ agents?: ExternalAgent[] }>(`/api/external-agents/${id}`, { method: "DELETE" });
      this.agents = res.agents || [];
      state.externalAgents = this.agents;
    },
    async setPassCredentials(id: string, passCredentials: boolean): Promise<void> {
      const res = await api<{ agent: ExternalAgent }>(`/api/external-agents/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passCredentials, confirmCredentials: true }),
      });
      const idx = this.agents.findIndex((x) => x.id === id);
      if (idx >= 0) this.agents[idx] = res.agent;
      state.externalAgents = this.agents;
    },
    async saveCommand(id: string, command: string, args: string[]): Promise<ExternalAgent> {
      const res = await api<{ agent: ExternalAgent }>(`/api/external-agents/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      const idx = this.agents.findIndex((x) => x.id === id);
      if (idx >= 0) this.agents[idx] = res.agent;
      state.externalAgents = this.agents;
      return res.agent;
    },
    /** 接入流程：clone + 自动识别；返回新 Agent 与提示（组件决定后续流程）。 */
    async add(url: string): Promise<{ agent: ExternalAgent; hint?: string }> {
      this.cloning = true;
      try {
        const res = await api<{ agents?: ExternalAgent[]; agent: ExternalAgent; hint?: string }>(
          "/api/external-agents",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          },
        );
        this.agents = res.agents || [];
        state.externalAgents = this.agents;
        return { agent: res.agent, hint: res.hint };
      } finally {
        this.cloning = false;
      }
    },
  },
});
