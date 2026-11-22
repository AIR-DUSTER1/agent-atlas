/**
 * ============================================================
 * static.ts — 前端静态文件分发（白名单式防目录穿越）
 * ============================================================
 * 只服务 public/ 下的单层文件名（`\w - .` 白名单）与已登记的一层子目录
 * （assets/ vendor/ styles/）；全部 no-store，页面和脚本始终取最新构建。
 *
 * M4 4.6 收紧：1:1 过渡树（core/ render/ stream/ views/ … 的逐文件副本）已退役，
 * 白名单同步收缩到真正还会产出的三个目录。少放行一个目录，就少一条潜在的
 * 静态探测面 —— 不再保留「历史上曾经有用」的目录。
 *
 * 在路径正则之外再做 realpath 边界和 lstat 普通文件校验，拒绝符号链接、
 * 未知扩展与目录列表。
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

/**
 * 允许的一层子目录（字面量白名单；不含用户可控段）。
 * - assets：Vite 打包产物（assets/app.js + 动态增强 chunk）
 * - vendor：import map 指向的自包含库（chart/icons/marked/dompurify/highlight）
 * - styles：拷贝过来的样式表
 */
const ALLOWED_DIRS = new Set(["assets", "vendor", "styles"]);

/** Windows 路径大小写不敏感；relative 结果越界时一律拒绝。 */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const raw = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // 形态一：根目录单文件（index.html / favicon 等）
  const single = raw.match(/^(\w[\w.-]*)$/);
  // 形态二：「白名单首段目录」下的任意深度路径。
  // styles/ 按页面分到 base/ chat/ settings/<view>/ 等子目录后是两层相对路径，
  // 这里必须支持多级（安全边界仍由首段白名单 + realpath 越界校验兜住）。
  const nested = raw.match(/^([a-z][a-z0-9-]*)\/((?:[\w.-]+\/)*[\w.-]+)$/);
  if (!single && !nested) return false;

  let rel: string;
  if (nested) {
    const [, dir, rest] = nested;
    if (!ALLOWED_DIRS.has(dir as string)) return false;
    rel = join(dir as string, rest as string);
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
