/**
 * ============================================================
 * security/secrets.ts — 配置文件敏感字段透明加密
 * ============================================================
 * 职责：在 JSON 落盘前把 apiKey / token / secret / MCP env 等字符串替换为
 * AES-256-GCM 密封对象，读取时再解回内存明文。
 * 设计立场：
 *  - 内存模块语义不变，只有磁盘格式变化，避免各业务模块重复处理密文；
 *  - 每个值独立 IV；密文带 v/iv/tag/createdAt，拒绝静默降级；
 *  - 无 DATA_KEY 的开发模式保留明文并显式告警，生产模式由启动门禁拒绝。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SealedSecret {
  __agentSecret: true;
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
  createdAt: number;
}

const SENSITIVE_KEY = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|authorization|cookie)/i;

export class SecretDecryptionError extends Error {
  constructor(message = "DATA_KEY 无法解密配置中的敏感字段；请恢复原 DATA_KEY 或回滚配置备份") {
    super(message);
    this.name = "SecretDecryptionError";
  }
}

export function dataKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = (env.DATA_KEY ?? "").trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function hasDataKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return dataKey(env) !== null;
}

export function isSealedSecret(value: unknown): value is SealedSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<SealedSecret>;
  return item.__agentSecret === true && item.v === 1 && item.alg === "aes-256-gcm" &&
    typeof item.iv === "string" && typeof item.tag === "string" && typeof item.data === "string" &&
    typeof item.createdAt === "number";
}

export function encryptSecret(plaintext: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): SealedSecret {
  const key = dataKey(env);
  if (!key) throw new Error("缺少合法 DATA_KEY（32 字节 base64），拒绝保存敏感配置");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    __agentSecret: true,
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    createdAt: now,
  };
}

export function decryptSecret(value: SealedSecret, env: NodeJS.ProcessEnv = process.env): string {
  const key = dataKey(env);
  if (!key) throw new SecretDecryptionError("缺少 DATA_KEY，无法解密已有敏感配置");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretDecryptionError();
  }
}

function sensitiveKey(key: string, envContext: boolean): boolean {
  return envContext || SENSITIVE_KEY.test(key);
}

/**
 * 递归封存配置。env 映射中的所有字符串都视为凭据（例如 MCP 的 API_TOKEN），
 * 其它字段只处理名称明确的敏感键，避免误伤模型名 / 命令参数。
 */
export function sealSensitiveConfig(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  envContext = false,
): unknown {
  // 开发模式无 DATA_KEY：保留明文，后续配置可利用同一流水线写盘。
  if (!hasDataKey(env)) return value;
  if (typeof value === "string") {
    if (!envContext) return value;
    return value ? encryptSecret(value, env, now) : value;
  }
  if (Array.isArray(value)) return value.map((item) => sealSensitiveConfig(item, env, now, envContext));
  if (!value || typeof value !== "object") return value;
  if (isSealedSecret(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const childEnvContext = envContext || /^(?:env|environment)$/i.test(key);
    if (typeof item === "string" && sensitiveKey(key, childEnvContext) && item) {
      out[key] = encryptSecret(item, env, now);
    } else {
      out[key] = sealSensitiveConfig(item, env, now, childEnvContext);
    }
  }
  return out;
}

/** 读取时解开任意深度的密封对象；未知/损坏密文必须 fail-closed。 */
export function unsealSensitiveConfig(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (isSealedSecret(value)) return decryptSecret(value, env);
  if (Array.isArray(value)) return value.map((item) => unsealSensitiveConfig(item, env));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = unsealSensitiveConfig(item, env);
  }
  return out;
}

/** 判断配置中是否仍有明文凭据；备份清单据此标注 plaintext-risk。 */
export function hasPlaintextSecrets(value: unknown, envContext = false): boolean {
  if (Array.isArray(value)) return value.some((item) => hasPlaintextSecrets(item, envContext));
  if (!value || typeof value !== "object" || isSealedSecret(value)) return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const childEnvContext = envContext || /^(?:env|environment)$/i.test(key);
    if (typeof item === "string" && sensitiveKey(key, childEnvContext) && item.trim()) return true;
    if (item && typeof item === "object" && hasPlaintextSecrets(item, childEnvContext)) return true;
  }
  return false;
}

/** 配置中是否存在已封存的敏感值；用于区分 encrypted 与 none。 */
export function hasSealedSecrets(value: unknown): boolean {
  if (isSealedSecret(value)) return true;
  if (Array.isArray(value)) return value.some(hasSealedSecrets);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(hasSealedSecrets);
}