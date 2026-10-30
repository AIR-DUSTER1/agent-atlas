/**
 * tests/unit/branding.test.ts — 正式品牌标识守门
 * ============================================================
 * 项目已正式更名为 agentatlas；包名、页面、桌面端、网络客户端与容器元数据
 * 必须同步，防止后续复制旧文档或旧客户端身份造成品牌回退。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME, PRODUCT_USER_AGENT } from "../../src/product.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function read(relative: string): Promise<string> {
  return readFile(join(ROOT, relative), "utf8");
}

test("正式产品名为 agentatlas，且包与 lockfile 一致", async () => {
  const pkg = JSON.parse(await read("package.json")) as { name?: string };
  const lock = JSON.parse(await read("package-lock.json")) as {
    name?: string;
    packages?: Record<string, { name?: string }>;
  };
  assert.equal(PRODUCT_NAME, "agentatlas");
  assert.equal(PRODUCT_USER_AGENT, "agentatlas/1.0");
  assert.equal(pkg.name, PRODUCT_NAME);
  assert.equal(lock.name, PRODUCT_NAME);
  assert.equal(lock.packages?.[""]?.name, PRODUCT_NAME);
});

test("Web、桌面端与容器入口使用同一产品名", async () => {
  const html = await read("src/client/index.html");
  const desktop = await read("desktop/main.ts");
  const dockerfile = await read("Dockerfile");
  assert.match(html, /<title>agentatlas<\/title>/);
  assert.match(html, /<h1[^>]*>agentatlas<\/h1>/);
  assert.match(desktop, /title: "agentatlas · 桌面版"/);
  assert.match(dockerfile, /org\.opencontainers\.image\.title="agentatlas"/);
  assert.doesNotMatch(`${html}\n${desktop}\n${dockerfile}`, /langgraph-agent-(demo|workbench)/);
});

test("旧品牌 agent-tools 不再回流到公开入口", async () => {
  const files = [
    "README.md",
    "AGENTS.md",
    "src/product.ts",
    "src/client/modules/product.ts",
    "src/client/index.html",
    "desktop/main.ts",
    "Dockerfile",
    "docs/agentatlas-roadmap.md",
  ];
  const sources = await Promise.all(files.map((file) => read(file)));
  assert.doesNotMatch(sources.join("\n"), /agent-tools/i);
  assert.match(sources[7] ?? "", /# agentatlas 能力路线/);
});
