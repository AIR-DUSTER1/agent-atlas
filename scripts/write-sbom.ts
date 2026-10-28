/**
 * ============================================================
 * write-sbom.ts — 生成可归档的 CycloneDX SBOM
 * ============================================================
 * 使用 npm 内置 sbom 能力，避免新增供应链工具依赖。产物默认写 artifacts/，
 * 该目录已被 gitignore；CI 以 action artifact 保存并记录哈希。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function npmCommand(): { command: string; prefix: string[] } {
  const cli = process.env.npm_execpath;
  if (cli) return { command: process.execPath, prefix: [cli] };
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [] };
}

const argIndex = process.argv.indexOf("--output");
const output = resolve(argIndex >= 0 ? process.argv[argIndex + 1] || "" : "artifacts/sbom.cdx.json");
const npm = npmCommand();
const result = spawnSync(npm.command, [
  ...npm.prefix,
  "sbom",
  "--omit=dev",
  "--sbom-format",
  "cyclonedx",
  "--json",
], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
});

if (result.status !== 0) {
  console.error((result.stderr || result.stdout || "npm sbom 执行失败").slice(0, 2000));
  process.exit(result.status || 1);
}

let parsed: unknown;
try {
  parsed = JSON.parse(result.stdout);
} catch {
  console.error("npm sbom 未返回合法 JSON");
  process.exit(2);
}

const bytes = Buffer.from(JSON.stringify(parsed, null, 2) + "\n", "utf8");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, bytes, { mode: 0o644 });
const digest = createHash("sha256").update(bytes).digest("hex");
console.log(JSON.stringify({ ok: true, output, bytes: bytes.length, sha256: digest }));
