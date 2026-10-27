/**
 * server/csp-hashes.ts — index.html 内联脚本的 CSP 白名单
 * ============================================================
 * script-src 禁止 unsafe-inline 后，主题脚本与 import map 必须精确匹配这里的
 * SHA-256。构建脚本会重新计算并比对，改了 index 却忘记更新会直接失败。
 */
export const CSP_SCRIPT_HASHES = [
  "sha256-vrTsMQtNx9YuIZ7M/3gfSzKRXcdkCF3IOsl3LqnPSZY=",
  "sha256-vM3J1Xxvejy8wiOb/nzTqjPQXBwXdVwDZuJxJBgcE8k=",
] as const;
