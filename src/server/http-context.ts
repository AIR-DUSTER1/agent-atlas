/**
 * ============================================================
 * http-context.ts — HTTP 入口共用的环境常量（框架迁移 M1）
 * ============================================================
 * index.ts（进程入口 / 启动横幅）与 app.ts（中间件栈）都要用这组常量；
 * 单独成模块避免两者互相 import 成环。语义与平移前 index.ts 的定义完全一致。
 */
import { isAuthEnabled } from "./auth.js";

export const PORT = Number(process.env.PORT ?? 3000);
/**
 * Phase 0 安全止血：默认只监听 loopback。
 * 本服务的接口可以改配置、起子进程、读服务器文件 —— 绑 0.0.0.0 等于把控制权
 * 暴露给局域网。需要显式开放时设置 HOST=0.0.0.0（此时若仍未配置认证，暴露
 * 防线会拒绝所有写请求并输出醒目警告）。
 */
export const HOST = process.env.HOST ?? "127.0.0.1";
/** 认证是否已启用（auth.ts 提供判定；用于启动提示与 Phase 0 边界短路） */
export const AUTH_ENABLED = isAuthEnabled();
/** 服务是否绑定在 loopback 上（HOST=0.0.0.0 / :: 之外的地址都视为仅本机可用） */
export const LOOPBACK_HOST = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
/** 未认证 + 对外开放模式下统一的拒绝文案 */
export const EXPOSED_NOAUTH_ERR =
  "服务当前以非本机地址开放且未配置认证（AUTH_TOKEN），已拒绝该操作。" +
  "请设置环境变量 AUTH_TOKEN 后携带 Bearer token 访问，或改用 HOST=127.0.0.1 仅本机使用";
