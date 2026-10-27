/** Bearer 校验独立成最小模块，避免会话 Cookie 与旧客户端兼容互相依赖。 */
import { createHash, timingSafeEqual } from "node:crypto";

function currentToken(): string {
  return (process.env.AUTH_TOKEN ?? "").trim();
}

export function verifyBearer(req: import("node:http").IncomingMessage): boolean {
  const expected = currentToken();
  if (!expected) return true;
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const a = createHash("sha256").update(match[1]).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
