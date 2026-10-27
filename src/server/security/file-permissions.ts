/**
 * security/file-permissions.ts — 敏感文件权限收紧
 * ============================================================
 * POSIX 使用 0600，目录 0700；Windows 通过 icacls 移除继承并只授权当前用户。
 * 权限设置失败不回滚已确认的数据写入，但必须写 error 日志供诊断。
 */
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../logging.js";

const execFileAsync = promisify(execFile);
const secured = new Set<string>();

export async function secureFilePermissions(path: string, directory = false): Promise<void> {
  const key = `${directory ? "d" : "f"}:${path}`;
  if (secured.has(key)) return;
  try {
    await chmod(path, directory ? 0o700 : 0o600);
    const temporary = resolve(path).toLowerCase().startsWith(resolve(tmpdir()).toLowerCase());
    if (process.platform === "win32" && !temporary) {
      const user = process.env.USERNAME || process.env.USER;
      if (user) {
        await execFileAsync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:${directory ? "(OI)(CI)F" : "F"}`], { windowsHide: true, timeout: 5_000 });
      }
    }
    secured.add(key);
  } catch (err) {
    log("error", "file_permissions_failed", {
      path,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
