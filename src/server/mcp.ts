/**
 * ============================================================
 * mcp.ts — MCP 客户端（JSON-RPC over stdio，零依赖自实现）
 * ============================================================
 * 职责：托管 MCP server 子进程、走 JSON-RPC 2.0 完成 initialize / tools/list /
 * tools/call，并把远端工具包装成本项目的 StructuredTool。
 *
 * 为什么自实现而不引 @modelcontextprotocol/sdk：
 *   AGENTS.md 的运行时依赖白名单里没有它。本项目真正需要的只是「stdio 传输 +
 *   三个方法」，协议本身是 200 行不到的 JSON-RPC —— 引一个 SDK 换来的维护便利
 *   抵不上突破依赖红线的代价。代价是协议演进要自己跟，因此这里刻意只实现
 *   MCP 最稳定的核心子集（2024-11-05 起固定的 initialize / tools.* 形状）。
 *
 * 设计立场：
 *  - **传输**：spawn 子进程，stdin 写一行一条 JSON，stdout 按行读；stderr 只留尾部
 *    供排错（MCP 规定日志走 stderr，绝不能污染 stdout 的协议流）；
 *  - **连接**：懒连接 + 复用。同一 server 的所有工具调用共享一个连接；
 *    断线自动重连一次，仍失败则返回模型可读的中文错误（不抛穿透图）；
 *  - **命名**：工具名统一加 `mcp__<server>__<tool>` 前缀，防与内置工具撞名
 *    （与 ZCode 的 mcp__ 约定一致，用户一眼能看出工具来源）；
 *  - **风险**：MCP 工具做什么无法静态判定 → **默认全部登记审批**
 *    （宁严勿松），可按 server 关闭；只读模式下同样被拒（复用权限矩阵）；
 *  - **退出**：lifecycle 关停时统一杀子进程树（参考 external.ts 的 taskkill 模式）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { readConfig, mergeConfig } from "./config-store.js";
import { killProcessTree } from "./subprocess.js";
import { log } from "./logging.js";
import { writeAudit } from "./audit.js";

/** 单次 JSON-RPC 请求超时（initialize 可能慢，工具调用给足时间） */
const REQUEST_TIMEOUT_MS = 60_000;
/** tools/list 的额外宽限（有的 server 启动时要加载索引） */
const LIST_TIMEOUT_MS = 90_000;
/** 一行 JSON 的最大长度（防对端刷屏把内存吃光） */
const MAX_LINE_BYTES = 4_000_000;
/** stderr 保留尾部字节数 */
const STDERR_KEEP_BYTES = 16_000;
/** 工具结果回给模型的字符上限 */
const TOOL_RESULT_LIMIT = 12_000;
/** 单次调用允许的 server 数量上限 */
const MAX_SERVERS = 20;

export interface McpServerConfig {
  /** 稳定标识（也是工具名前缀）；只允许字母数字下划线短横线 */
  id: string;
  /** 显示名 */
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 是否启用（停用则完全不会 spawn） */
  enabled?: boolean;
  /** 是否把该 server 的工具登记为需审批（默认 true，宁严勿松） */
  requireApproval?: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** 一条活跃连接 */
interface McpConnection {
  server: McpServerConfig;
  child: ChildProcess;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  buffer: string;
  stderrTail: string;
  /** initialize 完成后才有 */
  ready: Promise<void>;
  tools: McpToolInfo[];
  closed: boolean;
}

const connections = new Map<string, McpConnection>();

/* ---------------------------------------------------------------------------
 * 配置读写
 * ------------------------------------------------------------------------- */
function normalizeServer(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const command = typeof r.command === "string" ? r.command.trim() : "";
  if (!id || !command) return null;
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return null;
  return {
    id,
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : id,
    command,
    args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === "string") : [],
    env: r.env && typeof r.env === "object"
      ? Object.fromEntries(Object.entries(r.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
      : {},
    cwd: typeof r.cwd === "string" && r.cwd.trim() ? r.cwd.trim() : undefined,
    enabled: r.enabled !== false,
    requireApproval: r.requireApproval !== false,
  };
}

export async function listMcpServers(): Promise<McpServerConfig[]> {
  const config = await readConfig();
  const raw = config.mcpServers;
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeServer).filter((s): s is McpServerConfig => s !== null).slice(0, MAX_SERVERS);
}

async function persistServers(next: McpServerConfig[]): Promise<void> {
  await mergeConfig({ mcpServers: next });
}

export async function saveMcpServer(input: unknown): Promise<{ server: McpServerConfig; created: boolean }> {
  const parsed = normalizeServer(input);
  if (!parsed) throw new Error("MCP server 配置不完整：id 与 command 必填，且 id 只能含字母数字下划线短横线");
  const all = await listMcpServers();
  const idx = all.findIndex((s) => s.id === parsed.id);
  let created = false;
  if (idx >= 0) all[idx] = parsed;
  else {
    if (all.length >= MAX_SERVERS) throw new Error(`MCP server 数量已达上限 ${MAX_SERVERS}`);
    all.push(parsed);
    created = true;
  }
  await persistServers(all);
  // 配置变了 → 断开旧连接，下次调用按新配置重连
  await disconnect(parsed.id);
  void writeAudit("mcp.server_saved", { id: parsed.id, command: parsed.command, created });
  return { server: parsed, created };
}

export async function deleteMcpServer(id: string): Promise<{ removed: boolean; servers: McpServerConfig[] }> {
  const all = await listMcpServers();
  const next = all.filter((s) => s.id !== id);
  const removed = next.length !== all.length;
  if (removed) {
    await persistServers(next);
    await disconnect(id);
    void writeAudit("mcp.server_deleted", { id });
  }
  return { removed, servers: next };
}

/* ---------------------------------------------------------------------------
 * 连接管理
 * ------------------------------------------------------------------------- */
/**
 * 启动一个 MCP server 并完成 initialize 握手。
 * 失败时抛中文错误（调用方负责转成模型可读文本）。
 */
async function connect(server: McpServerConfig): Promise<McpConnection> {
  const child = spawn(server.command, server.args ?? [], {
    cwd: server.cwd,
    env: { ...process.env, ...(server.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // 非 Windows 建独立进程组，便于整组强杀
    detached: process.platform !== "win32",
  });

  const conn: McpConnection = {
    server,
    child,
    nextId: 1,
    pending: new Map(),
    buffer: "",
    stderrTail: "",
    ready: Promise.resolve(),
    tools: [],
    closed: false,
  };

  // stdout：按行切 JSON（MCP stdio 传输是「一行一条消息」）
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    conn.buffer += chunk;
    if (conn.buffer.length > MAX_LINE_BYTES) {
      // 对端刷屏：丢掉缓冲并断开（协议已不可信）
      conn.buffer = "";
      killProcessTree(child.pid ?? 0);
      failAll(conn, new Error("MCP server 输出超过长度上限，连接已终止"));
      return;
    }
    let idx: number;
    while ((idx = conn.buffer.indexOf("\n")) >= 0) {
      const line = conn.buffer.slice(0, idx).trim();
      conn.buffer = conn.buffer.slice(idx + 1);
      if (!line) continue;
      handleLine(conn, line);
    }
  });

  // stderr：只留尾部（MCP 规定日志走这里）
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    conn.stderrTail = (conn.stderrTail + chunk).slice(-STDERR_KEEP_BYTES);
  });

  child.on("close", (code) => {
    conn.closed = true;
    // 只删「自己这一条」：重连场景下旧的 close 回调可能晚于新连接注册，
    // 无条件按 server.id 删除会把刚建立的新连接从表里抹掉 —— 那条连接
    // 从此再无引用，disconnectAll 也碰不到它（句柄泄漏的真正原因）。
    if (connections.get(server.id) === conn) connections.delete(server.id);
    failAll(conn, new Error(
      `MCP server「${server.name ?? server.id}」已退出（退出码 ${code ?? "未知"}）` +
      (conn.stderrTail ? `\nstderr 尾部：\n${conn.stderrTail.slice(-800)}` : "")
    ));
  });

  child.on("error", (err) => {
    conn.closed = true;
    if (connections.get(server.id) === conn) connections.delete(server.id);
    failAll(conn, new Error(`无法启动 MCP server「${server.id}」：${err.message}`));
  });

  connections.set(server.id, conn);

  // initialize 握手（MCP 规定的第一步）
  conn.ready = (async () => {
    await request(conn, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "langgraph-agent-workbench", version: "1.0.0" },
    }, LIST_TIMEOUT_MS);
    // 握手后按规范发一条 notification（无 id，不需要回复）
    sendNotification(conn, "notifications/initialized", {});
  })();

  return conn;
}

function handleLine(conn: McpConnection, line: string): void {
  let msg: JsonRpcResponse;
  try {
    msg = JSON.parse(line) as JsonRpcResponse;
  } catch {
    // 非 JSON 行：可能是对端往 stdout 打了日志（违反协议）—— 忽略但记一笔
    log("warn", "mcp_stdout_non_json", { server: conn.server.id, sample: line.slice(0, 200) });
    return;
  }
  if (msg.id == null) return; // notification / 服务端日志，本项目不消费
  const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
  const entry = conn.pending.get(id);
  if (!entry) return;
  conn.pending.delete(id);
  clearTimeout(entry.timer);
  if (msg.error) {
    entry.reject(new Error(`MCP 错误 ${msg.error.code ?? ""}：${msg.error.message ?? "未知错误"}`));
    return;
  }
  entry.resolve(msg.result);
}

function failAll(conn: McpConnection, err: Error): void {
  for (const [, entry] of conn.pending) {
    clearTimeout(entry.timer);
    entry.reject(err);
  }
  conn.pending.clear();
}

function writeLine(conn: McpConnection, payload: unknown): void {
  if (conn.closed || !conn.child.stdin?.writable) {
    throw new Error(`MCP server「${conn.server.id}」连接已关闭`);
  }
  conn.child.stdin.write(JSON.stringify(payload) + "\n");
}

function request(conn: McpConnection, method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const id = conn.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`MCP 请求超时（${method}，${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    conn.pending.set(id, { resolve, reject, timer });
    try {
      writeLine(conn, { jsonrpc: "2.0", id, method, params });
    } catch (err) {
      clearTimeout(timer);
      conn.pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function sendNotification(conn: McpConnection, method: string, params: unknown): void {
  try {
    writeLine(conn, { jsonrpc: "2.0", method, params });
  } catch { /* 通知失败不致命（对端可能已不支持） */ }
}

/** 取（或建立）连接；同 id 复用 */
async function ensureConnection(server: McpServerConfig): Promise<McpConnection> {
  const existing = connections.get(server.id);
  if (existing && !existing.closed) {
    await existing.ready;
    if (!existing.tools.length) existing.tools = await listToolsOn(existing);
    return existing;
  }
  const conn = await connect(server);
  await conn.ready;
  conn.tools = await listToolsOn(conn);
  return conn;
}

async function listToolsOn(conn: McpConnection): Promise<McpToolInfo[]> {
  const result = await request(conn, "tools/list", {}, LIST_TIMEOUT_MS) as {
    tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
  };
  const tools: McpToolInfo[] = [];
  for (const t of result?.tools ?? []) {
    if (!t?.name) continue;
    tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
  }
  return tools;
}

export async function disconnect(id: string): Promise<void> {
  const conn = connections.get(id);
  if (!conn) return;
  connections.delete(id);
  conn.closed = true;
  failAll(conn, new Error("连接已断开"));
  // 先关 stdin：MCP server 通常据此判断「客户端走了」并自行退出；
  // 再杀进程树兜底。
  try { conn.child.stdin?.end(); } catch { /* 已关闭 */ }
  const pid = conn.child.pid;
  if (pid) killProcessTree(pid);
  // 关键：等 close 事件真正到达。taskkill 只是「发出了杀」，Node 侧的
  // ChildProcess 句柄要等 close 才释放 —— 不等的话测试进程会被这个句柄
  // 绊住不退出（node:test 多文件同进程时尤其明显：整轮跑完却一直挂着）。
  await new Promise<void>((resolve) => {
    if (conn.child.exitCode !== null || conn.child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(resolve, 3_000); // 兜底：极端情况下不等太久
    conn.child.once("close", () => { clearTimeout(timer); resolve(); });
  });
  // 显式销毁 stdio 管道并 unref 子进程句柄。
  // 为什么必须这么做：taskkill /T 杀掉进程后，Node 侧的 ChildProcess 句柄
  // 仍持有 stdout/stderr 的 Socket，事件循环会被它们绊住 —— 服务进程没事
  // （本来就要常驻），但测试进程会「跑完全部用例却一直不退出」。
  try { conn.child.stdout?.destroy(); } catch { /* 已销毁 */ }
  try { conn.child.stderr?.destroy(); } catch { /* 已销毁 */ }
  try { conn.child.stdin?.destroy(); } catch { /* 已销毁 */ }
  conn.child.removeAllListeners();
  conn.child.unref();
}

/** lifecycle 关停时统一清理全部 MCP 子进程 */
export async function disconnectAll(): Promise<void> {
  const ids = [...connections.keys()];
  await Promise.all(ids.map((id) => disconnect(id)));
}

/* ---------------------------------------------------------------------------
 * 对外状态（设置页用）
 * ------------------------------------------------------------------------- */
export interface McpServerStatus {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  requireApproval: boolean;
  /** 当前是否持有活跃连接 */
  connected: boolean;
  /** 已知工具（连接过才会有；未连接返回空数组） */
  tools: McpToolInfo[];
  /** 最近一次连接失败的原因（成功则为空） */
  error?: string;
}

export async function listMcpStatus(): Promise<McpServerStatus[]> {
  const servers = await listMcpServers();
  return servers.map((s) => {
    const conn = connections.get(s.id);
    return {
      id: s.id,
      name: s.name ?? s.id,
      command: s.command,
      args: s.args ?? [],
      enabled: s.enabled !== false,
      requireApproval: s.requireApproval !== false,
      connected: Boolean(conn && !conn.closed),
      tools: conn?.tools ?? [],
      error: conn?.closed ? "连接已断开" : undefined,
    };
  });
}

/** 显式「测试连接」：连一次、列工具、保留连接（设置页按钮） */
export async function testMcpServer(id: string): Promise<McpServerStatus> {
  const servers = await listMcpServers();
  const server = servers.find((s) => s.id === id);
  if (!server) throw new Error(`MCP server「${id}」不存在`);
  await disconnect(id);
  try {
    const conn = await ensureConnection(server);
    return {
      id: server.id,
      name: server.name ?? server.id,
      command: server.command,
      args: server.args ?? [],
      enabled: true,
      requireApproval: server.requireApproval !== false,
      connected: !conn.closed,
      tools: conn.tools,
    };
  } catch (err) {
    return {
      id: server.id,
      name: server.name ?? server.id,
      command: server.command,
      args: server.args ?? [],
      enabled: true,
      requireApproval: server.requireApproval !== false,
      connected: false,
      tools: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ---------------------------------------------------------------------------
 * 供 mcp-tools.ts 使用的调用原语（协议细节不外泄）
 * ------------------------------------------------------------------------- */
/**
 * 调用远端工具并按文本返回。断线自动重连重试一次 ——
 * MCP server 被外部杀掉是常见情况，静默失败会让模型以为工具不存在。
 */
export async function callMcpTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError: boolean }> {
  const attempt = async (conn: McpConnection): Promise<unknown> =>
    request(conn, "tools/call", { name: toolName, arguments: args });
  try {
    const conn = await ensureConnection(server);
    return toResult(await attempt(conn));
  } catch (err) {
    try {
      await disconnect(server.id);
      const fresh = await ensureConnection(server);
      return toResult(await attempt(fresh));
    } catch (retryErr) {
      const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
      log("warn", "mcp_tool_call_failed", { server: server.id, tool: toolName, message });
      return { text: `MCP 工具调用失败（已重连重试）：${message}`, isError: true };
    }
  }
}

/** tools/call 结果 → 模型可读文本 */
function toResult(result: unknown): { text: string; isError: boolean } {
  const r = result as {
    content?: Array<{ type?: string; text?: string; mimeType?: string }>;
    isError?: boolean;
  } | null;
  const parts: string[] = [];
  for (const item of r?.content ?? []) {
    if (typeof item?.text === "string") parts.push(item.text);
    else if (item?.type === "image") parts.push(`[图片内容 ${item.mimeType ?? ""}]`);
    else if (item?.type === "resource") parts.push(`[资源 ${item.mimeType ?? ""}]`);
    else parts.push(`[${item?.type ?? "未知内容"}]`);
  }
  if (!parts.length && result != null) {
    try { parts.push(JSON.stringify(result)); } catch { parts.push(String(result)); }
  }
  return { text: parts.join("\n"), isError: r?.isError === true };
}

/** 确保连接就绪并返回其工具列表（供 mcp-tools 装配时使用） */
export async function ensureServerTools(server: McpServerConfig): Promise<{ tools: McpToolInfo[] }> {
  const conn = await ensureConnection(server);
  return { tools: conn.tools };
}

/** 连接是否仍然活着（避免对已关闭连接发请求） */
export function isConnected(id: string): boolean {
  const conn = connections.get(id);
  return Boolean(conn && !conn.closed);
}
