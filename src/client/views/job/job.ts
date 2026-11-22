/**
 * views/job.ts — 求职面板分发桥（M4 批次 4.4 起）
 * ============================================================
 * 面板（环境检查 / 数据目录 / 平台登录 / 自检）已迁往 Vue
 * （job-panel-vue.vue + stores/job.ts）；本文件保留 legacy 侧职责：
 *  1. 弹窗开合入口 openJob / closeJob（插件面板「查看求职状态」与 Esc 链调用）；
 *  2. 开合状态钩子（main.ts 的 isJobOpen 分流）。
 * store 经动态 import 进入（本模块在 1:1 过渡树链上）。
 */

/** 开合状态钩子：Vue 组件挂载时注册，卸载时注销。 */
let jobOpenHook: (() => boolean) | null = null;
let jobCloseHook: (() => void) | null = null;

export function registerJobOpenHook(hook: (() => boolean) | null): void {
  jobOpenHook = hook;
}

export function registerJobCloseHook(hook: (() => void) | null): void {
  jobCloseHook = hook;
}

export function isJobOpen(): boolean {
  return jobOpenHook?.() ?? false;
}

/** 打开求职弹窗：挂载组件（幂等）并置开合态。 */
export async function openJob(): Promise<void> {
  void import("./job-panel-vue.js")
    .then((m) => m.mountJobPanelVue())
    .catch(() => {});
  const { useJobStore } = await import("../../stores/job/job.js");
  useJobStore().jobOpen = true;
}

export function closeJob(): void {
  void import("../../stores/job/job.js")
    .then(({ useJobStore }) => { useJobStore().jobOpen = false; })
    .catch(() => {});
}
