/**
 * ============================================================
 * stores/tracing.ts — LangSmith 链路追踪配置（框架迁移 M4 批次 4.2）
 * ============================================================
 * 职责：追踪快照的读取与写回（backend / project / endpoint / 掩码 Key）。
 * 设计立场：
 *  - 默认 off；是否出网由界面警示与后端开关共同表达，store 不做静默修补；
 *  - Key 输入永不回填明文：快照只给 keyMasked，保存时留空表示保持；
 *  - 服务端是终审方，本地不做 endpoint / Key 语义校验。
 */
import { defineStore } from "pinia";
import { api } from "../../../core/api.js";
import type { TraceSettingsSnapshot } from "../../../modules/types-api.js";
import "../../pinia.js";

/** 保存载荷：apiKey 缺省 = 保持当前 Key 不变。 */
export interface TraceSavePayload {
  backend: TraceSettingsSnapshot["backend"];
  project: string;
  endpoint: string;
  agentId: string;
  agentEnvironment: string;
  anonymize: boolean;
  apiKey?: string;
}

export const useTracingStore = defineStore("tracing", {
  state: () => ({
    /** 服务端脱敏快照（null = 尚未读取）。 */
    snapshot: null as TraceSettingsSnapshot | null,
  }),
  actions: {
    async load(): Promise<TraceSettingsSnapshot> {
      const snapshot = await api<TraceSettingsSnapshot>("/api/tracing");
      this.snapshot = snapshot;
      return snapshot;
    },
    async save(payload: TraceSavePayload): Promise<TraceSettingsSnapshot> {
      const snapshot = await api<TraceSettingsSnapshot>("/api/tracing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      this.snapshot = snapshot;
      return snapshot;
    },
  },
});
