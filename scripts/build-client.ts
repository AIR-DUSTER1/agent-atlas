/**
 * scripts/build-client.ts — 前端构建：TS → 浏览器可执行 ESM + vendor + 静态资源
 * ============================================================
 * 本项目坚持「不加整体打包器」：tsc 一比一编译应用源码，只有 npm 前端库经
 * esbuild 打成自包含 vendor。每次从空目录构建，并校验 import map 对应的
 * CSP hash，任何缺产物或清单漂移都必须非 0 退出。
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildVendors } from "./build-vendor.js";
import { assertCspHashes } from "./csp-integrity.js";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "client");
const OUT = join(ROOT, "src", "server", "public");

/** 需要原样拷到产物目录的静态资源（TS 编译器不处理非 .ts 文件） */
const STATIC_ASSETS = ["index.html", "style.css"];

async function main(): Promise<void> {
  // 每次从空产物目录构建，防止已删除模块继续被静态服务
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // 内联脚本一旦改动而 CSP hash 未同步，浏览器会直接拒绝执行；先 fail-fast
  await assertCspHashes(join(SRC, "index.html"));

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

  for (const name of STATIC_ASSETS) {
    await copyFile(join(SRC, name), join(OUT, name));
  }

  // wrapper 已由 tsc 输出；这里生成同名隔离的 *-lib.js 并做自包含检查
  await buildVendors();

  // 产物自检：入口脚本必须存在，否则页面会白屏而 CI 仍是绿的
  const entries = await readdir(OUT);
  if (!entries.includes("main.js")) {
    console.error("✗ 构建产物缺少 main.js（tsconfig.client.json 的 outDir 是否被改过？）");
    process.exit(1);
  }
  console.log("✓ 前端构建完成 → src/server/public/");
}

void main();
