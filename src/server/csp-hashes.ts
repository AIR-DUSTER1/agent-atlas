/**
 * server/csp-hashes.ts — index.html 内联脚本的 CSP 白名单
 * ============================================================
 * script-src 禁止 unsafe-inline 后，主题恢复脚本必须精确匹配这里的 SHA-256。
 * 构建脚本会重新计算并比对，改了 index 却忘记更新会直接失败。
 *
 * M4 4.6：import map 已随 vendor 自包含库退役（npm 包由 Vite 打包），
 * 白名单从两条降为一条。
 */
export const CSP_SCRIPT_HASHES = [
  "sha256-KGKZGXqsmVkA8QMIa02enykHZ5ZO3ZA78NLCM4vQSwQ=",
] as const;
