/**
 * ============================================================
 * mcp-tools.ts — MCP 工具 → 本项目 StructuredTool 的包装层
 * ============================================================
 * 职责：把 mcp.ts 拿到的远端工具描述转换成 LangChain 工具；负责参数 schema 的
 * 宽松映射、结果文本化、断线重连与审批文案生成。
 * 设计立场：
 *  - 与 mcp.ts（连接与协议）分离：那边只管「怎么连、怎么发请求」，
 *    这里只管「怎么变成模型能调用的工具」；
 *  - 参数 schema 故意宽松（z.unknown().optional() + passthrough）：
 *    远端 server 才是参数权威校验者，本地过严会挡掉合法的宽松调用；
 *  - 名称统一 mcp__<server>__<tool>，与内置工具不会撞车。
 */

import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { log } from "./logging.js";
import {
  callMcpTool, ensureServerTools, listMcpServers, listMcpStatus,
  type McpToolInfo,
} from "./mcp.js";

/** 工具结果回给模型的字符上限 */
const TOOL_RESULT_LIMIT = 12_000;

/* ---------------------------------------------------------------------------
 * 工具包装：MCP tool → StructuredTool
 * ------------------------------------------------------------------------- */
/** 模型里的工具名：mcp__<server>__<tool>（双下划线分隔，避免与内置名撞车） */
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

/** 把 MCP 的 inputSchema（JSON Schema）压成「宽松对象」交给 zod */
function schemaFor(inputSchema: unknown): z.ZodType<Record<string, unknown>> {
  const props = (inputSchema as { properties?: Record<string, { description?: string }> } | null)?.properties;
  if (!props || !Object.keys(props).length) {
    // 无参数工具：接受任意对象（远端才是参数权威校验者）
    return z.record(z.string(), z.unknown());
  }
  // 逐字段 optional：类型信息只用于提示，不做严格校验 ——
  // 远端 server 才是参数的权威校验者，本地过严会挡掉合法的宽松调用。
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, spec] of Object.entries(props)) {
    const desc = spec?.description ? `（${spec.description}）` : "";
    shape[key] = z.unknown().optional().describe(`${key}${desc}`);
  }
  return z.object(shape).passthrough() as unknown as z.ZodType<Record<string, unknown>>;
}

/**
 * 按配置把全部启用的 MCP server 的工具包装成本项目的工具。
 * 连不上的 server 静默跳过（记日志）—— 一个 MCP 挂掉不该让整个 Agent 起不来。
 */
export async function loadMcpTools(): Promise<StructuredToolInterface[]> {
  const servers = (await listMcpServers()).filter((s) => s.enabled !== false);
  const out: StructuredToolInterface[] = [];
  for (const server of servers) {
    // 主动连接（不依赖「之前刚好连过」）：连不上就跳过这个 server
    let tools: McpToolInfo[];
    try {
      tools = (await ensureServerTools(server)).tools;
    } catch (err) {
      log("warn", "mcp_tools_unavailable", {
        server: server.id,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!tools.length) continue; // 连上了但没有工具
    for (const info of tools) {
      const name = mcpToolName(server.id, info.name);
      const display = `${server.name ?? server.id} · ${info.name}`;
      out.push(tool(
        async (args) => {
          const { text, isError } = await callMcpTool(server, info.name, (args ?? {}) as Record<string, unknown>);
          const clipped = text.length > TOOL_RESULT_LIMIT
            ? `${text.slice(0, TOOL_RESULT_LIMIT)}
…（结果过长已截断）`
            : text;
          return isError ? JSON.stringify({ error: clipped }) : clipped;
        },
        {
          name,
          description: `${display}
${info.description ?? ""}
（来自 MCP server「${server.name ?? server.id}」）`,
          schema: schemaFor(info.inputSchema),
        }
      ) as unknown as StructuredToolInterface);
    }
  }
  return out;
}

/**
 * 生成审批文案表：MCP 工具默认全部登记审批
 * （无法静态判定风险，宁严勿松）；可按 server 关闭。
 */
export async function mcpApprovalDescriptions(): Promise<Record<string, (args: Record<string, unknown>) => string>> {
  const out: Record<string, (args: Record<string, unknown>) => string> = {};
  // 与 loadMcpTools 一样主动连接：审批表要覆盖「配置里启用但当前未连接」的 server，
  // 否则服务刚启动时 MCP 工具会被当成「未登记审批」直接执行 —— 这是安全漏洞。
  for (const server of (await listMcpServers()).filter((s) => s.enabled !== false)) {
    if (server.requireApproval === false) continue;
    let tools: McpToolInfo[];
    try {
      tools = (await ensureServerTools(server)).tools;
    } catch {
      continue; // 连不上的 server 没有工具可登记
    }
    const status = { id: server.id, name: server.name ?? server.id };
    for (const t of tools) {
      const name = mcpToolName(status.id, t.name);
      out[name] = (args) => {
        let preview: string;
        try {
          const s = JSON.stringify(args);
          preview = s.length > 120 ? `${s.slice(0, 120)}…` : s;
        } catch { preview = "（参数无法序列化）"; }
        return `调用 MCP 工具「${status.name} · ${t.name}」：${preview}（外部 MCP server 执行，内容不可预知）`;
      };
    }
  }
  return out;
}
