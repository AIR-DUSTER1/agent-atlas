/**
 * ============================================================
 * stores/memories.ts — 长期记忆（框架迁移 M4 批次 4.2）
 * ============================================================
 * 职责：记忆面板的业务状态与写回（配置、状态、条目、候选、导入导出）。
 * 设计立场：配置保存和连接测试使用同一份表单快照（组件传同一 payload），
 * 避免「测 A 存 B」；scope 按 profileFilter 隔离。
 */
import { defineStore } from "pinia";
import { api } from "../core/api.js";
import type {
  MemoryEntry,
  MemoryProviderHealth,
  MemorySlotConfig,
  MemorySlotStatus,
} from "../modules/types.js";
import "./pinia.js";

export type MemoryProfile = "general" | "estate" | "job";

export const useMemoriesStore = defineStore("memories", {
  state: () => ({
    config: null as MemorySlotConfig | null,
    status: null as MemorySlotStatus | null,
    memories: [] as MemoryEntry[],
    candidates: [] as MemoryEntry[],
    profileFilter: "general" as MemoryProfile,
    showHistory: false,
  }),
  actions: {
    /** 配置与状态并行拉取；条目另拉（依赖 profileFilter）。 */
    async refreshSettings(): Promise<void> {
      const [configResult, status] = await Promise.all([
        api<{ config: MemorySlotConfig }>("/api/memory/config"),
        api<MemorySlotStatus>(`/api/memory/status?profileId=${this.profileFilter}`),
      ]);
      this.config = configResult.config;
      this.status = status;
      await this.refreshEntries();
    },
    /** 记忆条目与候选；显示历史版本开关影响 active 列表。 */
    async refreshEntries(): Promise<void> {
      const data = await api<{ memories?: MemoryEntry[] }>(
        `/api/memories?profileId=${this.profileFilter}${this.showHistory ? "&history=1" : ""}`,
      );
      this.memories = data.memories ?? [];
      const candidateData = await api<{ memories?: MemoryEntry[] }>(
        `/api/memories/candidates?profileId=${this.profileFilter}`,
      );
      this.candidates = candidateData.memories ?? [];
    },
    /** 保存配置；返回生效 Provider 与最新状态。 */
    async saveConfig(patch: unknown): Promise<{ config: MemorySlotConfig; providerId: "local" | "http" }> {
      const result = await api<{ config: MemorySlotConfig; providerId: "local" | "http" }>("/api/memory/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      this.config = result.config;
      this.status = await api<MemorySlotStatus>(`/api/memory/status?profileId=${this.profileFilter}`);
      await this.refreshEntries();
      return result;
    },
    /** 只保存个性化上下文（独立入口，不触碰其余配置）。 */
    async savePersonalization(patch: { enabled: boolean; text: string }): Promise<void> {
      const result = await api<{ config: MemorySlotConfig }>("/api/memory/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personalization: patch }),
      });
      this.config = result.config;
    },
    async testHttp(patch: unknown): Promise<{ ok: boolean; health: MemoryProviderHealth }> {
      return api<{ ok: boolean; health: MemoryProviderHealth }>("/api/memory/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    },
    async testEmbedding(patch: unknown): Promise<{ ok: boolean; dimensions: number; model: string }> {
      return api<{ ok: boolean; dimensions: number; model: string }>("/api/memory/embedding/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    },
    async reindex(): Promise<{ indexed: number; model: string }> {
      const result = await api<{ ok: boolean; status: { indexed: number; model: string } }>("/api/memory/reindex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: this.profileFilter }),
      });
      this.status = await api<MemorySlotStatus>(`/api/memory/status?profileId=${this.profileFilter}`);
      return result.status;
    },
    async removeEntry(id: string): Promise<void> {
      await api(`/api/memories/${encodeURIComponent(id)}?profileId=${this.profileFilter}`, { method: "DELETE" });
      await this.refreshEntries();
    },
    async confirmCandidate(id: string): Promise<void> {
      await api(`/api/memories/${encodeURIComponent(id)}/confirm?profileId=${this.profileFilter}`, { method: "POST" });
      await this.refreshEntries();
    },
    async rejectCandidate(id: string): Promise<void> {
      await api(`/api/memories/${encodeURIComponent(id)}/reject?profileId=${this.profileFilter}`, { method: "POST" });
      await this.refreshEntries();
    },
    /** 导入快照（组件已读文件并处理 replace 确认）。 */
    async importSnapshot(mode: "merge" | "replace", snapshot: unknown): Promise<number> {
      const result = await api<{ imported: number }>("/api/memories/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: this.profileFilter, mode, snapshot }),
      });
      await this.refreshEntries();
      return result.imported;
    },
  },
});
