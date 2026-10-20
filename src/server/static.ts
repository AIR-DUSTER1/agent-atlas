/**
 * static.ts — 前端静态文件分发（白名单式防目录穿越）
 * ============================================================
 * 只服务 public/ 下**单层文件名**（`\w.-` 白名单），杜绝 ../ 穿越；
 * 全部 no-store：页面与脚本始终取最新（本地学习 demo，禁用浏览器缓存，
 * 避免「更新代码后浏览器还在跑旧 app.js → 按钮点了没反应」）。
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

/** 命中并回包返回 true；未命中（含穿越尝试）返回 false，由入口统一 404 */
export async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const file = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (!/^[\w.-]+$/.test(file)) return false; // 只允许单层文件名，杜绝 ../ 穿越
  try {
    const data = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, {
      "Content-Type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
