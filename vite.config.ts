/**
 * vite.config.ts — 前端构建配置（框架迁移 M3：Vite 接管构建链）
 * ============================================================
 * 迁移契约（framework-migration-plan.md §4-M3）：
 *  - root 指向 src/client，入口是 build-client 组装出的 index.vite.html
 *    （compose 片段 + build-info + CSP hash 校验之后写入，见 scripts/build-client.ts）；
 *  - 产物落到 src/server/public（与平移前 tsc 输出同目录，服务端零改动）；
 *  - base "./" 保证 Electron file:// 加载；
 *  - assetsInlineLimit 0：禁止内联资源，CSP「无内联脚本/样式」语义不变；
 *  - publicDir false：CSS 仍由 build-client 的 copyStyles 复制，避免双份拷贝；
 *  - 入口产物固定名 assets/app.js（不哈希）：服务端 Cache-Control 全量 no-store，
 *    哈希换不来缓存收益，稳定文件名简化 static.ts 白名单 / Dockerfile / 冒烟检查。
 *  - vendor wrapper（chart/icons/markdown/highlight）的动态 import 由 Vite 代码分割
 *    成独立 chunk，「可选增强不进首屏启动闭包」红线保持；import map 仍在 HTML 里
 *    （源码不动），打包后不再被消费。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// rollup 的相对 input 按 CWD 解析而不是 vite root —— 必须给绝对路径
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));
const COMPOSED_ENTRY = resolve(CONFIG_DIR, "src/client/index.vite.html");

export default defineConfig({
  root: "src/client",
  publicDir: false,
  base: "./",
  build: {
    outDir: "../server/public",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: COMPOSED_ENTRY,
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
