/**
 * vendor/chart.ts — Chart.js 唯一业务入口
 * 业务只依赖本 wrapper；npm 包名由 import map 指向 chart-lib.js。
 */
import { Chart } from "chart.js";
export { Chart };
export type { ChartConfiguration, ChartDataset, ChartOptions, ChartType } from "chart.js";
