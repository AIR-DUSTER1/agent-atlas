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
import type { BeikeInstallJob, BeikeInstallResponse, EstateState } from "../../modules/types.js";
import "../pinia.js";

const INSTALL_POLL_MS = 1_500;
const INSTALL_POLL_TIMEOUT_MS = 11 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      // POST 只启动后台任务；后续短轮询避免下载时长触发反向代理 504。
      const started = await api<BeikeInstallResponse>("/api/estate/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      let job: BeikeInstallJob | null = started.install;
      if (!job) throw new Error("服务端没有返回贝壳 CLI 安装任务，请升级服务端后重试");

      const deadline = Date.now() + INSTALL_POLL_TIMEOUT_MS;
      while (job.status === "installing") {
        this.estate = { ...(this.estate || { installed: false }), install: job };
        state.estate = this.estate;
        if (Date.now() > deadline) {
          throw new Error("安装仍在后台进行，请稍后重新打开面板查看结果，不要重复点击安装");
        }
        await sleep(INSTALL_POLL_MS);
        const polled = await api<BeikeInstallResponse>("/api/estate/install");
        if (!polled.install) throw new Error("贝壳 CLI 安装任务状态丢失，请点「重新检测」");
        job = polled.install;
      }

      this.estate = { ...(this.estate || { installed: false }), install: job };
      state.estate = this.estate;
      if (job.status === "failed") throw new Error(job.error || "贝壳 CLI 安装失败");
      await this.load();
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
