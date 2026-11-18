/**
 * ============================================================
 * client/core/build-info.ts — 浏览器构建身份读取层
 * ============================================================
 * 版本由构建脚本注入 index.html 的 meta；浏览器不再手工维护日期版本号。
 */
import { PRODUCT_NAME } from "../modules/product.js";

export interface ClientBuildInfo {
  version: string;
  channel: string;
  releaseStage: string;
  commit: string;
  builtAt: string;
  buildId: string;
}

function meta(name: string): string {
  if (typeof document === "undefined") return "unknown";
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content?.trim() || "unknown";
}

export const BUILD_INFO: ClientBuildInfo = {
  version: meta("agentatlas-version"),
  channel: meta("agentatlas-channel"),
  releaseStage: meta("agentatlas-release-stage"),
  commit: meta("agentatlas-commit"),
  builtAt: meta("agentatlas-built-at"),
  buildId: meta("agentatlas-build-id"),
};

export function formatBuildLabel(): string {
  const commit = BUILD_INFO.commit === "unknown" ? "" : ` · ${BUILD_INFO.commit.slice(0, 8)}`;
  return `${BUILD_INFO.version}${commit}`;
}

export function logBuildInfo(): void {
  console.log(
    `%c[${PRODUCT_NAME}] 前端已加载 ${formatBuildLabel()} · ${BUILD_INFO.channel}`,
    "color:#fff;background:#5b8cff;padding:2px 8px;border-radius:4px"
  );
}
