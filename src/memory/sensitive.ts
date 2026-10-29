/**
 * sensitive.ts — 长期记忆写入前的敏感信息防线
 * ============================================================
 * 高置信 secret 永远拒绝；手机号 / 身份证默认拒绝，只有设置层显式 allowPII
 * 才能放行。错误信息只描述类别，不回显原文，避免日志或 UI 二次泄露。
 */
export interface SensitiveFinding {
  kind: "secret" | "pii";
  reason: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/i,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /(?:password|passwd|pwd|secret|token|api[_-]?key|密码|密钥|令牌)\s*[:=：]\s*[^\s,，。]{6,}/i,
];

const PII_PATTERNS: RegExp[] = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /(?<!\d)\d{17}[\dXx](?!\d)/,
];

export function detectSensitiveMemory(content: string): SensitiveFinding | null {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) return { kind: "secret", reason: "内容疑似包含密钥、令牌或密码" };
  }
  for (const pattern of PII_PATTERNS) {
    if (pattern.test(content)) return { kind: "pii", reason: "内容疑似包含手机号或身份证号" };
  }
  return null;
}
