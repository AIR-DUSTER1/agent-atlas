/**
 * tests/integration/server.test.ts — HTTP 主链路（mock 模式，零真实模型调用）
 * ============================================================
 * 覆盖：healthz / config(mock) / 会话创建 / chat SSE / transcript 回放 /
 * 404 / 400 / 静态页面与 ESM 模块分发（含 MIME）。
 * 服务端按规定从 tests/helpers 启动（临时端口 + 临时 journal / 配置文件）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer, type RunningServer } from "../helpers/server.js";
import { writeEstateWorkbook } from "../../src/server/estate-workbook.js";

let srv: RunningServer;
let estateExportDir = "";

before(async () => {
  estateExportDir = await mkdtemp(join(tmpdir(), "agentatlas-estate-http-"));
  srv = await startServer({ ESTATE_EXPORT_DIR: estateExportDir });
});
after(async () => {
  await srv?.stop();
  if (estateExportDir) await rm(estateExportDir, { recursive: true, force: true });
});

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
  assert.equal(health.body.channel, "dev");
  assert.match(health.body.commit, /^[0-9a-f]{7,64}$/);
  assert.match(health.body.buildId, /^dev\./);
  assert.ok(health.body.uptimeSeconds >= 0);

  const ready = await json("/readyz");
  assert.equal(ready.status, 200);
  assert.equal(ready.body.ok, true);
  assert.equal(ready.body.shuttingDown, false);
  assert.deepEqual(ready.body.checks, { configStore: true, sessionStore: true, database: true });
  assert.equal(ready.body.version, health.body.version);
  assert.equal(ready.body.buildId, health.body.buildId);

  const version = await json("/api/version");
  assert.equal(version.status, 200);
  assert.equal(version.body.version, health.body.version);
  assert.equal(version.body.releaseStage, "beta");
  assert.equal(version.body.commit, health.body.commit);
  assert.equal(version.body.buildId, health.body.buildId);
  assert.match(version.body.builtAt, /^\d{4}-\d{2}-\d{2}T/);

  const cfg = await json("/api/config");
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.mock, true, "测试必须跑在 mock 模式");
  assert.ok(Array.isArray(cfg.body.demos));
  assert.equal(cfg.body.contextWindow, 200_000, "未配置或网关未知时默认显示 200k");
  assert.equal(cfg.body.contextBudget.contextWindow, 200_000);
  assert.equal(cfg.body.contextBudget.outputReserveTokens, 8_192);
  assert.equal(cfg.body.contextBudget.safetyMarginTokens, 10_000);
  assert.equal(cfg.body.contextBudget.inputBudgetTokens, 181_808);
  assert.equal(cfg.body.map.provider, "amap");
  assert.match(cfg.body.map.tileUrl, /autonavi\.com/);
  assert.equal(cfg.body.map.projection, "web-mercator");
  assert.deepEqual(cfg.body.providers, []);
  assert.equal(cfg.body.activeProviderId, null);
  assert.equal(cfg.body.activeModelId, null);
  assert.equal(cfg.body.model, "");
  assert.equal(cfg.body.contextWindow, 200_000);
  assert.equal(cfg.body.contextBudget.contextWindow, 200_000);
});

test("LangSmith 追踪配置 API 默认关闭、Key 只回掩码并可清除", async () => {
  const initial = await json("/api/tracing");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.backend, "off");
  assert.equal(initial.body.hasApiKey, false);
  assert.equal(initial.body.effective, false);
  assert.equal(initial.body.endpoint, "https://api.smith.langchain.com");
  assert.equal(initial.body.agentId, "agentatlas");
  assert.equal(initial.body.agentEnvironment, "local");

  const saved = await json("/api/tracing", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      backend: "langsmith",
      apiKey: "lsv2-integration-secret",
      project: "agentatlas-integration",
      endpoint: "https://api.smith.langchain.com",
      agentId: "agentatlas",
      agentEnvironment: "local",
      anonymize: true,
    }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.backend, "langsmith");
  assert.equal(saved.body.hasApiKey, true);
  assert.equal(saved.body.effective, true);
  assert.notEqual(saved.body.keyMasked, "lsv2-integration-secret");

  const reread = await json("/api/tracing");
  assert.equal(reread.body.keyMasked, saved.body.keyMasked);

  const cleared = await json("/api/tracing", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend: "off", apiKey: "" }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.backend, "off");
  assert.equal(cleared.body.hasApiKey, false);

  const invalid = await json("/api/tracing", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend: "langsmith", endpoint: "http://127.0.0.1:3000" }),
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /https|内网/);
});

test("有 API_KEY 时仍从 .env 播种默认供应商", async () => {
  const seeded = await startServer({
    API_KEY: "test-only-env-key",
    BASE_URL: "http://127.0.0.1:9/v1",
    MODEL: "env-model",
  });
  try {
    const response = await fetch(seeded.base + "/api/config");
    assert.equal(response.status, 200);
    const cfg = await response.json() as {
      mock: boolean;
      model: string;
      activeProviderId: string | null;
      providers: Array<{ name: string; model: string }>;
    };
    assert.equal(cfg.mock, false);
    assert.equal(cfg.model, "env-model");
    assert.ok(cfg.activeProviderId);
    assert.equal(cfg.providers.length, 1);
    assert.equal(cfg.providers[0].name, "默认供应商（.env）");
    assert.equal(cfg.providers[0].model, "env-model");
  } finally {
    await seeded.stop();
  }
});

test("Excel 对比清单通过同源认证接口下载，文件名与 XLSX 类型正确", async () => {
  const previous = process.env.ESTATE_EXPORT_DIR;
  process.env.ESTATE_EXPORT_DIR = estateExportDir;
  try {
    const artifact = await writeEstateWorkbook(
      Array.from({ length: 13 }, (_, index) => ({
        houseId: `10315553${String(index).padStart(4, "0")}`,
        title: `下载验证小区 · 2室1厅 · ${80 + index}㎡`,
        community: "下载验证小区",
        layout: "2室1厅",
        area: `${80 + index}㎡`,
        price: `${2300 + index * 100}元/月`,
      })),
      { mode: "rent", city: "青岛", query: "下载接口" },
    );
    const res = await fetch(srv.base + artifact.downloadUrl);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /spreadsheetml\.sheet/);
    assert.match(res.headers.get("content-disposition") || "", /filename\*=UTF-8''/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString("utf8"), "PK");
  } finally {
    if (previous === undefined) delete process.env.ESTATE_EXPORT_DIR;
    else process.env.ESTATE_EXPORT_DIR = previous;
  }
});

test("地图静态代理按 provider 明确报缺失 Key，服务端字段不下发前端", async () => {
  const cfg = await json("/api/config");
  assert.equal(cfg.body.map.staticMapAvailable, false);
  assert.equal("amapWebServiceKey" in cfg.body.map, false);
  assert.equal("tencentWebServiceKey" in cfg.body.map, false);
  assert.equal("baiduWebServiceKey" in cfg.body.map, false);
  const expected: Record<string, string> = {
    amap: "AMAP_WEB_SERVICE_KEY",
    tencent: "TENCENT_MAP_KEY",
    baidu: "BAIDU_MAP_AK",
  };
  for (const [provider, envName] of Object.entries(expected)) {
    const res = await json(`/api/map/static?provider=${provider}&lat=36.123971&lng=120.421197&zoom=14&variant=compact`);
    assert.equal(res.status, 503);
    assert.match(res.body.error, new RegExp(envName));
    assert.match(res.body.error, /原生瓦片降级/);
  }
  const invalid = await json("/api/map/static?provider=osm&lat=36.123971&lng=120.421197");
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /provider 无效/);
});

test("同供应商切换模型会重建配置且保留会话历史", async () => {
  const created = await json("/api/config/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "切换验证",
      baseURL: "https://models.example.test/v1",
      models: [
        { name: "model-a", contextWindow: 160_000 },
        { name: "model-b", contextWindow: 32_000 },
      ],
    }),
  });
  assert.equal(created.status, 200);
  const provider = created.body.provider;
  const modelA = provider.models.find((m: { name: string }) => m.name === "model-a");
  const modelB = provider.models.find((m: { name: string }) => m.name === "model-b");
  assert.ok(modelA && modelB);

  const first = await json("/api/config/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: provider.id, modelId: modelB.id }),
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.activeChanged, true, "切到新组合必须 bump 配置版本");

  const session = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent", title: "模型切换历史验证" }),
  });
  assert.equal(session.status, 200);
  const before = await readSse("/api/chat", { sessionId: session.body.id, message: "记住关键词：蓝鲸" });
  assert.equal(before.status, 200);

  const switched = await json("/api/config/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: provider.id, modelId: modelA.id }),
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.activeChanged, true, "同供应商换模型也必须让旧会话下次发消息时重建图");

  const repeated = await json("/api/config/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: provider.id, modelId: modelA.id }),
  });
  assert.equal(repeated.body.activeChanged, false, "重复选择同一组合不应无谓重建");

  await new Promise((resolve) => setTimeout(resolve, 1_600));
  const after = await readSse("/api/chat", { sessionId: session.body.id, message: "继续用刚才的上下文" });
  assert.equal(after.status, 200);
  const transcript = await json(`/api/sessions/${session.body.id}/transcript`);
  assert.equal(transcript.status, 200);
  assert.equal(transcript.body.records.length, 2, "切换模型不能清空会话历史");
  assert.equal(transcript.body.records[0].user, "记住关键词：蓝鲸");
  assert.equal(transcript.body.records[1].user, "继续用刚才的上下文");
});

test("跨供应商切换模型必须真的换掉运行时模型（顶栏菜单曾经 200 但没生效）", async () => {
  // 回归背景：顶栏模型菜单曾绕过 /api/config/activate，直接 POST
  // /api/config/providers/:id/models/:id { makeActive: true }。服务端那里只改
  // 供应商内部 activeModelId，再用「该供应商是否已启用」决定要不要同步运行时
  // config —— 跨供应商时条件不成立，接口照样 200，但 config.model 一个字节没变。
  const providerA = await json("/api/config/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "跨供应商甲",
      baseURL: "https://a.example.test/v1",
      models: [{ name: "alpha-1" }, { name: "alpha-2" }],
    }),
  });
  assert.equal(providerA.status, 200);
  const a = providerA.body.provider;
  const alpha1 = a.models.find((m: { name: string }) => m.name === "alpha-1");

  const providerB = await json("/api/config/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "跨供应商乙",
      baseURL: "https://b.example.test/v1",
      models: [{ name: "beta-1" }],
    }),
  });
  assert.equal(providerB.status, 200);
  const b = providerB.body.provider;
  const beta1 = b.models.find((m: { name: string }) => m.name === "beta-1");

  const first = await json("/api/config/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: a.id, modelId: alpha1.id }),
  });
  assert.equal(first.status, 200);
  const beforeConfig = await json("/api/config");
  assert.equal(beforeConfig.body.model, "alpha-1");

  // 走模型更新接口的 makeActive（顶栏菜单旧路径）：跨供应商也必须生效
  const switched = await json(`/api/config/providers/${b.id}/models/${beta1.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ makeActive: true }),
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.activeChanged, true, "跨供应商切换必须报告配置已变更");

  const afterConfig = await json("/api/config");
  assert.equal(afterConfig.body.model, "beta-1", "运行时模型必须真的换到跨供应商的目标模型");
  assert.equal(
    afterConfig.body.providers.find((p: { id: string }) => p.id === b.id)?.active,
    true,
    "目标供应商必须成为启用供应商",
  );
  assert.equal(
    afterConfig.body.providers.find((p: { id: string }) => p.id === a.id)?.active,
    false,
    "原供应商必须取消启用",
  );

  // 清理：退回甲供应商，避免影响后续用例的模拟模型标签
  await json("/api/config/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: a.id, modelId: alpha1.id }),
  });
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

  const currentConfig = await json("/api/config");
  const stream = await readSse("/api/chat", { sessionId: id, message: "帮我算一下 1+1" });
  assert.equal(stream.status, 200);
  assert.ok(stream.events.some((e) => e.type === "token"), "应有 token 事件");
  const lastUsage = stream.events.filter((e) => e.type === "usage").at(-1);
  assert.equal(typeof lastUsage?.taskInputTokens, "number", "usage 应带服务端任务累计快照");
  assert.equal(typeof lastUsage?.taskModelCalls, "number");
  assert.equal(lastUsage?.contextWindow, currentConfig.body.contextWindow, "usage 应携带当前模型请求的上下文窗口容量");
  assert.equal(lastUsage?.contextInputBudget, currentConfig.body.contextBudget.inputBudgetTokens);
  assert.equal(lastUsage?.outputReserveTokens, currentConfig.body.contextBudget.outputReserveTokens);
  assert.equal(lastUsage?.safetyMarginTokens, currentConfig.body.contextBudget.safetyMarginTokens);
  // R4：本轮结束时的任务累计用量是独立事件，且在 done 之前 —— 下游取它即可，
  // 不必再从多条 usage 里猜哪条是最终值。
  const taskUsage = stream.events.find((e) => e.type === "task_usage");
  assert.ok(taskUsage, "应有一条 task_usage 事件");
  assert.equal(typeof taskUsage.inputTokens, "number");
  assert.equal(typeof taskUsage.outputTokens, "number");
  assert.equal(typeof taskUsage.toolCalls, "number");
  assert.equal(typeof taskUsage.modelCalls, "number");
  assert.equal(typeof taskUsage.activeMs, "number");
  assert.ok(
    stream.events.indexOf(taskUsage) > stream.events.findIndex((e) => e.type === "usage"),
    "task_usage 必须晚于 per-call usage",
  );
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
  // M3：Vite 打包产物为 assets/app.js（固定名，服务端 no-store 下无需哈希）
  assert.match(html, /<script type="module"[^>]*src="\.\/assets\/app\.js">/);
  // M4 4.6：import map 随 vendor 自包含库退役 —— npm 包由 Vite 打包，
  // 页面不再需要 import map，也不能再残留 vendor 路径引用
  assert.doesNotMatch(html, /<script type="importmap">/);
  assert.doesNotMatch(html, /vendor\/[a-z-]+-lib\.js/);

  // styles/ 已按页面分到 base/ chat/ settings/<view>/ 等子目录：
  // 从 index.html 反查真实 href，而不是维护第二份路径清单
  // （清单式断言在目录重组后会静默失效，只测到"旧的 404"而非"新的 200"）。
  const styleLinks = [...html.matchAll(/href="(\/styles\/[^"]+\.css)"/g)].map((m) => m[1] as string);
  assert.ok(styleLinks.length >= 25, `index.html 应引用至少 25 个样式，实际 ${styleLinks.length}`);
  for (const file of styleLinks) {
    const res = await fetch(srv.base + file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/, file);
  }

  // M3：tsc 1:1 产物与 vendor *-lib.js 退役，前端只暴露打包后的 assets/app.js
  // 与动态增强 chunk；旧 1:1 路径与 vendor 探测必须 404（防目录漂移回归）。
  for (const file of ["/assets/app.js", "/assets/markdown.js", "/assets/chart.js"]) {
    const res = await fetch(srv.base + file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("content-type") ?? "", /text\/javascript/, file);
  }
  // M4 4.6：1:1 过渡树与 vendor 自包含库均已退役 —— 这些路径必须 404，
  // 防「脚本又把旧产物写回 public/」的回归。
  for (const file of [
    "/main.js",
    "/modules/format.js",
    "/core/state.js",
    "/render/parts.js",
    "/views/sessions.js",
    "/vendor/chart.js", "/vendor/chart-lib.js", "/vendor/icons-lib.js",
    "/vendor/marked-lib.js", "/vendor/dompurify-lib.js", "/vendor/highlight-lib.js",
  ]) {
    const res = await fetch(srv.base + file);
    assert.equal(res.status, 404, file);
  }
});

test("个性化上下文 API：默认启用、可保存且不再提供手动记忆写入", async () => {
  const initial = await json("/api/memory/config");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.config.personalization.enabled, true);
  assert.equal(initial.body.config.personalization.text, "");

  const saved = await json("/api/memory/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      personalization: { enabled: true, text: "称呼我为老王；回答先给结论。" },
    }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.personalization.text, "称呼我为老王；回答先给结论。");

  const reread = await json("/api/memory/config");
  assert.equal(reread.body.config.personalization.text, "称呼我为老王；回答先给结论。");

  const manual = await json("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "测试偏好", content: "回答要结论先行" }),
  });
  assert.equal(manual.status, 404, "手动新增记忆接口必须关闭");
});

test("记忆导入导出：JSON 快照在 scope 之间迁移且来源标记为 import", async () => {
  const seed = await json("/api/memories/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profileId: "general",
      mode: "replace",
      snapshot: {
        schemaVersion: 3,
        memories: [{ key: "导出主题", content: "导出内容", status: "active" }],
      },
    }),
  });
  assert.equal(seed.status, 200);
  const exported = await json("/api/memories/export?profileId=general&history=1");
  assert.equal(exported.status, 200);
  assert.equal(exported.body.schemaVersion, 3);
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

test("自动沉淀候选：对话结束后可确认生效且按 Agent scope 隔离", async () => {
  const created = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: "default", title: "自动记忆候选" }),
  });
  assert.equal(created.status, 200);
  const sid = created.body.id as string;
  await readSse("/api/chat", { sessionId: sid, message: "请记住：以后部署测试统一使用 npm test" });

  let candidates: any[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listed = await json("/api/memories/candidates?profileId=general");
    candidates = listed.body.memories ?? [];
    if (candidates.some((item) => String(item.content).includes("npm test"))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const candidate = candidates.find((item) => String(item.content).includes("npm test"));
  assert.ok(candidate, "明确记忆表达应生成待确认候选；实际=" + JSON.stringify(candidates));
  assert.equal((await json("/api/memories?profileId=estate")).body.memories.some((item: any) => item.id === candidate.id), false);

  const confirmed = await json(`/api/memories/${encodeURIComponent(candidate.id)}/confirm?profileId=general`, { method: "POST" });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.entry.status, "active");
  const active = await json("/api/memories?profileId=general");
  assert.ok(active.body.memories.some((item: any) => item.id === candidate.id));
});

test("运维指标与诊断接口：受认证边界保护的结构化快照", async () => {
  const metrics = await fetch(srv.base + "/metrics");
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers.get("content-type") ?? "", /text\/plain/);
  const text = await metrics.text();
  assert.match(text, /agent_http_requests_total/);
  assert.match(text, /agent_process_resident_memory_bytes/);
  assert.match(text, /memory_save_total/);

  const versionInfo = await json("/api/version");
  const diagnostics = await json("/api/diagnostics");
  assert.equal(diagnostics.status, 200);
  assert.equal(typeof diagnostics.body.status, "string");
  assert.equal(diagnostics.body.runtime.version, versionInfo.body.version);
  assert.equal(diagnostics.body.runtime.buildId, versionInfo.body.buildId);
  assert.ok(diagnostics.body.schemaVersions);
  assert.equal(diagnostics.body.schemaVersions.memory, 3);
  assert.ok(diagnostics.body.data.journal);
  assert.ok(diagnostics.body.data.checkpoint);
  assert.equal(diagnostics.body.data.memory.state, "ok");
  assert.equal(diagnostics.body.dependencies.memory.activeProvider, "local");
  assert.equal(diagnostics.body.dependencies.memory.status, "ok");
  assert.ok(Array.isArray(diagnostics.body.dependencies.mcp));
  const serialized = JSON.stringify(diagnostics.body);
  assert.doesNotMatch(serialized, /apiKey|AUTH_TOKEN|DATA_KEY|SESSION_SECRET/);
  assert.doesNotMatch(serialized, /C:\\Users\\|D:\\code\\/i);
});
test("客户端错误上报只接收摘要并返回 204", async () => {
  const res = await fetch(srv.base + "/api/client-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "TypeError: boom", version: "0.7.0-beta.1", commit: "1234567", buildId: "dev.test.1234567", view: "settings", stack: "should-be-ignored" }),
  });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
});
test("插件启停 API：Computer Use 平台限制、持久化与坏请求 400", async () => {
  const before = await json("/api/plugins");
  assert.equal(before.status, 200);
  assert.equal(before.body.enabled.computer, false);
  assert.equal(before.body.platform, process.platform);

  const turnedOn = await json("/api/plugins/computer", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  if (process.platform === "win32") {
    assert.equal(turnedOn.status, 200);
    assert.equal(turnedOn.body.enabled.computer, true);
    const reread = await json("/api/plugins");
    assert.equal(reread.body.enabled.computer, true, "启停状态应由服务端持久化");
  } else {
    assert.equal(turnedOn.status, 400);
    assert.match(turnedOn.body.error, /Windows/);
    const reread = await json("/api/plugins");
    assert.equal(reread.body.enabled.computer, false, "不支持的平台不得启用 Computer Use");
  }

  const bad = await json("/api/plugins/computer", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: "yes" }),
  });
  assert.equal(bad.status, 400, "非布尔 enabled 必须拒绝");

  const restored = await json("/api/plugins/computer", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.enabled.computer, false);
});

test("Browser Use 状态与不存在会话返回稳定契约", async () => {
  const status = await json("/api/browser/status");
  assert.equal(status.status, 200);
  assert.equal(typeof status.body.available, "boolean");
  assert.equal(status.body.maxSessions, 3);
  assert.equal(typeof status.body.activeSessions, "number");

  const missing = await json("/api/browser/sessions/missing-session");
  assert.equal(missing.status, 404);
  assert.match(String(missing.body.error), /不存在|已关闭/);

  const bad = await json("/api/browser/sessions/bad%2Fid");
  assert.equal(bad.status, 400);

  const before = await json("/api/plugins");
  const browserEnabled = !before.body.enabled.browser;
  const toggled = await json("/api/plugins/browser", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: browserEnabled }),
  });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.body.enabled.browser, browserEnabled);
  const restored = await json("/api/plugins/browser", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: before.body.enabled.browser }),
  });
  assert.equal(restored.status, 200);
});

test("插件并发切换不丢更新", async () => {
  const before = await json("/api/plugins");
  const estate = !before.body.enabled.estate;
  const rag = !before.body.enabled.rag;
  const [estateResult, ragResult] = await Promise.all([
    json("/api/plugins/estate", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: estate }),
    }),
    json("/api/plugins/rag", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: rag }),
    }),
  ]);
  assert.equal(estateResult.status, 200);
  assert.equal(ragResult.status, 200);
  const after = await json("/api/plugins");
  assert.equal(after.body.enabled.estate, estate);
  assert.equal(after.body.enabled.rag, rag);

  await Promise.all([
    json("/api/plugins/estate", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: before.body.enabled.estate }),
    }),
    json("/api/plugins/rag", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: before.body.enabled.rag }),
    }),
  ]);
});
test("file 后端用户管理端点保持 404，不先被请求 schema 改写", async () => {
  assert.equal((await json("/api/users")).status, 404);
  const badCreate = await json("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: 123 }),
  });
  assert.equal(badCreate.status, 404);
});
