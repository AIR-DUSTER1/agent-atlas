/**
 * ============================================================
 * stores/browser-dock.ts — Browser Use 右侧画面视图状态（M4 批次 4.4）
 * ============================================================
 * 职责：把轮询得到的页面状态整理成一份可渲染快照，经 window 通道推给
 * browser-dock-vue.vue。
 * 为什么不用 store 直接互调：bundle 与 1:1 过渡树是两个模块实例（各有独立
 * pinia），e2e 用 1:1 副本的 openBrowserDock 驱动 dock 时，只有 window 是
 * 两者都能访问的通道（与上下文容量条同一解法）。
 * 设计立场：
 *  - 快照只含展示字段，不含网页内容，不落 localStorage；
 *  - 轮询与关闭仍由 legacy views/browser-use.ts 负责（它持有 core state）。
 */
import { defineStore } from "pinia";
import "../pinia.js";

/** 右侧浏览器画面的完整展示状态。 */
export interface BrowserDockSnapshot {
  sessionId: string;
  /** false = 收起（#browser-dock 加 hidden、#main 去掉 browser-open）。 */
  visible: boolean;
  title: string;
  url: string;
  /** 状态胶囊文案（连接中 / 实时连接 / AI 操作中 / 页面异常 / 已关闭）。 */
  stateText: string;
  /** 胶囊色调：live / busy / 空。 */
  stateTone: "live" | "busy" | "";
  meta: string;
  /** 截图画面的地址（带 updatedAt 版本参数；空串 = 尚无画面）。 */
  screenshotSrc: string;
  emptyVisible: boolean;
  emptyTitle: string;
  emptyDetail: string;
}

/** 组件侧的命令入口（由 legacy 轮询器注册，Vue 只负责触发）。 */
export interface BrowserDockCommands {
  close?: () => void;
  /** 地址栏手动导航：job 源走采集画面端点，Browser Use 会话走会话导航端点。 */
  navigate?: (url: string) => void;
}

declare global {
  interface Window {
    __agentatlasBrowserDock?: BrowserDockSnapshot | null;
    __agentatlasBrowserDockListeners?: Set<() => void>;
    __agentatlasBrowserDockCommands?: BrowserDockCommands;
  }
}

/** legacy 侧发布快照：同时写 window 并唤醒所有已挂载组件。 */
export function publishBrowserDock(snapshot: BrowserDockSnapshot | null): void {
  if (typeof window === "undefined") return;
  window.__agentatlasBrowserDock = snapshot;
  for (const listener of window.__agentatlasBrowserDockListeners ?? []) listener();
}

export const useBrowserDockStore = defineStore("browserDock", {
  state: () => ({
    snapshot: null as BrowserDockSnapshot | null,
    /** 收到过快照的版本号（同一份快照重复推送也能触发重算）。 */
    revision: 0,
  }),
  getters: {
    visible(): boolean {
      return this.snapshot?.visible === true;
    },
    stateTone(): string {
      return this.snapshot?.stateTone ?? "";
    },
    screenshotSrc(): string {
      return this.snapshot?.screenshotSrc ?? "";
    },
  },
  actions: {
    apply(snapshot: BrowserDockSnapshot | null): void {
      this.snapshot = snapshot;
      this.revision += 1;
    },
  },
});
