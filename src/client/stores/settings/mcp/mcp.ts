/**
 * ============================================================
 * stores/mcp.ts — MCP Servers（框架迁移 M4 批次 4.2）
 * ============================================================
 * 职责：MCP 面板的业务状态与写回（全局开关、服务器目录、启停、
 * 保存、删除、导入、测试连接结果）。
 * 设计立场：开关只改配置；测试反馈按 server id 保留，列表重渲染不丢。
 */
import { defineStore } from "pinia";
import { api } from "../../../core/api.js";
import "../../pinia.js";

export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface McpServerStatus {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  requireApproval: boolean;
  cwd?: string;
  envKeys: string[];
  connected: boolean;
  tools: McpToolInfo[];
  error?: string;
}

export interface McpSaveBody {
  /** 新建时必须携带 id（取自表单标识输入框）；编辑时按路径传。 */
  id?: string;
  name: string;
  command: string;
  args: string[];
  requireApproval: boolean;
}

interface McpStateResponse {
  enabled: boolean;
  servers: McpServerStatus[];
}

/** 最近一次显式「测试连接」的结果；按 server id 保留。 */
export interface McpTestFeedback {
  tone: "ok" | "err" | "pending";
  text: string;
}

export const useMcpStore = defineStore("mcp", {
  state: () => ({
    enabled: true,
    servers: [] as McpServerStatus[],
    loaded: false,
    testFeedback: {} as Record<string, McpTestFeedback>,
  }),
  actions: {
    applyState(data: Partial<McpStateResponse>): void {
      if (typeof data.enabled === "boolean") this.enabled = data.enabled;
      if (Array.isArray(data.servers)) {
        this.servers = data.servers.map((server) => ({
          ...server,
          args: Array.isArray(server.args) ? server.args : [],
          envKeys: Array.isArray(server.envKeys) ? server.envKeys : [],
          tools: Array.isArray(server.tools) ? server.tools : [],
        }));
      }
      this.loaded = true;
    },
    async refresh(): Promise<void> {
      this.applyState(await api<McpStateResponse>("/api/mcp"));
    },
    async toggleServer(server: McpServerStatus, enabled: boolean): Promise<void> {
      const data = await api<McpStateResponse & { server?: McpServerStatus }>(
        `/api/mcp/${encodeURIComponent(server.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      this.applyState(data);
    },
    async toggleGlobal(enabled: boolean): Promise<void> {
      this.applyState(await api<McpStateResponse>("/api/mcp", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }));
    },
    /** 测试连接：返回最新状态；反馈文案由组件写入 testFeedback。 */
    async testServer(server: McpServerStatus): Promise<McpServerStatus> {
      const result = await api<{ status: McpServerStatus }>(
        `/api/mcp/${encodeURIComponent(server.id)}/test`, { method: "POST" });
      const index = this.servers.findIndex((item) => item.id === server.id);
      if (index >= 0) this.servers[index] = result.status;
      return result.status;
    },
    async save(body: McpSaveBody, id?: string): Promise<McpServerStatus> {
      const data = id
        ? await api<McpStateResponse & { server: McpServerStatus }>(`/api/mcp/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await api<McpStateResponse & { server: McpServerStatus }>("/api/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
      delete this.testFeedback[data.server.id]; // 命令/参数变了，旧测试结果不再可信
      this.applyState(data);
      return data.server;
    },
    async remove(id: string): Promise<void> {
      const data = await api<McpStateResponse>(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
      delete this.testFeedback[id];
      this.applyState(data);
    },
    /** 导入 .mcp.json；conflicts 返回给组件确认覆盖。 */
    async importConfig(config: unknown, overwrite: boolean): Promise<{
      imported?: string[];
      overwritten?: string[];
      conflicts?: string[];
    }> {
      const data = await api<McpStateResponse & { imported?: string[]; overwritten?: string[]; conflicts?: string[] }>(
        "/api/mcp/import",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config, overwrite }),
        },
      );
      if (!data.conflicts?.length) this.testFeedback = {}; // 导入可能覆盖已有 command，旧结果一并作废
      this.applyState(data);
      return { imported: data.imported, overwritten: data.overwritten, conflicts: data.conflicts };
    },
  },
});
