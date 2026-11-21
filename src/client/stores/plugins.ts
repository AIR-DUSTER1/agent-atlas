/**
 * ============================================================
 * stores/plugins.ts — 插件目录与启停状态（框架迁移 M4 批次 4.1）
 * ============================================================
 * 职责：插件面板（Vue 化后）唯一的业务状态源：目录元数据外的五个运行态
 * （plugins / rag / estate / job / browser）统一在这里拉取与写回。
 * 设计立场：
 *  - 开关只改变 tool allowlist；关闭不等于删除插件配置（与后端契约一致）；
 *  - 过渡期 h() 侧（shell 导航欢迎语、Agent 卡片）仍读 core/state.ts，
 *    本 store 每次变更后把镜像写回 core state，4.5 壳反转后该桥接删除；
 *  - readiness 判定与 BUILTIN_PLUGINS 目录留在模块层，组件只消费。
 */
import { defineStore } from "pinia";
import { api } from "../core/api.js";
import { state } from "../core/state.js";
// 启动期（main.ts loadPluginState）就会在组件外 useStore：必须先确保共享
// 实例已 setActivePinia，否则 getActivePinia() 为空直接抛错、阻断应用 boot。
import "./pinia.js";
import type {
  BrowserUseState,
  EstateState,
  JobState,
  PluginSettingsState,
  RagState,
} from "../modules/types.js";

export type PluginId = string;

export interface PluginRuntime {
  plugins: PluginSettingsState | null;
  rag: RagState | null;
  estate: EstateState | null;
  job: JobState | null;
  browser: BrowserUseState | null;
}

export const usePluginsStore = defineStore("plugins", {
  state: (): PluginRuntime => ({
    plugins: null,
    rag: null,
    estate: null,
    job: null,
    browser: null,
  }),
  actions: {
    /** 把镜像写回 core state，供过渡期 h() 消费方（欢迎语 / Agent 卡）读取。 */
    syncToLegacyState(): void {
      state.plugins = this.plugins;
      state.rag = this.rag;
      state.estate = this.estate;
      state.job = this.job;
      state.browser = this.browser;
    },
    /** legacy 侧（rag / estate 配置流）改写 core state 后，把镜像同步回 store。 */
    syncFromLegacyState(): void {
      this.rag = state.rag;
      this.estate = state.estate;
      this.job = state.job;
      this.browser = state.browser;
      this.plugins = state.plugins;
    },
    /** 首次初始化只需要启停状态；插件页打开后再补齐各插件详细状态。 */
    async loadEnabled(): Promise<void> {
      try {
        this.plugins = await api<PluginSettingsState>("/api/plugins");
      } catch {
        // 旧服务进程没有 /api/plugins：保留目录默认值，不阻断启动。
      }
      this.syncToLegacyState();
    },
    /** 设置页插件分区懒加载：各接口互不阻塞，任一失败保留其它状态。 */
    async refreshAll(): Promise<void> {
      const [rag, estate, job, browser, plugins] = await Promise.allSettled([
        api<RagState>("/api/rag"),
        api<EstateState>("/api/estate"),
        api<JobState>("/api/job"),
        api<BrowserUseState>("/api/browser/status"),
        api<PluginSettingsState>("/api/plugins"),
      ]);
      if (rag.status === "fulfilled") this.rag = rag.value;
      if (estate.status === "fulfilled") this.estate = estate.value;
      if (job.status === "fulfilled") this.job = job.value;
      if (browser.status === "fulfilled") this.browser = browser.value;
      if (plugins.status === "fulfilled") this.plugins = plugins.value;
      this.syncToLegacyState();
    },
    /** 启停写回：成功后以服务端返回为准；失败抛出由组件回滚开关。 */
    async toggle(id: PluginId, enabled: boolean): Promise<void> {
      this.plugins = await api<PluginSettingsState>(`/api/plugins/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      this.syncToLegacyState();
    },
  },
});
