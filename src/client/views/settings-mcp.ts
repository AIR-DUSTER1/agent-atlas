/**
 * ============================================================
 * views/settings-mcp.ts — 设置页「MCP 服务器」分区
 * ============================================================
 * 职责：服务器列表（含连接状态与工具清单）、新增/更新、测试连接、删除。
 * 设计立场：
 *  - 列表显式区分「已连接 / 连接失败」并展示远端工具清单 —— 用户要能判断
 *    "我配的这个 server 到底通了没有、给了我几个工具"；
 *  - 审批开关默认勾选且文案写明「推荐保持开启」：MCP 工具做什么无法预知；
 *  - 参数用空格分隔的文本框（够用且好复制），不做复杂的 args 数组编辑 UI。
 */

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { uiConfirm } from "../ui/dialog.js";

interface McpToolInfo {
  name: string;
  description?: string;
}

interface McpServerStatus {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  requireApproval: boolean;
  connected: boolean;
  tools: McpToolInfo[];
  error?: string;
}

let statusTimer: ReturnType<typeof setTimeout> | undefined;

function mcpStatus(text: string, cls: string): void {
  const el = $("mcp-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  clearTimeout(statusTimer);
  if (text) {
    statusTimer = setTimeout(() => {
      if (el.textContent === text) { el.textContent = ""; el.className = "settings-status"; }
    }, 4000);
  }
}

function renderMcpList(servers: McpServerStatus[]): void {
  const list = $("mcp-list");
  if (!list) return;
  list.innerHTML = "";
  if (!servers.length) {
    const empty = document.createElement("p");
    empty.className = "memories-empty";
    empty.textContent = "还没有配置 MCP 服务器。填一个启动命令即可接入（例如 npx -y @modelcontextprotocol/server-filesystem /tmp）。";
    list.appendChild(empty);
    return;
  }
  for (const s of servers) {
    const row = document.createElement("div");
    row.className = "memory-item";
    row.innerHTML = `
      <div class="m-body">
        <div class="m-key"></div>
        <div class="m-content"></div>
        <div class="m-meta"></div>
      </div>
      <div class="m-actions">
        <button class="ghost-btn small mcp-test" type="button">测试</button>
        <button class="p-del mcp-del" type="button">删除</button>
      </div>`;
    const keyEl = row.querySelector(".m-key");
    if (keyEl) keyEl.textContent = `${s.name}（${s.id}）`;
    const contentEl = row.querySelector(".m-content");
    if (contentEl) contentEl.textContent = `$ ${s.command} ${s.args.join(" ")}`.trim();
    const metaEl = row.querySelector<HTMLElement>(".m-meta");
    if (metaEl) {
      const state = s.connected ? "已连接" : "未连接";
      const tools = s.tools.length ? `${s.tools.length} 个工具：${s.tools.map((t) => t.name).join("、")}` : "尚无工具信息";
      metaEl.textContent = `${state} · ${tools}${s.requireApproval ? " · 需审批" : " · 免审批"}${s.error ? ` · ${s.error}` : ""}`;
      metaEl.style.color = s.connected ? "" : "var(--amber)";
    }
    row.querySelector(".mcp-test")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "…";
      try {
        const res = await api<{ status: McpServerStatus }>(`/api/mcp/${encodeURIComponent(s.id)}/test`, { method: "POST" });
        if (res.status.connected) {
          mcpStatus(`✓ 「${s.name}」连接成功，${res.status.tools.length} 个工具`, "ok");
        } else {
          mcpStatus(`✗ 连接失败：${res.status.error || "未知原因"}`, "err");
        }
        await refreshMcp();
      } catch (err) {
        mcpStatus(`✗ ${(err as Error).message}`, "err");
      } finally {
        btn.disabled = false;
        btn.textContent = "测试";
      }
    });
    row.querySelector(".mcp-del")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!(await uiConfirm(`删除 MCP server「${s.name}」？其工具会从 Agent 中移除。`, {
        title: "删除 MCP server", okText: "删除", danger: true,
      }))) return;
      try {
        const res = await api<{ servers?: McpServerStatus[] }>(`/api/mcp/${encodeURIComponent(s.id)}`, { method: "DELETE" });
        renderMcpList(res.servers || []);
        mcpStatus("已删除", "ok");
      } catch (err) {
        mcpStatus(`✗ ${(err as Error).message}`, "err");
      }
    });
    // 点击载入编辑区
    row.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest("button")) return;
      setInput("mcp-id", s.id);
      setInput("mcp-name", s.name === s.id ? "" : s.name);
      setInput("mcp-command", s.command);
      setInput("mcp-args", s.args.join(" "));
      const cb = $("mcp-approval") as HTMLInputElement | null;
      if (cb) cb.checked = s.requireApproval;
      mcpStatus(`已载入「${s.name}」，修改后点「保存服务器」覆盖`, "");
    });
    list.appendChild(row);
  }
}

function setInput(id: string, value: string): void {
  const el = $(id) as HTMLInputElement | null;
  if (el) el.value = value;
}

function inputValue(id: string): string {
  return (($(id) as HTMLInputElement | null)?.value || "");
}

export async function refreshMcp(): Promise<McpServerStatus[]> {
  const data = await api<{ servers?: McpServerStatus[] }>("/api/mcp");
  renderMcpList(data.servers || []);
  return data.servers || [];
}

export async function saveMcpFromForm(): Promise<void> {
  const id = inputValue("mcp-id").trim();
  const command = inputValue("mcp-command").trim();
  if (!id) { mcpStatus("标识不能为空", "err"); return; }
  if (!command) { mcpStatus("启动命令不能为空", "err"); return; }
  // 参数按空白切分；含空格的路径请用引号包住（这里简单切分，引号内空格不保留）
  const args = inputValue("mcp-args").trim()
    ? inputValue("mcp-args").trim().match(/("[^"]*"|\S+)/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? []
    : [];
  const approval = ($("mcp-approval") as HTMLInputElement | null)?.checked !== false;
  try {
    const res = await api<{ server: { id: string; name?: string }; created?: boolean; servers?: McpServerStatus[] }>(
      "/api/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          name: inputValue("mcp-name").trim() || undefined,
          command,
          args,
          requireApproval: approval,
        }),
      }
    );
    renderMcpList(res.servers || []);
    setInput("mcp-id", "");
    setInput("mcp-name", "");
    setInput("mcp-command", "");
    setInput("mcp-args", "");
    mcpStatus(
      `✓ ${res.created ? "已添加" : "已更新"}「${res.server.name || res.server.id}」—— 到「模型与供应商」下方的工具清单里点「测试」确认连通`,
      "ok"
    );
  } catch (err) {
    mcpStatus(`✗ ${(err as Error).message}`, "err");
  }
}
