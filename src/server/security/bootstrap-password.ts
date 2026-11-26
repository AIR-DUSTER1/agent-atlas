/**
 * ============================================================
 * security/bootstrap-password.ts — 数据库模式初始管理员密码
 * ============================================================
 * 职责：PostgreSQL 模式强制用户名密码登录，但首次启动时库里没有可用的密码，
 * 登录页会变成「永远进不去」。本模块负责给出一个确定可用的初始密码：
 *
 *  - 优先 BOOTSTRAP_ADMIN_PASSWORD（必须过密码策略，弱密码直接启动失败）；
 *  - 其次复用已有密码文件（重启幂等，不会把上一轮的密码换掉）；
 *  - 都没有时生成 24 位随机密码，写入 0600 文件并只把**路径**写进日志。
 *
 * 设计立场：
 *  - 初始密码一律标记 must_change_password，首次登录必须先改密，避免长期驻留；
 *  - 密码本身永不进日志、不进审计、不通过 HTTP 返回；运维只能从数据目录文件读；
 *  - 文件与 local-user.json 同一安全级别（0600），复用 file-permissions 收紧权限。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validatePasswordPolicy } from "./password.js";
import { secureFilePermissions } from "./file-permissions.js";

/** 随机初始密码长度：18 字节 base64url ≈ 24 字符，远超 10 位策略下限。 */
const GENERATED_PASSWORD_BYTES = 18;
const DEFAULT_PASSWORD_FILE_NAME = "bootstrap-admin-password.txt";

export type InitialPasswordSource = "env" | "file" | "generated";

export interface InitialPassword {
  password: string;
  source: InitialPasswordSource;
  /** 生成/复用的密码文件绝对路径；来自 env 时为 null（不落盘）。 */
  file: string | null;
}

/** 密码文件位置：显式配置优先，否则与 web-config.json 同目录（即 /data）。 */
export function bootstrapPasswordFilePath(configFile: string): string {
  const explicit = (process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE ?? "").trim();
  if (explicit) return explicit;
  return join(dirname(configFile), DEFAULT_PASSWORD_FILE_NAME);
}

/**
 * 取初始密码。调用方必须确保「该管理员当前没有密码」，
 * 本函数不判断是否需要设置，只负责给出一个可用的值。
 */
export async function resolveInitialAdminPassword(configFile: string): Promise<InitialPassword> {
  const fromEnv = (process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "").trim();
  if (fromEnv) {
    const policyError = validatePasswordPolicy("", fromEnv);
    if (policyError) {
      // 启动即失败：与其让人反复试错，不如在日志里说清楚哪里不合格。
      throw new Error(`BOOTSTRAP_ADMIN_PASSWORD 不满足密码策略：${policyError}`);
    }
    return { password: fromEnv, source: "env", file: null };
  }

  const file = bootstrapPasswordFilePath(configFile);
  const existing = await readFile(file, "utf8").catch(() => null);
  if (existing) {
    const reused = existing.trim();
    // 文件被清空或写入弱密码时按「不可用」处理，走重新生成，不静默接受。
    if (reused && !validatePasswordPolicy("", reused)) {
      return { password: reused, source: "file", file };
    }
  }

  const generated = randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url");
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
  await secureFilePermissions(tmp);
  await rename(tmp, file);
  await secureFilePermissions(file);
  return { password: generated, source: "generated", file };
}
