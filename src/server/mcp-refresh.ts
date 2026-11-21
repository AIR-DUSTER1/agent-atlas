/**
 * ============================================================
 * mcp-refresh.ts — MCP 工具重载（框架迁移 M2 批次 10 从 dispatch.ts 迁出）
 * ============================================================
 * 每次增删 MCP server / 配置变更后调用；单个 server 失败不阻断其它 server。
 * index.ts 启动路径与 routes/mcp.ts 的写路由共用同一实例逻辑。
 */
import { loadMcpTools, mcpApprovalDescriptions } from "./mcp-tools.js";
import { setExternalTools } from "../agent/general.js";
import { bumpConfigVersion } from "./sessions.js";
import { log } from "./logging.js";

export async function refreshMcpTools(bumpVersion = false): Promise<void> {
  try {
    const [tools, approvals] = await Promise.all([loadMcpTools(), mcpApprovalDescriptions()]);
    setExternalTools(tools, approvals);
    if (bumpVersion) bumpConfigVersion();
    log("info", "mcp_tools_loaded", { count: tools.length });
  } catch (err) {
    // MCP 是增强能力：加载失败只降级，不影响内置工具
    log("warn", "mcp_tools_load_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    setExternalTools([], {});
    if (bumpVersion) bumpConfigVersion();
  }
}
