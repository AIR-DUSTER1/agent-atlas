/**
 * ============================================================
 * project-view.ts — 项目视图与“不选择项目”语义
 * ============================================================
 * 职责：集中解释侧栏项目筛选值、无项目视图与新建会话的 projectId 映射。
 * 设计立场：
 *  - UI 的 __none__ 只是筛选视图，服务端统一落内部 default（未归属）；
 *  - 所有调用方共用同一映射，避免按钮显示“不选择项目”但新会话仍绑旧项目。
 */

export const PROJECT_VIEW_ALL = "all";
export const PROJECT_VIEW_NONE = "__none__";
export const DEFAULT_PROJECT_ID = "default";

/** 当前项目视图是否只展示未归属会话。 */
export function isNoProjectView(view: string): boolean {
  return view === PROJECT_VIEW_NONE;
}

/** 新建会话时，项目视图 → 服务端 projectId；全部/无项目均落到 default。 */
export function projectIdForNewSession(view: string): string {
  if (view === PROJECT_VIEW_ALL || view === PROJECT_VIEW_NONE) return DEFAULT_PROJECT_ID;
  return view || DEFAULT_PROJECT_ID;
}

/** 侧栏过滤的唯一判定，避免“无项目”被误当成真实项目 id。 */
export function sessionMatchesProjectView(view: string, projectId: string): boolean {
  if (view === PROJECT_VIEW_ALL) return true;
  if (view === PROJECT_VIEW_NONE) return projectId === DEFAULT_PROJECT_ID;
  return projectId === view;
}
