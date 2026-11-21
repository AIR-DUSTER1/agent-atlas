/**
 * ============================================================
 * stores/skills.ts — 技能列表（框架迁移 M4 批次 4.2）
 * ============================================================
 * 职责：技能面板的业务状态与写回（列表、启停、删除、上传导入）。
 * 设计立场：启停写入原文件；导入同名覆盖前由组件先确认。
 */
import { defineStore } from "pinia";
import { api } from "../core/api.js";
import "./pinia.js";

export type SkillFilter = "all" | "enabled" | "disabled";

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  enabled: boolean;
  body: string;
  path?: string;
}

interface SkillListResponse {
  skills?: SkillItem[];
  dir?: string;
}

export const useSkillsStore = defineStore("skills", {
  state: () => ({
    skills: [] as SkillItem[],
    dir: "",
    loaded: false,
  }),
  actions: {
    async refresh(): Promise<SkillItem[]> {
      const data = await api<SkillListResponse>("/api/skills");
      this.skills = data.skills ?? [];
      if (data.dir) this.dir = data.dir;
      this.loaded = true;
      return this.skills;
    },
    /** 启停写回：以服务端返回列表为准；失败向上抛给组件回滚开关。 */
    async setEnabled(id: string, enabled: boolean): Promise<void> {
      const res = await api<{ skill: SkillItem; skills?: SkillItem[] }>(
        `/api/skills/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      this.skills = res.skills ?? this.skills.map((item) => item.id === id ? res.skill : item);
    },
    async remove(id: string): Promise<void> {
      const res = await api<SkillListResponse>(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
      this.skills = res.skills ?? this.skills.filter((item) => item.id !== id);
    },
    /** 上传导入（文本已由组件读好）；返回导入/覆盖计数与最终列表。 */
    async importFiles(files: Array<{ name: string; content: string }>, overwrite: boolean): Promise<{
      imported: number;
      overwritten: number;
    }> {
      const res = await api<SkillListResponse & { imported?: string[]; overwritten?: string[] }>(
        "/api/skills/import",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files, overwrite }),
        },
      );
      this.skills = res.skills ?? [];
      if (res.dir) this.dir = res.dir;
      return { imported: res.imported?.length ?? 0, overwritten: res.overwritten?.length ?? 0 };
    },
  },
});
