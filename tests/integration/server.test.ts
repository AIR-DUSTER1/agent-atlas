/**
 * tests/integration/server.test.ts — HTTP 主链路（mock 模式，零真实模型调用）
 * ============================================================
 * 覆盖：healthz / config(mock) / 会话创建 / chat SSE / transcript 回放 /
 * 404 / 400 / 静态页面与 ESM 模块分发（含 MIME）。
 * 服务端按规定从 tests/helpers 启动（临时端口 + 临时 journal / 配置文件）。
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, type RunningServer } from "../helpers/server.js";

let srv: RunningServer;

before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(srv.base + path, init);
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/** 读取 SSE 直到 done 事件（带超时） */
async function readSse(path: string, payload: unknown): Promise<{ status: number; events: any[] }> {
  const res = await fetch(srv.base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status !== 200) return { status: res.status, events: [] };
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: any[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!frame.startsWith("data: ")) continue;
      const ev = JSON.parse(frame.slice(6));
      events.push(ev);
      if (ev.type === "done") { await reader.cancel(); return { status: 200, events }; }
    }
  }
  return { status: 200, events };
}

test("healthz / readyz 与 config 形状（mock 模式）", async () => {
  const raw = await fetch(srv.base + "/healthz");
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/, "每个响应都应带 X-Request-Id");

  const health = await json("/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.match(health.body.version, /^\d+\.\d+\.\d+/);
  assert.ok(health.body.uptimeSeconds >= 0);

  const ready = await json("/readyz");
  assert.equal(ready.status, 200);
  assert.equal(ready.body.ok, true);
  assert.equal(ready.body.shuttingDown, false);
  assert.deepEqual(ready.body.checks, { configStore: true, sessionStore: true });

  const cfg = await json("/api/config");
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.mock, true, "测试必须跑在 mock 模式");
  assert.ok(Array.isArray(cfg.body.demos));
  assert.equal(cfg.body.contextWindow, 200_000, "未配置或网关未知时默认显示 200k");
  const activeProvider = cfg.body.providers.find((provider: { active: boolean }) => provider.active);
  const activeModel = activeProvider?.models.find((model: { active: boolean }) => model.active);
  assert.equal(activeModel?.contextWindow, 200_000);
  assert.equal(activeModel?.contextWindowSource, "default");
});

test("会话创建 → chat SSE → transcript 回放", async () => {
  const mk = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  assert.equal(mk.status, 200);
  const id = mk.body.id;
  assert.ok(id);

  const stream = await readSse("/api/chat", { sessionId: id, message: "帮我算一下 1+1" });
  assert.equal(stream.status, 200);
  assert.ok(stream.events.some((e) => e.type === "token"), "应有 token 事件");
  const lastUsage = stream.events.filter((e) => e.type === "usage").at(-1);
  assert.equal(typeof lastUsage?.taskInputTokens, "number", "usage 应带服务端任务累计快照");
  assert.equal(typeof lastUsage?.taskModelCalls, "number");
  assert.equal(stream.events.at(-1).type, "done");

  const tr = await json(`/api/sessions/${id}/transcript`);
  assert.equal(tr.status, 200);
  assert.ok(Array.isArray(tr.body.records) && tr.body.records.length >= 1);
  assert.equal(tr.body.records.at(-1).user, "帮我算一下 1+1");
});

test("错误路径：未知 API 404、缺 message 400、未知会话 chat 404", async () => {
  assert.equal((await json("/api/does-not-exist")).status, 404);
  const mk = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  assert.equal((await json("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: mk.body.id, message: "   " }),
  })).status, 400);
  assert.equal((await json("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "no-such-session", message: "hi" }),
  })).status, 404);
});

test("resume：没有待确认事项时 choice 返回 400，不误当审批处理", async () => {
  const mk = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  const res = await json("/api/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: mk.body.id, choice: "A" }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /没有待确认/);
});

test("权限模式：切换成功 / 坏值 400 / 未知会话 404，列表回显当前模式", async () => {
  const mk = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  const id = mk.body.id;

  // 新会话默认审批
  let list = await json("/api/sessions");
  assert.equal(list.body.find((s: any) => s.id === id).permissionMode, "approve");

  // 切到只读 → 列表回显；再切自动
  assert.equal((await json(`/api/sessions/${id}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "readonly" }),
  })).status, 200);
  assert.equal((await json(`/api/sessions/${id}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "autonomous" }),
  })).status, 200);
  list = await json("/api/sessions");
  assert.equal(list.body.find((s: any) => s.id === id).permissionMode, "autonomous");
  assert.equal((await json(`/api/sessions/${id}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "auto" }),
  })).status, 200);
  list = await json("/api/sessions");
  assert.equal(list.body.find((s: any) => s.id === id).permissionMode, "auto");

  const bad = await json(`/api/sessions/${id}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "yolo" }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /mode 必须是/);

  assert.equal((await json("/api/sessions/no-such-session/permission", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "readonly" }),
  })).status, 404);
});

test("审批：interrupt 后保留 pending，批准能恢复并执行工具", async () => {
  const mk = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  const sessionId = mk.body.id;
  const first = await readSse("/api/chat", { sessionId, message: "帮我发邮件给 test@example.com，主题是测试" });
  const interrupt = first.events.find((event) => event.type === "interrupt");
  assert.equal(interrupt?.payload?.type, "approval");

  const sessions = await json("/api/sessions");
  const pending = sessions.body.find((item: { id: string }) => item.id === sessionId);
  assert.equal(pending?.pendingApproval, true, "interrupt 后 done 不能清掉待审批状态");

  const resumed = await readSse("/api/resume", { sessionId, decision: "approve" });
  const result = resumed.events.find((event) => event.type === "tool_result");
  assert.match(String(result?.content ?? ""), /邮件已发送/);

  const afterResume = await json("/api/sessions");
  const cleared = afterResume.body.find((item: { id: string }) => item.id === sessionId);
  assert.equal(cleared?.pendingApproval, false);

  const transcript = await json(`/api/sessions/${sessionId}/transcript`);
  assert.equal(transcript.body.records[0]?.continuation ?? false, false);
  assert.ok(
    transcript.body.records.some((record: { continuation?: boolean }) => record.continuation === true),
    "审批恢复轮需标记 continuation，前端才能并入同一头像"
  );
});

test("文件搜索接口：最多 20 条，跳过依赖目录", async () => {
  const res = await json("/api/fs/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "format.ts" }),
  });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.files));
  assert.ok(res.body.files.length > 0);
  assert.ok(res.body.files.length <= 20);
  assert.ok(res.body.files.every((f: any) => !f.rel.includes("node_modules")));
});

test("压缩上下文：mock 模式走本地摘录并保留轮次回放", async () => {
  const mk = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  const id = mk.body.id;
  const stream = await readSse("/api/chat", { sessionId: id, message: "记住暗号：蓝鲸" });
  assert.equal(stream.status, 200);

  const compact = await json(`/api/sessions/${id}/compact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(compact.status, 200);
  assert.equal(compact.body.usedModel, false);
  assert.match(compact.body.summary, /较早对话摘录/);
  assert.ok(compact.body.beforeChars > 0);

  const tr = await json(`/api/sessions/${id}/transcript`);
  assert.equal(tr.body.records.at(-1).user, "记住暗号：蓝鲸");
});

test("静态分发：index 引用 module 脚本，分目录产物可达且 MIME 正确", async () => {
  const index = await fetch(srv.base + "/");
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /<script type="module" src="\/main\.js"><\/script>/);
  assert.match(html, /<script type="importmap">/);
  assert.match(html, /"chart\.js": "\/vendor\/chart-lib\.js"/);

  for (const file of [
    "/styles/tokens.css", "/styles/reset.css", "/styles/layout.css", "/styles/typography.css",
    "/styles/chat.css", "/styles/composer.css", "/styles/modals.css", "/styles/settings.css",
    "/styles/plugins.css", "/styles/responsive.css", "/styles/desktop.css", "/styles/ui.css",
  ]) {
    const res = await fetch(srv.base + file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/, file);
  }

  // 前端源码在 src/client/*.ts，构建后按职责分目录落到 public/
  for (const file of [
    "/main.js",
    "/modules/format.js", "/modules/chat-flow.js",
    "/modules/plugin-registry.js", "/modules/types.js",
    "/core/state.js", "/core/dom.js", "/core/api.js",
    "/ui/dialog.js", "/ui/menu.js", "/ui/toast.js",
    "/render/parts.js", "/render/messages.js",
    "/stream/events.js", "/stream/turn.js",
    "/views/sessions.js", "/views/settings.js", "/views/model-actions.js",
    "/views/stats/index.js", "/views/stats/kpi.js", "/views/stats/charts.js", "/views/stats/tables.js",
    "/observability/client-errors.js",
    "/vendor/chart.js", "/vendor/chart-lib.js", "/vendor/icons-lib.js",
    "/vendor/marked-lib.js", "/vendor/dompurify-lib.js", "/vendor/highlight-lib.js",
  ]) {
    const res = await fetch(srv.base + file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("content-type") ?? "", /text\/javascript/, file);
  }
});

test("记忆 API：新增/更新/列表/删除全链路，坏请求 400", async () => {
  // 新增
  const created = await json("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "测试偏好", content: "回答要结论先行" }),
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.entry.key, "测试偏好");
  const id = created.body.entry.id;

  // 同 key 新内容生成 active 版本，旧版本保留为历史
  const updated = await json("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "测试偏好", content: "回答要结论先行、少用列表" }),
  });
  assert.equal(updated.status, 200);
  const updatedId = updated.body.entry.id;
  assert.notEqual(updatedId, id);

  // 列表
  const listed = await json("/api/memories");
  assert.equal(listed.status, 200);
  const found = (listed.body.memories || []).find((m: { id: string; content: string }) => m.id === updatedId);
  assert.ok(found, "列表应包含刚保存的记忆");
  assert.equal(found.content, "回答要结论先行、少用列表");
  assert.equal(found.source, "user");
  assert.ok(!(listed.body.memories || []).some((m: { id: string }) => m.id === id));

  // 坏请求：缺 content → 400 中文错误
  const bad = await json("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "只有主题" }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /不能为空/);

  // 删除 → 再删 404
  const gone = await json(`/api/memories/${updatedId}`, { method: "DELETE" });
  assert.equal(gone.status, 200);
  const recheck = await json(`/api/memories/${updatedId}`, { method: "DELETE" });
  assert.equal(recheck.status, 404);
});

test("记忆导入导出：JSON 快照在 scope 之间迁移且来源标记为 import", async () => {
  const created = await json("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "general", key: "导出主题", content: "导出内容" }),
  });
  assert.equal(created.status, 200);
  const exported = await json("/api/memories/export?profileId=general&history=1");
  assert.equal(exported.status, 200);
  assert.equal(exported.body.schemaVersion, 2);
  assert.ok(exported.body.memories.some((item: { key: string }) => item.key === "导出主题"));

  const imported = await json("/api/memories/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "estate", mode: "replace", snapshot: exported.body }),
  });
  assert.equal(imported.status, 200);
  const listed = await json("/api/memories?profileId=estate");
  const found = listed.body.memories.find((item: { key: string }) => item.key === "导出主题");
  assert.equal(found.source, "import");
  assert.equal(found.scope.profileId, "estate");
});

test("记忆插槽 API：默认 local、状态可读、危险 HTTP 切换被拒", async () => {
  const config = await json("/api/memory/config");
  assert.equal(config.status, 200);
  assert.equal(config.body.config.activeProvider, "local");
  assert.equal(config.body.config.http.apiKey, "");
  assert.equal(config.body.config.http.hasApiKey, false);

  const status = await json("/api/memory/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.activeProvider, "local");
  assert.equal(status.body.health.status, "ok");
  assert.ok(["ok", "missing", "migrated"].includes(status.body.localStore.state));

  const unsafe = await json("/api/memory/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ activeProvider: "http" }),
  });
  assert.equal(unsafe.status, 400);
  assert.match(unsafe.body.error, /必须先启用/);

  const noTarget = await json("/api/memory/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(noTarget.status, 400);
  assert.match(noTarget.body.error, /baseURL/);
});

test("统计接口：mock 对话后 usage 计入按天/按模型聚合", async () => {
  // 先建会话聊一轮（mock 模式也产 usage 事件，model 标「模拟模式」）
  const created = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  const sid = created.body.id;
  await readSse("/api/chat", { sessionId: sid, message: "统计验证轮" });

  const stats = await json("/api/stats");
  assert.equal(stats.status, 200);
  assert.equal(stats.body.ranges.length, 2, "同时返回近 7 天与近 30 天");
  const week = stats.body.ranges.find((range: { id: string }) => range.id === "7d");
  const month = stats.body.ranges.find((range: { id: string }) => range.id === "30d");
  assert.ok(week && month);
  for (const range of [week, month]) {
    assert.ok(range.totals.turns >= 1);
    assert.ok(range.totals.inputTokens > 0);
    assert.ok(range.totals.modelCalls > 0);
    assert.equal(
      range.byModel.reduce((sum: number, model: { calls: number }) => sum + model.calls, 0),
      range.totals.modelCalls,
      "模型调用总数必须等于按模型调用数之和",
    );
    assert.ok(range.byModel.some((m: { model: string }) => m.model === "模拟模式"), "mock 用量应标注模拟模式");
    assert.equal(range.byDay.at(-1).date, range.endDate, "应补齐到区间结束日");
    assert.equal(range.byHour.length, 24, "活动时段固定 24 桶");
    assert.ok(Array.isArray(range.toolCalls));
    assert.ok(range.byModelShare.length === range.byModel.length);
    assert.ok(Number.isFinite(range.health.avgTurnMs) && Number.isFinite(range.health.cacheHitRate));
    assert.ok(range.topSessions.some((s: { sessionId: string }) => s.sessionId === sid));
  }
  assert.equal(week.byDay.length, 7);
  assert.equal(month.byDay.length, 30);
});

test("会话导出：Markdown 附件可读，含用户话与助手回答", async () => {
  const created = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent", title: "导出验证" }),
  });
  const sid = created.body.id;
  await readSse("/api/chat", { sessionId: sid, message: "导出验证轮的内容" });

  const res = await fetch(`${srv.base}/api/sessions/${sid}/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
  assert.match(res.headers.get("content-disposition") ?? "", /filename\*=UTF-8''/, "中文文件名走 RFC 5987");
  const md = await res.text();
  assert.match(md, /^# 导出验证/, "标题打头");
  assert.match(md, /导出验证轮的内容/, "用户原话进导出");
  assert.match(md, /### 🤖 助手/, "助手回答进导出");

  // 不存在的会话 → 404
  const miss = await json("/api/sessions/no-such-id/export");
  assert.equal(miss.status, 404);
});

test("批量清理：按创建时间删旧会话，坏参数 400", async () => {
  // 造一个「旧」会话（把 createdAt 拨回 40 天前做不到 —— 接口按真实时间删，
  // 所以这里用 daysBefore=1 兜底验证语义：刚建的会话不该被 1 天规则误删）
  const created = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent", title: "清理验证-新会话" }),
  });
  const sid = created.body.id;

  const bad = await json("/api/sessions/cleanup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ daysBefore: 0 }),
  });
  assert.equal(bad.status, 400, "daysBefore=0 应 400");

  const ok1 = await json("/api/sessions/cleanup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ daysBefore: 1 }),
  });
  assert.equal(ok1.status, 200);
  assert.equal(ok1.body.removed, 0, "刚创建的会话不该被 1 天规则删除");

  const list = await json("/api/sessions");
  assert.ok(list.body.some((s: { id: string }) => s.id === sid), "清理后新会话仍在列表");
});

test("运维指标与诊断接口：受认证边界保护的结构化快照", async () => {
  const metrics = await fetch(srv.base + "/metrics");
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers.get("content-type") ?? "", /text\/plain/);
  const text = await metrics.text();
  assert.match(text, /agent_http_requests_total/);
  assert.match(text, /agent_process_resident_memory_bytes/);

  const diagnostics = await json("/api/diagnostics");
  assert.equal(diagnostics.status, 200);
  assert.equal(typeof diagnostics.body.status, "string");
  assert.ok(diagnostics.body.schemaVersions);
  assert.ok(diagnostics.body.data.journal);
  assert.ok(diagnostics.body.data.checkpoint);
  assert.ok(Array.isArray(diagnostics.body.dependencies.mcp));
  const serialized = JSON.stringify(diagnostics.body);
  assert.doesNotMatch(serialized, /apiKey|AUTH_TOKEN|DATA_KEY|SESSION_SECRET/);
  assert.doesNotMatch(serialized, /C:\\Users\\|D:\\code\\/i);
});
test("客户端错误上报只接收摘要并返回 204", async () => {
  const res = await fetch(srv.base + "/api/client-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "TypeError: boom", version: "web-test", view: "settings", stack: "should-be-ignored" }),
  });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
});
