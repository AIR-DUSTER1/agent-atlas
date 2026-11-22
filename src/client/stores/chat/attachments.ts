/**
 * ============================================================
 * stores/attachments.ts — 待发送附件 chips（框架迁移 M4 批次 4.6）
 * ============================================================
 * 职责：待发送附件的展示状态（chips 列表）。文件选择器弹窗与拖拽上传仍是
 * legacy 命令式实现（与 fs 浏览、上传进度强耦合），本条只接 chips 渲染。
 * 设计立场：附件本体仍存在 core state 的 pendingFiles（发送流程读它），
 * store 持一份镜像用于 Vue 渲染，增删经本 store 同步回 core state。
 */
import { defineStore } from "pinia";
import { state } from "../../core/state.js";
import type { PendingFile } from "../../modules/types.js";
import "../pinia.js";

/** 附件去重键：上传件用 uploadId，文件系统件用路径。 */
export function refKey(f: PendingFile): string {
  return f.kind === "upload" ? `up:${f.uploadId}` : `fs:${f.path}`;
}

export const useAttachmentsStore = defineStore("attachments", {
  state: () => ({
    files: [] as PendingFile[],
  }),
  getters: {
    visible(): boolean {
      return this.files.length > 0;
    },
  },
  actions: {
    /** 从 core state 同步镜像（legacy addPendingFile / 发送后清空都会调用）。 */
    syncFromState(): void {
      this.files = [...state.pendingFiles];
    },
    remove(key: string): void {
      state.pendingFiles = state.pendingFiles.filter((x) => refKey(x) !== key);
      this.syncFromState();
    },
    sourceLabel(file: PendingFile): string {
      return file.kind === "upload" && file.preview ? "图片" : (file.source || "项目文件");
    },
  },
});
