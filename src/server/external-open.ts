/**
 * external-open.ts — 受限外链打开器
 * ============================================================
 * 只允许打开显式授信的 HTTPS 外链，供需要用户浏览器交互的登录流程复用。
 * 禁止 shell 拼接：各平台一律用 spawn 参数数组传 URL，避免命令注入。
 */
import { spawn } from "node:child_process";

/** 解析并校验外链：必须 HTTPS，host 必须精确命中调用方白名单。 */
export function assertAllowedExternalUrl(raw: string, allowedHosts: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("登录链接不是合法 URL");
  }
  if (url.protocol !== "https:") throw new Error(`登录链接必须使用 HTTPS（当前 ${url.protocol}）`);
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`登录链接域名不在白名单（${url.hostname}）`);
  }
  return url;
}

/** 用系统默认浏览器打开已校验的 HTTPS 链接；仅等待“进程成功拉起”。 */
export async function openExternalUrl(raw: string, allowedHosts: ReadonlySet<string>): Promise<void> {
  const url = assertAllowedExternalUrl(raw, allowedHosts);
  const command = process.platform === "win32"
    ? { bin: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url.href] }
    : process.platform === "darwin"
      ? { bin: "open", args: [url.href] }
      : { bin: "xdg-open", args: [url.href] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
