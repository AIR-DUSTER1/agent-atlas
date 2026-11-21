/**
 * ============================================================
 * security/password.ts — 用户名密码登录的哈希与策略
 * ============================================================
 * 算法：node:crypto 内置 scrypt（零第三方依赖，符合 AGENTS §3 红线）。
 * 参数 N=16384 / r=8 / p=1，16 字节随机盐，64 字节派生键。
 * 存储格式：`scrypt$N$r$p$saltB64$hashB64`——参数入串，未来升参数可平滑重哈希。
 * 校验一律走 timingSafeEqual，与 auth.ts 的常量时间比较惯例一致。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { ScryptOptions } from "node:crypto";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_LENGTH = 64;
/** 密码策略：最少 10 位（密码锁/登录共用）。 */
export const MIN_PASSWORD_LENGTH = 10;
const SCRYPT_OPTIONS: ScryptOptions = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
const ALGORITHM_TAG = "scrypt";

/**
 * 校验密码策略；返回 null 表示通过，否则返回中文错误说明（怎么改）。
 * 用户名只用于「不得与用户名相同」检查，可传空串跳过。
 */
export function validatePasswordPolicy(username: string, password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `密码至少 ${MIN_PASSWORD_LENGTH} 个字符`;
  }
  if (username && password === username) {
    return "密码不能与用户名相同";
  }
  return null;
}

/** 生成可存储的哈希串；任何报错都向上抛（调用方返回 500，不静默降级）。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
  return [
    ALGORITHM_TAG,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/** 常量时间校验；哈希串损坏/算法不符时返回 false 而不是抛错。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== ALGORITHM_TAG) return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const N = Number(n);
  const rNum = Number(r);
  const pNum = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(rNum) || !Number.isInteger(pNum)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;
  const derived = await scrypt(password.normalize("NFKC"), salt, expected.length, { N, r: rNum, p: pNum });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
