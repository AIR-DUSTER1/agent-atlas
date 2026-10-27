/**
 * ============================================================
 * security/rate-limit.ts — 登录失败双桶限流
 * ============================================================
 * 单 IP 5 次 / 15 分钟，全局 100 次 / 15 分钟。只统计失败，不改业务状态；
 * 成功登录清空该 IP 桶，避免共享出口偶发输错后长期锁死。
 */
import type { IncomingMessage } from "node:http";

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  remainingIp: number;
  remainingGlobal: number;
}

const DEFAULT_WINDOW_MS = 15 * 60_000;
const DEFAULT_IP_LIMIT = 5;
const DEFAULT_GLOBAL_LIMIT = 100;

export class FailureRateLimiter {
  private readonly ipFailures = new Map<string, number[]>();
  private globalFailures: number[] = [];

  constructor(
    private readonly ipLimit = DEFAULT_IP_LIMIT,
    private readonly globalLimit = DEFAULT_GLOBAL_LIMIT,
    private readonly windowMs = DEFAULT_WINDOW_MS,
  ) {}

  private prune(list: number[], now: number): number[] {
    const cutoff = now - this.windowMs;
    return list.filter((ts) => ts > cutoff);
  }

  check(ip: string, now = Date.now()): RateLimitDecision {
    const current = this.prune(this.ipFailures.get(ip) ?? [], now);
    this.ipFailures.set(ip, current);
    this.globalFailures = this.prune(this.globalFailures, now);
    const blockedByIp = current.length >= this.ipLimit;
    const blockedGlobally = this.globalFailures.length >= this.globalLimit;
    const oldest = Math.min(
      current.length >= this.ipLimit ? current[0] : Number.POSITIVE_INFINITY,
      this.globalFailures.length >= this.globalLimit ? this.globalFailures[0] : Number.POSITIVE_INFINITY,
    );
    const retryAfterSeconds = blockedByIp || blockedGlobally
      ? Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000))
      : 0;
    return {
      allowed: !blockedByIp && !blockedGlobally,
      retryAfterSeconds,
      remainingIp: Math.max(0, this.ipLimit - current.length),
      remainingGlobal: Math.max(0, this.globalLimit - this.globalFailures.length),
    };
  }

  recordFailure(ip: string, now = Date.now()): RateLimitDecision {
    const current = this.prune(this.ipFailures.get(ip) ?? [], now);
    current.push(now);
    this.ipFailures.set(ip, current);
    this.globalFailures = this.prune(this.globalFailures, now);
    this.globalFailures.push(now);
    return this.check(ip, now);
  }

  clear(ip: string): void {
    this.ipFailures.delete(ip);
  }

  reset(): void {
    this.ipFailures.clear();
    this.globalFailures = [];
  }
}

export const authFailureLimiter = new FailureRateLimiter();

/** 代理链只在显式 TRUST_PROXY=1 时信任 X-Forwarded-For，防客户端伪造绕过限流。 */
export function clientIp(req: IncomingMessage): string {
  if ((process.env.TRUST_PROXY ?? "").trim() === "1") {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || "unknown";
}
