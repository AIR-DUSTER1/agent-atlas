/**
 * memory-http.test.ts — HTTP 记忆 Provider 契约与故障隔离
 * ============================================================
 * 全部使用本机 mock HTTP 服务：验证 Generic/Hindsight 映射、Bearer 鉴权、
 * 超时、坏响应、熔断、热切换不依赖真实外部服务，也不消耗模型配额。
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { HttpMemoryProvider, testHttpMemoryConfig } from "../../src/server/memory-http.js";
import {
  DEFAULT_MEMORY_CONFIG,
  mergeMemoryConfigPatch,
  publicMemoryConfig,
  type MemoryHttpConfig,
} from "../../src/server/memory-config.js";
import { memoryScope } from "../../src/memory/scope.js";

function baseHttpConfig(baseURL: string, patch: Partial<MemoryHttpConfig> = {}): MemoryHttpConfig {
  return {
    enabled: true,
    preset: "generic",
    baseURL,
    authMode: "bearer",
    apiKey: "test-memory-key",
    timeoutMs: 1000,
    searchLimit: 8,
    writeEnabled: true,
    banks: { general: "general-bank", estate: "estate-bank" },
    ...patch,
    ...(patch.banks ? { banks: { ...patch.banks } } : {}),
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function withMock(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>,
  run: (baseURL: string) => Promise<void>
): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      await handler(req, res, await readBody(req));
    } catch {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "mock failure" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

test("Generic HTTP：health / search / save / list / delete 与 Bearer 鉴权", async () => {
  const seen: Array<{ method?: string; url?: string; auth?: string; body?: any }> = [];
  await withMock(async (req, res, body) => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body: body ? JSON.parse(body) : null,
    });
    if (req.url === "/health") return json(res, 200, { status: "ok" });
    if (req.url === "/memories/search") {
      return json(res, 200, {
        records: [{ externalId: "ext-1", key: "回答风格", content: "结论先行", source: "user", updatedAt: 1 }],
      });
    }
    if (req.url === "/memories" && req.method === "POST") {
      return json(res, 200, { externalId: "ext-2", duplicated: false });
    }
    if (req.url?.startsWith("/memories?") && req.method === "GET") {
      return json(res, 200, { records: [{ externalId: "ext-1", key: "回答风格", content: "结论先行" }] });
    }
    if (req.url === "/memories/ext-1" && req.method === "DELETE") return json(res, 200, { ok: true });
    return json(res, 404, { error: "not found" });
  }, async (baseURL) => {
    const provider = new HttpMemoryProvider(baseHttpConfig(baseURL));
    assert.equal((await provider.health()).status, "ok");
    const search = await provider.search({ scope: memoryScope("general"), text: "回答", limit: 8 });
    assert.equal(search.records[0].content, "结论先行");
    assert.equal(search.providerId, "http");
    const saved = await provider.save({
      scope: memoryScope("estate"),
      key: "房源偏好",
      content: "只看整租",
      source: "user",
    });
    assert.equal(saved.id, "ext-2");
    const listed = await provider.list(memoryScope("general"));
    assert.equal(listed.length, 1);
    assert.equal(await provider.delete("ext-1", memoryScope("general")), true);
    assert.ok(seen.every((entry) => entry.auth === "Bearer test-memory-key"));

    const searchBody = seen.find((entry) => entry.url === "/memories/search")?.body;
    assert.deepEqual(searchBody.scope, { profileId: "general", userId: "local" });
    assert.equal(searchBody.limit, 8);
  });
});

test("Hindsight：general / estate 使用不同 bank，删除能力默认关闭", async () => {
  const paths: string[] = [];
  await withMock(async (req, res, body) => {
    paths.push(req.url ?? "");
    const payload = body ? JSON.parse(body) : {};
    if (req.url === "/health") return json(res, 200, { status: "ok" });
    if (req.url?.endsWith("/memories/recall")) {
      return json(res, 200, {
        memories: [{
          id: "h-1",
          content: payload.query ? "外部召回" : "全部记忆",
          metadata: { key: "外部主题", source: "agent", profileId: "general" },
        }],
      });
    }
    if (req.url?.endsWith("/memories") && req.method === "POST") {
      return json(res, 200, { memory_id: "h-2" });
    }
    return json(res, 404, {});
  }, async (baseURL) => {
    const provider = new HttpMemoryProvider(baseHttpConfig(baseURL, { preset: "hindsight" }));
    const general = await provider.search({ scope: memoryScope("general"), text: "查询", limit: 5 });
    const estate = await provider.search({ scope: memoryScope("estate"), text: "查询", limit: 5 });
    assert.equal(general.records[0].content, "外部召回");
    assert.equal(estate.records[0].content, "外部召回");
    assert.ok(paths.some((path) => path.includes("/banks/general-bank/memories/recall")));
    assert.ok(paths.some((path) => path.includes("/banks/estate-bank/memories/recall")));
    assert.equal(provider.capabilities.delete, false);
    await assert.rejects(() => provider.delete("h-1", memoryScope("general")), /不支持删除/);
  });
});

test("HTTP 故障：超时 / 坏响应 / 5xx 都翻译为中文，连续失败触发熔断", async () => {
  await withMock(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{ broken");
      return;
    }
    if (req.url === "/memories/search") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return json(res, 200, { records: [] });
    }
    return json(res, 503, { error: "down" });
  }, async (baseURL) => {
    const broken = new HttpMemoryProvider(baseHttpConfig(baseURL));
    const health = await broken.health();
    assert.equal(health.status, "unavailable");
    assert.match(health.message ?? "", /无法解析|熔断/);

    const timeout = new HttpMemoryProvider(baseHttpConfig(baseURL, { timeoutMs: 40 }));
    await assert.rejects(
      () => timeout.search({ scope: memoryScope("general"), text: "慢", limit: 8 }),
      /超时|熔断/
    );

    const failing = new HttpMemoryProvider(baseHttpConfig(baseURL));
    const scope = memoryScope("general");
    await assert.rejects(() => failing.list(scope), /HTTP 503/);
    await assert.rejects(() => failing.list(scope), /HTTP 503/);
    await assert.rejects(() => failing.list(scope), /HTTP 503/);
    await assert.rejects(() => failing.list(scope), /熔断/);
  });
});

test("连接测试与配置安全视图：真实 Key 不回传，危险配置被拒绝", async () => {
  await withMock(async (req, res) => {
    if (req.url === "/health") return json(res, 200, { status: "ok" });
    return json(res, 404, {});
  }, async (baseURL) => {
    const health = await testHttpMemoryConfig(baseHttpConfig(baseURL));
    assert.equal(health.status, "ok");
  });

  const publicView = publicMemoryConfig({
    ...DEFAULT_MEMORY_CONFIG,
    http: { ...DEFAULT_MEMORY_CONFIG.http, apiKey: "sk-very-secret-value" },
  });
  assert.equal(publicView.http.apiKey, "");
  assert.equal(publicView.http.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(publicView), /very-secret/);

  assert.throws(
    () => mergeMemoryConfigPatch(DEFAULT_MEMORY_CONFIG, { http: { enabled: true, baseURL: "file:///tmp/x" } }),
    /只允许 http/
  );
  assert.throws(
    () => mergeMemoryConfigPatch(DEFAULT_MEMORY_CONFIG, { activeProvider: "http" }),
    /必须先启用/
  );
  assert.throws(
    () => mergeMemoryConfigPatch(DEFAULT_MEMORY_CONFIG, {
      http: {
        enabled: true,
        baseURL: "http://127.0.0.1:9999",
        preset: "hindsight",
        banks: { general: "same", estate: "same" },
      },
    }),
    /必须不同/
  );
  const merged = mergeMemoryConfigPatch({
    ...DEFAULT_MEMORY_CONFIG,
    http: { ...DEFAULT_MEMORY_CONFIG.http, apiKey: "keep-me" },
  }, {
    http: { enabled: true, baseURL: "http://127.0.0.1:9999", apiKey: "" },
  });
  assert.equal(merged.http.apiKey, "keep-me");
});
