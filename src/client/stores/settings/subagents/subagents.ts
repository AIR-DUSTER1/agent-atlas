/**
 * ============================================================
 * stores/subagents.ts — 子代理目录（框架迁移 M4 批次 4.2）
 * ============================================================
 * 职责：子代理面板的业务状态与写回（目录读取、启停、保存、删除）。
 * 设计立场：保存后以服务端返回的目录为准；镜像写回 core state 供
 * transition 期其他读取方使用。
 */
import { defineStore } from "pinia";
import { api } from "../../../core/api.js";
import { state } from "../../../core/state.js";
import type {
  AppConfig,
  SubagentModelSelection,
  SubagentRouting,
  SubagentSettingsState,
} from "../../../modules/types.js";
import "../../pinia.js";

export type SubagentFilter = "all" | "enabled" | "disabled";

export interface SubagentSavePayload {
  name: string;
  description: string;
  enabled: boolean;
  model: SubagentModelSelection;
  routing: SubagentRouting;
}

export const useSubagentsStore = defineStore("subagents", {
  state: () => ({
    agents: [] as SubagentSettingsState["agents"],
    config: null as AppConfig | null,
  }),
  actions: {
    /** 目录与供应商配置并行拉取；config 同步 legacy state（路由面板同源）。 */
    async refresh(): Promise<void> {
      const [config, agents] = await Promise.allSettled([
        api<AppConfig>("/api/config"),
        api<SubagentSettingsState>("/api/subagents"),
      ]);
      if (config.status === "fulfilled") {
        this.config = config.value;
        state.config = config.value;
      }
      if (agents.status !== "fulfilled") throw agents.reason;
      this.agents = agents.value.agents;
      state.subagents = agents.value;
    },
    async setEnabled(id: string, enabled: boolean): Promise<void> {
      const res = await api<SubagentSettingsState>(`/api/subagents/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      this.agents = res.agents;
      state.subagents = res;
    },
    async save(payload: SubagentSavePayload, id?: string): Promise<void> {
      const path = id ? `/api/subagents/${encodeURIComponent(id)}` : "/api/subagents";
      const res = await api<SubagentSettingsState>(path, {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      this.agents = res.agents;
      state.subagents = res;
    },
    async remove(id: string): Promise<void> {
      const res = await api<SubagentSettingsState>(`/api/subagents/${encodeURIComponent(id)}`, { method: "DELETE" });
      this.agents = res.agents;
      state.subagents = res;
    },
  },
});
