/**
 * modules/plugin-registry.ts — 插件目录与真实接入类型
 *
 * 接入类型必须与后端实现一致：
 *   http — 自定义 REST 契约（当前 RAG：ingest / search / reset）
 *   cli  — 本地子进程（当前贝壳 beike CLI）
 *   mcp  — 标准 MCP server（目录预留；当前 RAG 不是 MCP）
 */

export interface PluginTransport {
  id: string;
  label: string;
  short: string;
  description: string;
}

export interface BuiltinPlugin {
  id: string;
  icon: string;
  name: string;
  transport: string;
  runtime: string;
  description: string;
  manageLabel: string;
}

export const PLUGIN_TRANSPORTS: Record<string, PluginTransport> = {
  http: {
    id: "http",
    label: "HTTP 插件",
    short: "HTTP",
    description: "使用插件自己的 HTTP 契约与配置表单，不套用 MCP。",
  },
  cli: {
    id: "cli",
    label: "CLI 插件",
    short: "CLI",
    description: "由本地命令行程序提供能力，需要检测、安装与鉴权。",
  },
  mcp: {
    id: "mcp",
    label: "MCP 插件",
    short: "MCP",
    description: "通过标准 MCP server 接入，使用 server 启动命令或远端地址管理。",
  },
};

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  {
    id: "rag",
    icon: "📚",
    name: "知识库（RAG）",
    transport: "http",
    runtime: "REST /ingest · /search · /reset",
    description: "外部向量库与 embedding 服务。agent-tools 使用自有 HTTP 契约，因此归类为 HTTP 插件，而不是 MCP。",
    manageLabel: "配置 RAG",
  },
  {
    id: "estate",
    icon: "🏠",
    name: "找房数据源（贝壳）",
    transport: "cli",
    runtime: "beike CLI · 本地子进程",
    description: "房源检索、户型图、行情与经纪人能力由贝壳官方 CLI 提供，需要检测安装并保存授权。",
    manageLabel: "管理数据源",
  },
];

export function pluginTransportMeta(id: string): PluginTransport {
  return PLUGIN_TRANSPORTS[id] ?? PLUGIN_TRANSPORTS.http;
}
