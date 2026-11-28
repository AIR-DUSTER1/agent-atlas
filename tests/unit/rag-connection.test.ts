/**
 * rag-connection.test.ts — RAG 出站请求放行本机/内网地址的契约
 * ============================================================
 * 背景：RAG baseURL 只能由管理员在知识库面板配置（/api/rag/* 在
 * ADMIN_API_RULES 内），与记忆 embedding（memory/semantic.ts）、记忆外部
 * Provider（server/memory-http.ts）同信任级，因此 server/rag.ts 的
 * safeFetch 统一开 allowLocalhost。此前未开时，本机自建 RAG 服务会被
 * SSRF 防线以「拒绝访问内网地址」拒绝，Milvus 等本地部署根本接不上。
 *
 * 本测试在 127.0.0.1 起临时 HTTP 服务，锁定三个行为：
 *   1. testRagConnection 对本机地址能收到 HTTP 响应（探活契约）；
 *   2. searchRag 端到端解析 hits（text/score/name/source 契约形状）；
 *   3. baseURL 协议校验（非 http(s) 仍然拒绝）。
 *
 * 用临时 WEB_CONFIG_FILE 隔离，不碰开发者真实 .web-config.json。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = await mkdtemp(join(tmpdir(), "rag-conn-"));
process.env.WEB_CONFIG_FILE = join(dir, "web-config.json");

const { loadRag, saveRagConfig, searchRag, testRagConnection } = await import("../../src/server/rag.js");

// 临时 RAG 服务：探活返回 200，search 返回契约形状的 hits，ingest 返回计数
const HITS = [
  { text: "agentatlas 使用 LangGraph.js 构建工作流", score: 0.92, name: "README.md", source: "learn-agent/README.md" },
  { text: "知识库面板负责文档入库与检索测试", score: 0.71, name: "docs/product-wiki.md", source: "learn-agent/docs/product-wiki.md" },
];

const server: Server = createServer((req, res) => {
  req.resume(); // 读掉请求体，避免连接悬挂
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET") send(200, { service: "fake-rag" });
  else if (req.url === "/search") send(200, { hits: HITS });
  else if (req.url === "/ingest") send(200, { ok: true, indexed: 1, chunks: 2 });
  else send(404, { error: "not found" });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const baseURL = `http://127.0.0.1:${port}`;

await loadRag();
await saveRagConfig({ baseURL, apiKey: "", collection: "default", topK: 5 });

after(async () => {
  delete process.env.WEB_CONFIG_FILE;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

test("testRagConnection 可达本机 127.0.0.1（修复前会被 SSRF 防线拒绝）", async () => {
  const r = await testRagConnection();
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
});

test("searchRag 对本机服务完成契约解析（hits 数组 + text/score/name/source）", async () => {
  const r = await searchRag("agentatlas 工作流");
  assert.equal(r.query, "agentatlas 工作流");
  assert.equal(r.hits.length, 2);
  assert.equal(r.hits[0].name, "README.md");
  assert.equal(r.hits[0].score, 0.92);
  assert.match(r.hits[0].text, /LangGraph/);
  assert.match(r.hits[0].source, /README\.md$/);
});

test("baseURL 协议校验不放松：非 http(s) 仍然拒绝", async () => {
  await assert.rejects(() => saveRagConfig({ baseURL: "ftp://127.0.0.1:9000" }), /http/);
});
