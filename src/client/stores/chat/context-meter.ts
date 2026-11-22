/**
 * ============================================================
 * stores/context-meter.ts — 上下文容量条（框架迁移 M4 批次 4.6）
 * ============================================================
 * 职责：把 state.usage[currentId] 映射成容量条的展示数据（填充宽度 / 文案 / 提示）。
 * 设计立场：
 *  - used 取最近一次主请求的 input usage；分母用扣除输出预留后的输入预算
 *    （200k 窗口在 150k used 时仍显示健康、实际已无输出空间，是历史 bug）；
 *  - 展示状态与原始 usage 分离：core state 仍是唯一数据源，store 只做派生。
 */
import { defineStore } from "pinia";
import { state } from "../../core/state.js";
import { fmtPercent, fmtTokenRate, fmtTokens } from "../../modules/format.js";
import type { UsageInfo } from "../../modules/types.js";
import "../pinia.js";

/** 容量条快照：由 composer-bar 的 updateContextBar 写入 window，组件 watch 后重算。 */
export interface ContextMeterSnapshot {
  contextTokens: number;
  lastInput: number;
  lastOutput: number;
  lastCache: number;
  contextWindow: number | null;
  inputBudget: number | null;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  taskOutput: number;
  taskActiveMs: number;
  contextPending: boolean;
}

declare global {
  interface Window {
    __agentatlasContextMeter?: ContextMeterSnapshot | null;
    __agentatlasContextMeterListeners?: Set<() => void>;
  }
}

export const useContextMeterStore = defineStore("contextMeter", {
  state: () => ({
    /** 当前快照（null = 无用量，容量条隐藏）。 */
    snapshot: null as ContextMeterSnapshot | null,
    /** 订阅自增：组件 watch 它来在快照变化后重算。 */
    revision: 0,
  }),
  getters: {
    visible(): boolean {
      return Boolean(this.snapshot && this.snapshot.contextTokens);
    },
    percent(): number {
      const s = this.snapshot;
      if (!s || !s.contextTokens) return 0;
      const scale = s.inputBudget ?? s.contextWindow;
      if (!scale) return 0;
      return Math.min(100, (s.contextTokens / scale) * 100);
    },
    fillWidth(): string {
      return this.visible ? `${Math.max(1.5, this.percent)}%` : "0%";
    },
    tone(): "" | "warn" | "danger" {
      if (!this.visible) return "";
      if (this.percent > 92) return "danger";
      if (this.percent > 80) return "warn";
      return "";
    },
    text(): string {
      const s = this.snapshot;
      if (!s || !s.contextTokens) return "";
      const requestText = `↑ ${fmtTokens(s.lastInput)} ↓ ${fmtTokens(s.lastOutput)}`;
      const scale = s.inputBudget ?? s.contextWindow;
      if (!scale) return `上下文 ${fmtTokens(s.contextTokens)} · ${requestText} · 容量未知`;
      const pct = this.percent;
      const warning = s.contextTokens > scale ? " · 超出预算" : "";
      const budgetText = s.inputBudget
        ? `上下文 ${fmtTokens(s.contextTokens)} / ${fmtTokens(s.inputBudget)} · ${pct.toFixed(1)}%`
        : `上下文 ${fmtTokens(s.contextTokens)} / ${fmtTokens(scale)} · ${pct.toFixed(1)}%`;
      return `${budgetText} · ${requestText}${warning}`;
    },
    title(): string {
      const s = this.snapshot;
      if (!s || !s.contextTokens) return "";
      if (!s.contextWindow) return "模型窗口未知；在设置中获取模型列表后显示容量与占比";
      return `模型窗口 ${fmtTokens(s.contextWindow)} · 输出预留 ${fmtTokens(s.outputReserveTokens)} · 安全余量 ${fmtTokens(s.safetyMarginTokens)} · 输出均速按本轮活动时长估算`;
    },
    speedText(): string {
      const s = this.snapshot;
      if (!s || s.contextPending) return "";
      const output = s.taskOutput > 0 ? s.taskOutput : s.lastOutput;
      const speed = fmtTokenRate(output, s.taskActiveMs);
      return speed === "–" ? "" : `输出均速 ${speed}`;
    },
    speedVisible(): boolean {
      return this.speedText !== "";
    },
    cacheText(): string {
      const s = this.snapshot;
      if (!s || !(s.lastInput > 0 && s.lastCache > 0)) return "";
      return `缓存 ${fmtPercent((s.lastCache / s.lastInput) * 100)}`;
    },
    cacheVisible(): boolean {
      return this.cacheText !== "";
    },
    ariaLabel(): string {
      return [this.text, this.speedText, this.cacheText].filter(Boolean).join(" · ");
    },
  },
  actions: {
    /** 接收快照（composer-bar 通过 window 事件推送，跨 bundle/副本实例都能收到）。 */
    apply(snapshot: ContextMeterSnapshot | null): void {
      this.snapshot = snapshot;
      this.revision += 1;
    },
  },
});

/** composer-bar 侧发布的入口：同时更新 window 快照并通知所有已挂载组件。 */
export function publishContextMeter(snapshot: ContextMeterSnapshot | null): void {
  if (typeof window !== "undefined") {
    window.__agentatlasContextMeter = snapshot;
    for (const listener of window.__agentatlasContextMeterListeners ?? []) listener();
  }
}
