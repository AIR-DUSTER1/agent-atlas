/**
 * scripts/build-client.ts — 前端构建：TS → 浏览器可执行 ESM + 静态资源拷贝
 * ============================================================
 * 为什么需要这一步：前端已全面 TypeScript 化（有类型检查、单文件 ≤500 行），
 * 但浏览器只能执行 JS，所以必须有编译步骤。本项目坚持「不加打包器」：
 * 只用 tsc 把 src/client/**.ts 一比一编译到 src/server/public/，
 * import 路径保持原样（浏览器原生 ESM 直接加载），再把 index.html / style.css
 * 原样拷过去。产物目录进 .gitignore，源码才是唯一真相。
 *
 * 约束：与 tsconfig.client.json 的 rootDir/outDir 保持一致；
 * 编译失败必须非 0 退出（CI 与 preweb/pretest 都靠退出码把关）。
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "client");
const OUT = join(ROOT, "src", "server", "public");

/** 需要原样拷到产物目录的静态资源（TS 编译器不处理非 .ts 文件） */
const STATIC_ASSETS = ["index.html", "style.css"];

async function main(): Promise<void> {
  // tsc 用项目本地版本：直接调 node_modules 里的 tsc，避免 PATH 差异
  const tscBin = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  try {
    await execFileAsync(process.execPath, [tscBin, "-p", join(ROOT, "tsconfig.client.json")], {
      cwd: ROOT,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    console.error("✗ 前端 TypeScript 编译失败");
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });
  for (const name of STATIC_ASSETS) {
    await copyFile(join(SRC, name), join(OUT, name));
  }

  // 产物自检：入口脚本必须存在，否则页面会白屏而 CI 仍是绿的
  const entries = await readdir(OUT);
  if (!entries.includes("main.js")) {
    console.error("✗ 构建产物缺少 main.js（tsconfig.client.json 的 outDir 是否被改过？）");
    process.exit(1);
  }
  console.log("✓ 前端构建完成 → src/server/public/");
}

void main();
