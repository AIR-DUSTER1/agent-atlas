/**
 * ============================================================
 * audit-production.ts — 阻断 high / critical 生产依赖漏洞
 * ============================================================
 * npm 镜像常不实现 audit API，因此显式使用官方 registry；网络或解析失败同样
 * 非 0，避免“查不到漏洞”被误当成“没有漏洞”。只审计 omit=dev 的运行依赖。
 */
import { spawnSync } from "node:child_process";

interface AuditReport {
  vulnerabilities?: Record<string, { severity?: string }>;
  metadata?: { vulnerabilities?: Record<string, number> };
  error?: { summary?: string };
}

function npmCommand(): { command: string; prefix: string[] } {
  const cli = process.env.npm_execpath;
  if (cli) return { command: process.execPath, prefix: [cli] };
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [] };
}

const registry = process.env.NPM_AUDIT_REGISTRY || "https://registry.npmjs.org";
const npm = npmCommand();
const result = spawnSync(npm.command, [
  ...npm.prefix,
  "audit",
  "--omit=dev",
  "--json",
  `--registry=${registry}`,
], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 13 * 1024 * 1024,
  windowsHide: true,
});

let report: AuditReport | null = null;
try {
  report = JSON.parse(result.stdout || "{}") as AuditReport;
} catch {
  // 下面统一按“无法完成审计”失败。
}

if (!report || report.error) {
  const detail = report?.error?.summary || result.stderr.trim() || result.stdout.trim() || "未知错误";
  console.error(`生产依赖审计无法完成：${detail.slice(0, 1200)}`);
  process.exit(2);
}

const vulnerabilities = report.vulnerabilities ?? {};
const blocking = Object.entries(vulnerabilities).filter(([, item]) =>
  item.severity === "high" || item.severity === "critical"
);
const counts = report.metadata?.vulnerabilities ?? {};
const moderate = Number(counts.moderate ?? 0);
const low = Number(counts.low ?? 0);

if (blocking.length > 0) {
  console.error(`生产依赖存在 high / critical 漏洞：${blocking.map(([name, item]) => `${name}(${item.severity})`).join(", ")}`);
  process.exit(1);
}

console.log(`生产依赖审计通过：high=0 critical=0；advisory moderate=${moderate} low=${low}`);
