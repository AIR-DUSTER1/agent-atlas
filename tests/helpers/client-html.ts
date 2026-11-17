/**
 * tests/helpers/client-html.ts — 读取构建期组合后的客户端入口
 * ============================================================
 * 源码入口只保留 include 清单；结构测试必须针对组合后的完整 HTML，
 * 否则会把“入口是否足够薄”和“页面结构是否存在”混成同一条脆弱断言。
 */
import { fileURLToPath } from "node:url";
import { composeHtml } from "../../scripts/compose-html.js";

const CLIENT_ROOT = fileURLToPath(new URL("../../src/client/", import.meta.url));
let cached: Promise<string> | undefined;

export function readClientIndexHtml(): Promise<string> {
  cached ??= composeHtml(`${CLIENT_ROOT}index.html`, CLIENT_ROOT);
  return cached;
}