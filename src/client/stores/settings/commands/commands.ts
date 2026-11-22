/**
 * ============================================================
 * stores/commands.ts — 自定义命令列表（框架迁移 M4 批次 4.1）
 * ============================================================
 * 职责：命令页（Vue 化后）的命令列表唯一来源与增删改写回。
 * 设计立场：
 *  - 命令只是提示词模板；保存/删除后必须立即重拉 loadUserCommands，
 *    斜杠菜单缓存无需刷新页面（与迁移前 h() 版行为一致）；
 *  - 服务端返回全量列表时以服务端为准，避免本地推导顺序漂移。
 */
import { defineStore } from "pinia";
import { api } from "../../../core/api.js";
import { loadUserCommands, type UserCommandItem } from "../../../composer/menu.js";
// 面板装载入口（settings.ts）会在组件外 useStore：同 stores/plugins.ts，先激活共享实例。
import "../../pinia.js";

export interface CommandPayload {
  name: string;
  title?: string;
  description?: string;
  template: string;
}

export const useCommandsStore = defineStore("commands", {
  state: () => ({
    commands: [] as UserCommandItem[],
  }),
  actions: {
    /** 重拉列表并同步斜杠菜单缓存；返回最新列表。 */
    async refresh(): Promise<UserCommandItem[]> {
      this.commands = await loadUserCommands();
      return this.commands;
    },
    /** 创建（无 originalName）或改名保存；返回服务端确认的命令。 */
    async save(payload: CommandPayload, originalName?: string): Promise<UserCommandItem> {
      const wasEditing = Boolean(originalName);
      const res = await api<CommandSaveResult>(
        wasEditing ? `/api/commands/${encodeURIComponent(originalName ?? "")}` : "/api/commands",
        {
          method: wasEditing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      this.commands = res.commands ?? (wasEditing
        ? this.commands.map((command) => command.name === originalName ? res.command : command)
        : [...this.commands, res.command]);
      await this.refresh();
      return res.command;
    },
    /** 删除命令；返回是否确认删除（服务端 404 等错误向上抛给组件提示）。 */
    async remove(name: string): Promise<void> {
      const res = await api<CommandListResult>(`/api/commands/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      this.commands = res.commands ?? this.commands.filter((item) => item.name !== name);
      await this.refresh();
    },
  },
});

interface CommandSaveResult {
  command: UserCommandItem;
  created?: boolean;
  commands?: UserCommandItem[];
}

interface CommandListResult {
  commands?: UserCommandItem[];
}
