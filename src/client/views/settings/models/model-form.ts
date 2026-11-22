/**
 * ============================================================
 * views/model-form.ts — 供应商/模型表单开合的 legacy 分发桥（M4 4.3 起）
 * ============================================================
 * 表单 DOM 与校验已迁往 Vue（models-panel-vue.vue / provider-form-vue.vue +
 * stores/models.ts）；本文件只保留 legacy 调用方（settings.ts 的开合清理）
 * 需要的薄分发：open/close 全部落到 store，Vue 弹窗/面板 watch 状态自渲染。
 * store 经动态 import 进入（本模块在 1:1 过渡树链上，静态图不得出现 pinia）。
 */

async function store() {
  const { useModelsStore } = await import("../../../stores/settings/models/models.js");
  return useModelsStore();
}

/** 打开供应商弹窗（create/edit）；focusModelId 可顺带定位到模型编辑面板。 */
export async function openProviderForm(providerId: string | null, focusModelId?: string): Promise<void> {
  const models = await store();
  models.openProviderForm(providerId);
  if (focusModelId && providerId) models.openModelForm(providerId, focusModelId);
}

export async function closeProviderForm(): Promise<void> {
  (await store()).closeProviderForm();
}

export async function openModelForm(providerId: string, modelId: string): Promise<void> {
  (await store()).openModelForm(providerId, modelId);
}

export async function closeModelForm(): Promise<void> {
  (await store()).closeModelForm();
}
