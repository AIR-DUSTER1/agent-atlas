/**
 * ============================================================
 * stores/stats.ts — 使用统计（框架迁移 M4 批次 4.2）
 * ============================================================
 * 职责：一次请求同时取 7/30 天数据、当前选中区间与加载/错误态。
 * 设计立场：
 *  - 切换区间是纯本地重绘，不再请求（服务端一次给全区间）；
 *  - 请求带硬超时，序号防止旧响应覆盖新状态；
 *  - 图表实例由 views/stats/charts.ts 管理（Canvas 只能命令式），本 store 只存数据。
 */
import { defineStore } from "pinia";
import { api } from "../core/api.js";
import type { StatsRange, StatsResult } from "../modules/types.js";

/** 区间固定展示顺序：7 天在前、30 天在后。 */
export const RANGE_ORDER = ["7d", "30d"];
const REQUEST_TIMEOUT_MS = 8_000;

let requestSeq = 0;

export const useStatsStore = defineStore("stats", {
  state: () => ({
    data: null as StatsResult | null,
    activeRangeId: "7d",
    loading: false,
    /** 错误文案（非空时页面展示降级区）。 */
    error: "",
    /** 外部要求重载的序号（切回分区时壳会 bump；组件 watch 它重新拉取）。 */
    refreshTick: 0,
  }),
  getters: {
    /** 按 RANGE_ORDER 排序的区间卡数据。 */
    ranges(): StatsRange[] {
      const ranges = this.data?.ranges ?? [];
      return [...ranges].sort(
        (left, right) => RANGE_ORDER.indexOf(left.id) - RANGE_ORDER.indexOf(right.id),
      );
    },
    activeRange(): StatsRange | null {
      return this.data?.ranges.find((range) => range.id === this.activeRangeId) ?? null;
    },
    updatedText(): string {
      const generatedAt = this.data?.generatedAt;
      return Number.isFinite(generatedAt) ? `更新于 ${new Date(generatedAt as number).toLocaleString()}` : "已更新";
    },
  },
  actions: {
    selectRange(id: string): void {
      if (this.activeRangeId === id) return;
      this.activeRangeId = id;
    },
    /** 拉取统计；失败写入 error（组件展示降级区）。 */
    async load(): Promise<void> {
      const seq = ++requestSeq;
      this.loading = true;
      this.error = "";
      try {
        const data = await api<StatsResult>("/api/stats", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (seq !== requestSeq) return;
        if (!data.ranges.length) {
          this.data = null;
          this.error = "统计接口未返回时间区间";
          return;
        }
        this.data = data;
        if (!data.ranges.some((range) => range.id === this.activeRangeId)) {
          this.activeRangeId = data.ranges[0]?.id ?? "7d";
        }
      } catch (err) {
        if (seq !== requestSeq) return;
        this.data = null;
        this.error = `加载失败：${(err as Error).message}`;
      } finally {
        if (seq === requestSeq) this.loading = false;
      }
    },
  },
});
