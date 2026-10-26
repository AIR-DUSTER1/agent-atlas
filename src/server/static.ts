/**
 * ============================================================
 * static.ts — 前端静态文件分发（白名单式防目录穿越）
 * ============================================================
 * 只服务 public/ 下的单层文件名（`\w - .` 白名单）与一层子目录
 * （core/ composer/ render/ stream/ views/ actions/ modules/），其余一律 404
 * —— 杜绝 ../ 穿越与深层探测。
 * 为什么允许子目录：前端源码已 TypeScript 化，构建产物按职责分目录
 * （src/client/* → src/server/public/*），不再是单个 app.js。
 * 全部 no-store：页面与脚本始终取最新（禁用浏览器缓存，避免
 * 「更新代码后浏览器还在跑旧脚本 → 按钮点了没反应」）。
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** 允许的一层子目录（字面量白名单；不含用户可控段） */
const ALLOWED_DIRS = new Set([
  "modules", "core", "composer", "render", "stream", "views", "actions",
]);

export async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const raw = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // 单层文件，或「允许的子目录/单层文件」两种形态
  const single = raw.match(/^(\w[\w.-]*)$/);
  const nested = raw.match(/^([a-z]+)\/(\w[\w.-]*)$/);
  if (!single && !nested) return false;

  let rel: string;
  if (nested) {
    const [, dir, file] = nested;
    if (!ALLOWED_DIRS.has(dir)) return false; // 未知子目录直接 404
    rel = join(dir, file);
  } else {
    rel = single?.[1] ?? "";
  }

  try {
    const data = await readFile(join(PUBLIC_DIR, rel));
    const ext = rel.slice(rel.lastIndexOf("."));
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
