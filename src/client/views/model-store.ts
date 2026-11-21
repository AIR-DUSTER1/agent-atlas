/**
 * ============================================================
 * views/model-store.ts — 模型管理编辑态的 legacy 分发桥（M4 4.3 起）
 * ============================================================
 * 编辑态已全部迁往 stores/models.ts（Pinia）；本文件只保留 legacy 调用方
 * （settings.ts 的 openSettings 深链定位）需要的薄分发。
 * store 经动态 import 进入（1:1 过渡树静态图不得出现 pinia）。
 */

/** openSettings 深链：菜单「编辑」进来时高亮定位供应商（面板挂载后消费）。 */
export async function setSettingsFocus(id: string | null): Promise<void> {
  const { useModelsStore } = await import("../stores/models.js");
  useModelsStore().setSettingsFocus(id);
}
