/**
 * vendor/markdown.ts — Markdown 解析与净化的唯一入口
 * marked 与 DOMPurify 必须同进同出；业务不得直接 import 这两个 npm 包。
 */
import { marked } from "marked";
import DOMPurify from "dompurify";
export { marked, DOMPurify };
