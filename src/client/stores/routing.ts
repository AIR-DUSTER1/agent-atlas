/**
 * ============================================================
 * stores/routing.ts — 路由决策配置（框架迁移 M4 批次 4.2）
 * ============================================================
 * 职责：路由面板的业务状态与写回（快照读取、保存、试跑）。
 * 设计立场：保存后以服务端返回快照为准；试跑是用户主动触发的真实调用。
 */
import { defineStore } from "pinia";
import { api } from "../core/api.js";
import { state } from "../core/state.js";
import type { AppConfig, RoutingSnapshot, RoutingTestResult } from "../modules/types.js";
import "./pinia.js";

export const useRoutingStore = defineStore("routing", {
  state: () => ({
    snapshot: null as RoutingSnapshot | null,
    config: null as AppConfig | null,
    /** 最近一次试跑结果（null = 未试跑）。 */
    testResult: null as RoutingTestResult | null,
  }),
  actions: {
    /** 快照与供应商配置并行拉取；config 同步 legacy state 供其他面板复用。 */
    async load(): Promise<void> {
      const [snapshot, config] = await Promise.allSettled([
        api<RoutingSnapshot>("/api/routing"),
        api<AppConfig>("/api/config"),
      ]);
      if (config.status === "fulfilled") {
        this.config = config.value;
        state.config = config.value;
      }
      if (snapshot.status !== "fulfilled") throw snapshot.reason;
      this.snapshot = snapshot.value;
      state.routing = snapshot.value;
    },
    async save(payload: Record<string, unknown>): Promise<RoutingSnapshot> {
      const snapshot = await api<RoutingSnapshot>("/api/routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      this.snapshot = snapshot;
      state.routing = snapshot;
      return snapshot;
    },
    async runTest(text: string): Promise<RoutingTestResult> {
      const result = await api<RoutingTestResult>("/api/routing/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      this.testResult = result;
      return result;
    },
  },
});
