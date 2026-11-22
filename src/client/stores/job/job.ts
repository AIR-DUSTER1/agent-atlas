/**
 * ============================================================
 * stores/job.ts — 求职数据源（框架迁移 M4 批次 4.4）
 * ============================================================
 * 职责：求职面板的业务状态与写回（环境探测 / 数据目录 / 平台登录 / 自检诊断）。
 * 设计立场：面板只管理浏览器、数据目录和平台登录；采集流程由求职 Agent 内部执行。
 */
import { defineStore } from "pinia";
import { api } from "../../core/api.js";
import { state } from "../../core/state.js";
import type { JobDiagnosisResponse, JobState } from "../../modules/types.js";
import "../pinia.js";

export interface JobPlatformButton {
  id: string;
  label: string;
}

export const JOB_PLATFORMS: JobPlatformButton[] = [
  { id: "boss", label: "BOSS直聘" },
  { id: "zhilian", label: "智联招聘" },
  { id: "job51", label: "前程无忧" },
  { id: "liepin", label: "猎聘" },
];

export const useJobStore = defineStore("job", {
  state: () => ({
    /** 求职弹窗开合（mount 容器的 hidden 类由组件 watch 代管）。 */
    jobOpen: false,
    job: null as JobState | null,
    /** 登录中的平台 id（按钮置忙与文案切换）。 */
    loggingInPlatform: null as string | null,
    saving: false,
    doctorRunning: false,
    diagnosing: null as null | "plain" | "apply",
    statusText: "",
    statusKind: "" as "ok" | "err" | "",
    doctorOutput: "",
    dataDirInput: "",
  }),
  actions: {
    setStatus(message: string, kind: "ok" | "err" | "" = ""): void {
      this.statusText = message;
      this.statusKind = kind;
    },
    async load(): Promise<void> {
      const status = await api<JobState>("/api/job");
      this.job = status;
      state.job = status;
      if (!this.dataDirInput) this.dataDirInput = status.dataDir || "";
    },
    async save(): Promise<void> {
      const status = await api<JobState>("/api/job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataDir: this.dataDirInput }),
      });
      this.job = status;
      state.job = status;
    },
    async login(platform: string): Promise<{ ok: boolean; summary: string }> {
      this.loggingInPlatform = platform;
      try {
        const result = await api<{ ok: boolean; summary: string }>("/api/job/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform }),
        });
        await this.load();
        return result;
      } finally {
        this.loggingInPlatform = null;
      }
    },
    async doctor(): Promise<{ ok: boolean; text: string }> {
      this.doctorRunning = true;
      try {
        const result = await api<{ ok: boolean; text: string }>("/api/job/doctor", { method: "POST" });
        this.doctorOutput = result.text || "（自检没有输出）";
        return result;
      } finally {
        this.doctorRunning = false;
      }
    },
    async diagnose(apply: boolean): Promise<JobDiagnosisResponse> {
      this.diagnosing = apply ? "apply" : "plain";
      try {
        const result = await api<JobDiagnosisResponse>("/api/job/diagnose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apply }),
        });
        this.doctorOutput = result.output || result.summary || "（诊断没有输出）";
        return result;
      } finally {
        this.diagnosing = null;
      }
    },
  },
});
