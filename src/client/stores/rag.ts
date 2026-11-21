/**
 * ============================================================
 * stores/rag.ts — 知识库（外部 RAG）（框架迁移 M4 批次 4.4）
 * ============================================================
 * 职责：KB 面板的业务状态与写回（配置 / 入库位置 / 登记文档 / 检索命中）。
 * 设计立场：
 *  - 契约见 server/rag.ts：本地只存「送出去过什么」的登记，索引在外部服务；
 *  - state.rag 镜像写回 core state（插件面板 readiness 读它，4.1 桥接保留）。
 */
import { defineStore } from "pinia";
import { api } from "../core/api.js";
import { state } from "../core/state.js";
import type { FsListResult, RagHit, RagState } from "../modules/types.js";
import "./pinia.js";

export interface KbRoot {
  path: string;
  name: string;
  type: string;
}

export const useRagStore = defineStore("rag", {
  state: () => ({
    /** KB 弹窗开合（mount 容器的 hidden 类由组件 watch 代管）。 */
    kbOpen: false,
    rag: null as RagState | null,
    roots: [{ path: "", name: "项目根（当前 agentatlas 仓库）", type: "local" }] as KbRoot[],
    hits: [] as RagHit[],
    hitsState: "empty" as "empty" | "loading" | "done",
  }),
  getters: {
    docs(): RagState["docs"] {
      return this.rag?.docs ?? [];
    },
  },
  actions: {
    /** 拉取 RAG 状态并镜像 core state（插件 readiness / legacy 消费方）。 */
    async load(): Promise<void> {
      try {
        this.rag = await api<RagState>("/api/rag");
      } catch {
        this.rag = null; // 旧服务进程没有该接口 → 静默降级
      }
      state.rag = this.rag;
    },
    /** 入库位置下拉：与文件选择器同一批授权根。 */
    async loadRoots(): Promise<void> {
      try {
        const data = await api<FsListResult>("/api/fs/list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        this.roots = (data.roots || []).map((r) => ({ path: r.path, name: r.name, type: r.type || "local" }));
      } catch {
        /* 用默认项目根 */
      }
    },
    async applyRag(rag: RagState): Promise<void> {
      this.rag = rag;
      state.rag = rag;
    },
    async removeDoc(id: string): Promise<void> {
      const res = await api<{ rag: RagState }>(`/api/rag/docs/${id}`, { method: "DELETE" });
      await this.applyRag(res.rag);
    },
    async saveConfig(body: Record<string, unknown>): Promise<void> {
      const res = await api<{ rag: RagState }>("/api/rag/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await this.applyRag(res.rag);
    },
    async ingest(path: string): Promise<{ ingested?: number; chunks?: number }> {
      const res = await api<{ rag: RagState; summary?: { ingested?: number; chunks?: number } }>(
        "/api/rag/ingest",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) },
      );
      await this.applyRag(res.rag);
      return res.summary ?? {};
    },
    async ingestText(name: string, content: string): Promise<void> {
      const res = await api<{ rag: RagState }>("/api/rag/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content }),
      });
      await this.applyRag(res.rag);
    },
    async search(query: string): Promise<number> {
      const res = await api<{ hits?: RagHit[] }>("/api/rag/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      this.hits = Array.isArray(res.hits) ? res.hits : [];
      this.hitsState = "done";
      return this.hits.length;
    },
    async clear(): Promise<void> {
      const res = await api<{ rag: RagState }>("/api/rag/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await this.applyRag(res.rag);
      this.hits = [];
      this.hitsState = "empty";
    },
  },
});
