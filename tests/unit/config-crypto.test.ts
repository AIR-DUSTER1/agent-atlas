/** config-crypto.test.ts — 配置敏感字段加密与明文迁移 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decryptSecret, encryptSecret, hasPlaintextSecrets, sealSensitiveConfig, unsealSensitiveConfig,
} from "../../src/server/security/config-crypto.js";

const KEY = Buffer.alloc(32, 11).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 12).toString("base64");

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
}

test("AES-GCM 往返；密钥错误与密文篡改 fail-closed", () => {
  const sealed = encryptSecret("sk-live-secret", { DATA_KEY: KEY });
  assert.equal(decryptSecret(sealed, { DATA_KEY: KEY }), "sk-live-secret");
  assert.throws(() => decryptSecret(sealed, { DATA_KEY: OTHER_KEY }), /DATA_KEY/);
  assert.throws(() => decryptSecret({ ...sealed, data: sealed.data.slice(0, -2) + "AA" }, { DATA_KEY: KEY }), /DATA_KEY/);
});

test("递归加密 apiKey 与 MCP env，其他普通字段保持可读", () => {
  const source = {
    providers: [{ name: "网关", apiKey: "sk-provider", baseURL: "https://api.example.com" }],
    mcpServers: [{ command: "node", env: { API_TOKEN: "mcp-secret", DEBUG: "1" } }],
  };
  assert.equal(hasPlaintextSecrets(source), true);
  const sealed = sealSensitiveConfig(source, { DATA_KEY: KEY });
  const json = JSON.stringify(sealed);
  assert.doesNotMatch(json, /sk-provider|mcp-secret/);
  assert.match(json, /api\.example\.com/);
  const restored = unsealSensitiveConfig(sealed, { DATA_KEY: KEY }) as typeof source;
  assert.equal(restored.providers[0].apiKey, "sk-provider");
  assert.equal(restored.mcpServers[0].env.API_TOKEN, "mcp-secret");
  assert.equal(hasPlaintextSecrets(sealed), false);
});

test("无 DATA_KEY 的开发模式不做破坏性变换", () => {
  const source = { providers: [{ apiKey: "sk-dev" }] };
  assert.deepEqual(sealSensitiveConfig(source, {}), source);
});

test("旧明文配置首次迁移后磁盘无明文，读取时透明还原", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-secrets-"));
  const file = join(dir, "web-config.json");
  process.env.WEB_CONFIG_FILE = file;
  process.env.DATA_KEY = KEY;
  process.env.PRODUCTION = "";
  try {
    await writeFile(file, JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "p1", name: "供应商", baseURL: "https://api.example.com", apiKey: "sk-old-plain", models: [], activeModelId: "" }],
      rag: { baseURL: "http://127.0.0.1:8000", apiKey: "rag-old-plain" },
    }), "utf8");
    const store = await import("../../src/server/config-store.js");
    assert.equal(await store.migrateStoredSecrets(), true);
    const disk = await readFile(file, "utf8");
    assert.doesNotMatch(disk, /sk-old-plain|rag-old-plain/);
    assert.match(disk, /__agentSecret/);
    const loaded = await store.readConfig();
    assert.equal((loaded.providers as Array<{ apiKey?: string }>)[0].apiKey, "sk-old-plain");
    assert.equal((loaded.rag as { apiKey?: string }).apiKey, "rag-old-plain");
    assert.equal(await store.migrateStoredSecrets(), false, "已迁移配置不重复写盘");

    process.env.DATA_KEY = OTHER_KEY;
    await assert.rejects(() => store.readConfig(), /DATA_KEY/);
  } finally {
    delete process.env.WEB_CONFIG_FILE;
    delete process.env.DATA_KEY;
    delete process.env.PRODUCTION;
    await removeTempDir(dir);
  }
});
