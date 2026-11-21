/**
 * tests/helpers/client-html.ts — 读取客户端入口 HTML
 * ============================================================
 * M4 4.5 收尾后 `src/client/index.html` 就是唯一入口（pages/ 片段组装已退役），
 * 结构测试直接读它。保留本助手是为了不改动 60+ 处调用点，同时给「入口是否
 * 被误拆回片段机制」留一个单点收口。
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CLIENT_ROOT = fileURLToPath(new URL("../../src/client/", import.meta.url));
let cached: Promise<string> | undefined;

export function readClientIndexHtml(): Promise<string> {
  cached ??= readFile(`${CLIENT_ROOT}index.html`, "utf8");
  return cached;
}
