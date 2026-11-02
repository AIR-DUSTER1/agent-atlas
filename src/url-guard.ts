/**
 * url-guard.ts — 外网 HTTP(S) 地址安全校验
 * ============================================================
 * `browser_fetch` 与 Browser Use 共用同一套 SSRF 防线：只允许 http/https，
 * 默认拒绝环回、私网、链路本地和单标签主机；显式 allowLocalhost 才放行。
 */

/** 内网 / 环回 / 链路本地判定：命中即拒绝（除非 allowLocalhost）。 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (/^f[cd]/.test(host) || /^fe80:/.test(host)) return true;
  if (!host.includes(".") && !host.includes(":")) return true;
  return false;
}

/** 校验并规范化 URL；不安全时抛中文错误（模型会转述给用户）。 */
export function assertAllowedHttpUrl(raw: string, allowLocalhost: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("URL 格式不合法：需要完整地址，例如 https://example.com/docs");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`不支持的协议 ${url.protocol}：只允许 http / https`);
  }
  if (!allowLocalhost && isPrivateHost(url.hostname)) {
    throw new Error(
      `拒绝访问内网地址 ${url.hostname}：出于安全考虑默认禁止（防 SSRF）。` +
      "如果确实要访问本机或局域网服务，请把 allowLocalhost 设为 true。"
    );
  }
  return url;
}

/** WebSocket 导航同样受私网限制；公网只允许加密的 wss。 */
export function assertAllowedWebSocketUrl(raw: string, allowLocalhost: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("WebSocket URL 格式不合法");
  }
  if (url.protocol !== "wss:" && !(allowLocalhost && url.protocol === "ws:")) {
    throw new Error(`不支持的 WebSocket 协议 ${url.protocol}：公网只允许 wss`);
  }
  if (!allowLocalhost && isPrivateHost(url.hostname)) {
    throw new Error(`拒绝连接内网 WebSocket ${url.hostname}：防 SSRF`);
  }
  return url;
}
