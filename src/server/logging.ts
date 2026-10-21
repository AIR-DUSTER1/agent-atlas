/**
 * ============================================================
 * logging.ts — 结构化日志（stdout NDJSON，Phase 4）
 * ============================================================
 * 为什么自己写而不引 pino/winston：运行依赖白名单 + 容器采集只需要
 * 「一行一个 JSON」。约定：业务字段在前，time/level/event 由工具最后写入，
 * 保证调用方无法覆盖固定字段；请求体与用户消息永不进日志（只记状态码/耗时），
 * 密钥类字段统一打码。
 * LOG_LEVEL=debug|info|warn|error|silent（默认 info，运行时读取）。
 */
import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/** 级别权重：数值越大越严重，低于当前阈值的直接丢弃 */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

/** 单条日志字符串字段上限：网关错误消息可能很长，截断防日志膨胀 */
const LOG_FIELD_MAX_CHARS = 300;
/** 数组字段最多保留的条数（超出的只留计数） */
const LOG_ARRAY_MAX_ITEMS = 50;
/** 嵌套深度上限：防止循环引用对象把日志序列化拖死 */
const LOG_MAX_DEPTH = 4;

/**
 * 敏感字段名（小写精确匹配）：不能只做模糊匹配，否则 inputTokens 这类
 * 正常指标也会被打码。新增密钥字段时在这里登记。
 */
const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|password|passwd|secret|token|apikey|api_key|api-key|bearer|auth_token|access_token|refresh_token|client_secret|private_key)$/i;

/** 每个请求一个短 id：错误响应头与日志用同一个，便于把用户反馈对到服务端日志 */
export function newRequestId(): string {
  return randomUUID();
}

export function currentLogLevel(): LogLevel {
  const value = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return value in LEVEL_WEIGHT ? (value as LogLevel) : "info";
}

export function isLevelEnabled(level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[currentLogLevel()];
}

/** 递归打码 + 截断；只处理 JSON 可序列化的普通值 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > LOG_MAX_DEPTH) return "[depth-limit]";
  if (typeof value === "string") {
    return value.length > LOG_FIELD_MAX_CHARS
      ? `${value.slice(0, LOG_FIELD_MAX_CHARS)}…(共 ${value.length} 字符)`
      : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, LOG_ARRAY_MAX_ITEMS).map((item) => redact(item, depth + 1));
    return value.length > LOG_ARRAY_MAX_ITEMS ? [...head, `…(共 ${value.length} 项)`] : head;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "***" : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** 纯格式化（单测入口）：时间可注入，保证断言稳定 */
export function buildLogLine(
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: Record<string, unknown> = {},
  now: Date = new Date()
): string {
  const safe = redact(fields) as Record<string, unknown>;
  // 固定字段放最后：业务字段不能覆盖 time/level/event
  return JSON.stringify({ ...safe, time: now.toISOString(), level, event });
}

/** 输出一行日志（stdout：Docker / systemd 都能直接采集） */
export function log(level: Exclude<LogLevel, "silent">, event: string, fields: Record<string, unknown> = {}): void {
  if (!isLevelEnabled(level)) return;
  process.stdout.write(buildLogLine(level, event, fields) + "\n");
}
