/**
 * url-guard.ts — 外网 HTTP(S) 地址安全校验
 * ============================================================
 * `browser_fetch` 与 Browser Use 共用同一套 SSRF 防线：只允许 http/https，
 * 默认拒绝环回、私网、链路本地和单标签主机；显式 allowLocalhost 才放行。
 */

/** 内网 / 环回 / 链路本地判定：命中即拒绝（除非 allowLocalhost）。 */
export function isPrivateHost(hostname: string): boolean {
  // 先按主机名字符串处理单标签与显式回环域，再交给 node:net 判 IPv4/IPv6。
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  // 去掉方括号后交给 net.isIP 判断；IPv6 里即使非已知私网段也应保守拒绝，
  // 避免 IPv4-mapped / 未规范化写法绕过（审核报告 P1-12/P1-25）。
  const host = lower.replace(/^\[|\]$/g, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 保留 192.0.0/24、198.18/15 等文档/基准网段为私网风险面。
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    return false;
  }
  if (/^fe[89ab]?:|^f[cd][0-9a-f]{2}:/.test(host) || /^::|^0:0:0:0:0:0:0:/.test(host)) return true;
  if (host.includes(":")) {
    // 除明确放行的公网 IPv6 外，任何 IPv6 一律拒绝：SSRF 面最稳妥（保守策略）。
    return true;
  }
  if (!host.includes(".") && !host.includes(":")) return true;
  return false;
}
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
