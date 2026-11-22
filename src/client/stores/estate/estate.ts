/**
 * ============================================================
 * stores/estate.ts — 房产数据源（贝壳 CLI）（框架迁移 M4 批次 4.4）
 * ============================================================
 * 职责：贝壳面板的业务状态与写回（检测 / 安装 / Key 校验 / 登录页打开）。
 * 设计立场：Key 只写不读不落盘回显；state.estate 镜像 core state。
 */
import { defineStore } from "pinia";
import { api } from "../../core/api.js";
import { state } from "../../core/state.js";
import type { EstateState } from "../../modules/types.js";
import "../pinia.js";

export const useEstateStore = defineStore("estate", {
  state: () => ({
    /** 贝壳弹窗开合（mount 容器的 hidden 类由组件 watch 代管）。 */
    estateOpen: false,
    estate: { installed: false } as EstateState,
  }),
  actions: {
    async load(): Promise<void> {
      try {
        this.estate = await api<EstateState>("/api/estate");
      } catch {
        this.estate = { installed: false }; // 旧服务进程没有该接口 → 静默降级
      }
      state.estate = this.estate;
    },
    async install(): Promise<void> {
      const res = await api<EstateState>("/api/estate/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      this.estate = { ...(this.estate || { installed: false }), ...res };
      state.estate = this.estate;
    },
    async saveKey(value: string): Promise<{ ok: boolean; message?: string; error?: string }> {
      const res = await api<{ ok: boolean; message?: string; error?: string }>("/api/estate/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: value }),
      });
      return res;
    },
    async openLogin(): Promise<{ ok: boolean; url: string; opened: boolean; message?: string; error?: string }> {
      return api<{ ok: boolean; url: string; opened: boolean; message?: string; error?: string }>(
        "/api/estate/login",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
    },
  },
});
