/**
 * modules/plugin-registry.ts — 插件目录与真实接入类型
 *
 * 接入类型必须与后端实现一致：
 *   http — 自定义 REST 契约（当前 RAG：ingest / search / reset）
 *   cli  — 本地子进程（当前贝壳 beike CLI）
 *   builtin — 应用内置能力（Browser Use / Computer Use，无外部配置）
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
  /** 无配置时使用的默认启停值；运行时以 /api/plugins 为准。 */
  defaultEnabled: boolean;
}

export const PLUGIN_TRANSPORTS: Record<string, PluginTransport> = {
  builtin: {
    id: "builtin",
    label: "内置能力",
    short: "内置",
    description: "由应用自身实现的本地能力，不需要外部服务地址。",
  },
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
    description: "外部向量库与 embedding 服务。agentatlas 使用自有 HTTP 契约，因此归类为 HTTP 插件，而不是 MCP。",
    manageLabel: "配置 RAG",
    defaultEnabled: true,
  },
  {
    id: "estate",
    icon: "🏠",
    name: "找房数据源（贝壳）",
    transport: "cli",
    runtime: "beike CLI · 本地子进程",
    description: "房源检索、户型图、行情与经纪人能力由贝壳官方 CLI 提供，需要检测安装并保存授权。",
    manageLabel: "管理数据源",
    defaultEnabled: true,
  },
  {
    id: "job",
    icon: "💼",
    name: "求职岗位（job-hunter）",
    transport: "cli",
    runtime: "Python CLI · 四平台采集",
    description: "从 BOSS直聘 / 智联 / 前程无忧 / 猎聘 采集岗位、打分、排除外包并导出 Excel。需要 Python 3.10+ 与 DrissionPage，首次使用要在各平台扫码登录。",
    manageLabel: "管理数据源",
    defaultEnabled: true,
  },
  {
    id: "browser",
    icon: "🌐",
    name: "浏览器操作（Browser Use）",
    transport: "builtin",
    runtime: "Chrome / Edge · 无头浏览器 · 会话隔离",
    description: "让通用 Agent 打开网页、读取真实渲染结果、点击链接、填写表单并滚动页面；画面实时显示在会话右侧，动作仍受权限与高风险审批约束。",
    manageLabel: "查看说明",
    defaultEnabled: false,
  },
  {
    id: "computer",
    icon: "🖥️",
    name: "电脑控制（Computer Use）",
    transport: "builtin",
    runtime: "Windows 桌面 · 本地工具",
    description: "让通用 Agent 截图、点击、输入和滚动本机窗口。默认关闭；开启后仍受会话权限与高风险审批约束。",
    manageLabel: "查看说明",
    defaultEnabled: false,
  },
];

export function pluginTransportMeta(id: string): PluginTransport {
  return PLUGIN_TRANSPORTS[id] ?? PLUGIN_TRANSPORTS.http;
}
