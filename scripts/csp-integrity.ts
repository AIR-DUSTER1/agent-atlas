/**
 * scripts/csp-integrity.ts — 校验 index.html 内联脚本与 CSP hash 同步
 * ============================================================
 * 浏览器不执行未获 hash 授权的 inline script；一旦 index 改动而 CSP 常量没变，
 * 页面会白屏。把校验前移到构建阶段，比线上靠肉眼排错可靠。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CSP_SCRIPT_HASHES } from "../src/server/csp-hashes.js";

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

export function computeInlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = INLINE_SCRIPT.exec(html))) {
    const body = match[1] ?? "";
    hashes.push(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
  }
  return hashes;
}

export async function assertCspHashes(indexPath: string): Promise<void> {
  const html = await readFile(indexPath, "utf8");
  const actual = computeInlineScriptHashes(html);
  if (actual.length !== CSP_SCRIPT_HASHES.length || actual.some((hash, index) => hash !== CSP_SCRIPT_HASHES[index])) {
    throw new Error(
      `CSP hash 已过期：index 实际为 ${actual.join(", ")}；请同步 src/server/csp-hashes.ts`,
    );
  }
}
