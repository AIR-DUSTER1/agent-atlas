/**
 * ============================================================
 * static.ts — 前端静态文件分发（白名单式防目录穿越）
 * ============================================================
 * 只服务 public/ 下的单层文件名（`\w - .` 白名单）与一层已登记子目录
 * （core/ composer/ render/ stream/ views/ actions/ modules/ ui/ vendor/ styles/）。
 * 在路径正则之外再做 realpath 边界和 lstat 普通文件校验，拒绝符号链接、
 * 未知扩展与目录列表；全部 no-store，页面和脚本始终取最新构建。
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, dirname, isAbsolute, relative } from "node:path";
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
  "modules", "core", "composer", "render", "stream", "views", "actions", "ui", "vendor", "styles",
]);

/** Windows 路径大小写不敏感；relative 结果越界时一律拒绝。 */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

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

  const ext = rel.slice(rel.lastIndexOf("."));
  const mime = MIME[ext];
  if (!mime) return false;

  const target = join(PUBLIC_DIR, rel);
  try {
    const [rootReal, targetReal, info] = await Promise.all([
      realpath(PUBLIC_DIR),
      realpath(target),
      lstat(target),
    ]);
    if (!info.isFile() || info.isSymbolicLink() || !isInside(rootReal, targetReal)) return false;
    const data = await readFile(targetReal);
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-store",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
