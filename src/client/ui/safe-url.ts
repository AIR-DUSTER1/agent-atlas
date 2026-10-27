/**
 * ui/safe-url.ts — 前端 URL 属性统一白名单
 * ============================================================
 * href/src/xlink:href 是 DOM 注入之外的另一条危险路径。所有动态 URL 必须
 * 先经这里归一化；相对地址允许，危险 scheme 与伪协议直接返回 null。
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

export interface UrlPolicy {
  /** 是否允许 data:image；只给 img/src 使用 */ allowDataImage?: boolean;
  /** 是否允许 mailto；只给 a/href 使用 */ allowMailto?: boolean;
}

export function safeUrl(raw: string | null | undefined, policy: UrlPolicy = {}): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || CONTROL_CHARS.test(value)) return null;
  if (value.startsWith("#") || value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return value.startsWith("//") ? null : value;
  }
  if (policy.allowDataImage && DATA_IMAGE.test(value)) return value;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
  if (policy.allowMailto && parsed.protocol === "mailto:") return parsed.href;
  return null;
}

export function safeHref(raw: string | null | undefined): string | null {
  return safeUrl(raw, { allowMailto: true });
}

export function safeImageSrc(raw: string | null | undefined): string | null {
  return safeUrl(raw, { allowDataImage: true });
}
