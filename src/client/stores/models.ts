/**
 * ============================================================
 * stores/models.ts — 供应商 × 模型管理（框架迁移 M4 批次 4.3）
 * ============================================================
 * 职责：设置页模型管理的业务状态（选中供应商 / 编辑态 / 待提交模型 /
 * 网关模型清单 / 弹窗开合）与查询。
 * 设计立场：
 *  - 这批状态只在设置页内有意义，但统一进 Pinia（不再私建模块级可变量）；
 *  - config 由 applyConfigState / 面板装载双路同步（legacy 消费方仍读 core state）。
 */
import { defineStore } from "pinia";
import { state } from "../core/state.js";
import type { AppConfig, GatewayModel, ModelEntry, ProviderEntry } from "../modules/types.js";
import "./pinia.js";

export interface PendingModel {
  name: string;
  modality: string;
  contextWindow: number | null;
}

export const useModelsStore = defineStore("models", {
  state: () => ({
    config: null as AppConfig | null,
    settingsFocusProviderId: null as string | null,
    selectedProviderId: null as string | null,
    providerFormMode: null as "edit" | "create" | null,
    providerFormOpen: false,
    editingProviderId: null as string | null,
    editingModelId: null as string | null,
    modelFormOpen: false,
    pendingModels: [] as PendingModel[],
    gatewayModels: [] as GatewayModel[],
  }),
  getters: {
    providers(): ProviderEntry[] {
      return this.config?.providers || state.config?.providers || [];
    },
    selectedProvider(): ProviderEntry | null {
      return this.providers.find((provider) => provider.id === this.selectedProviderId) ?? null;
    },
    currentEditingProvider(): ProviderEntry | null {
      return this.editingProviderId
        ? this.providers.find((x) => x.id === this.editingProviderId) ?? null
        : null;
    },
    currentEditingModel(): ModelEntry | null {
      const p = this.currentEditingProvider;
      return p && this.editingModelId ? (p.models || []).find((m) => m.id === this.editingModelId) ?? null : null;
    },
  },
  actions: {
    /** config 同步（applyConfigState / 面板装载都会调用）；镜像回 core state。 */
    syncConfig(config: AppConfig | null): void {
      if (config) {
        this.config = config;
        state.config = config;
      } else {
        this.config = state.config;
      }
    },
    setSettingsFocus(id: string | null): void {
      this.settingsFocusProviderId = id;
    },
    selectProvider(id: string | null): void {
      this.selectedProviderId = id;
      this.settingsFocusProviderId = null;
    },
    ensureSelection(): void {
      const list = this.providers;
      if (this.settingsFocusProviderId && list.some((provider) => provider.id === this.settingsFocusProviderId)) {
        this.selectedProviderId = this.settingsFocusProviderId;
        this.settingsFocusProviderId = null;
      }
      if (!this.selectedProviderId || !list.some((provider) => provider.id === this.selectedProviderId)) {
        this.selectedProviderId = list.find((provider) => provider.active)?.id ?? list[0]?.id ?? null;
      }
    },
    openProviderForm(providerId: string | null): void {
      this.providerFormMode = providerId ? "edit" : "create";
      this.editingProviderId = providerId || null;
      this.editingModelId = null;
      this.modelFormOpen = false;
      if (providerId) this.selectedProviderId = providerId;
      this.gatewayModels = [];
      if (!providerId) this.pendingModels = [];
      this.providerFormOpen = true;
    },
    closeProviderForm(): void {
      this.providerFormOpen = false;
      this.providerFormMode = null;
      this.editingProviderId = null;
      this.editingModelId = null;
      this.modelFormOpen = false;
      this.pendingModels = [];
      this.gatewayModels = [];
    },
    openModelForm(providerId: string, modelId: string): void {
      this.editingProviderId = providerId;
      this.editingModelId = modelId;
      this.modelFormOpen = true;
    },
    closeModelForm(): void {
      this.editingModelId = null;
      this.modelFormOpen = false;
    },
    addPendingModel(entry: PendingModel): void {
      this.pendingModels = [...this.pendingModels, entry];
    },
    removePendingModel(name: string): void {
      this.pendingModels = this.pendingModels.filter((item) => item.name !== name);
    },
    setGatewayModels(models: GatewayModel[]): void {
      this.gatewayModels = models;
    },
  },
});
