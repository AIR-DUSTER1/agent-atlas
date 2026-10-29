/**
 * ============================================================
 * observability/diagnostics.ts — 聚合诊断快照
 * ============================================================
 * 返回版本、就绪、数据健康、备份完整性、密钥状态和外部依赖最近状态；
 * 不返回文件路径、内网地址、提示词、工具正文或密钥。
 */
import { auditBackups } from "../backup.js";
import { auditHealthReport } from "../audit.js";
import { CONFIG_SCHEMA_VERSION, configSecretsState } from "../config-store.js";
import { readinessSnapshot } from "../health.js";
import { isAuthEnabled } from "../auth.js";
import { checkpointHealthReport, CHECKPOINT_SCHEMA_VERSION } from "../../checkpoint.js";
import { journalHealthReport, JOURNAL_SCHEMA_VERSION } from "../session-store.js";
import { getRagPublic, ragRuntimeSnapshot } from "../rag.js";
import { listMcpStatus, mcpRuntimeSnapshots, type McpServerStatus } from "../mcp.js";
import { listDependencyStatuses } from "./dependency-status.js";
import { isProductionMode } from "../production.js";
import { modelGateSnapshots } from "../runtime/model-gate.js";
import { memorySlot } from "../../memory/slot.js";
import { MEMORY_SCHEMA_VERSION } from "../../memory/providers/local-store.js";
import { memoryStoreStatus } from "../../memory-store.js";
import { readMemoryConfig } from "../memory-config.js";
import type { NdjsonHealthReport } from "../persistence/ndjson-health.js";

function safeNdjson(report: NdjsonHealthReport | null) {
  if (!report) return null;
  return {
    exists: report.exists,
    schemaVersion: report.schemaVersion,
    schemaHeaderFound: report.schemaHeaderFound,
    totalLines: report.totalLines,
    validLines: report.validLines,
    badLines: report.badLines,
    quarantined: report.quarantined,
    sizeBytes: report.sizeBytes,
    checkedAt: report.checkedAt,
  };
}

export async function buildDiagnostics(): Promise<Record<string, unknown>> {
  const [ready, secrets, backups, audit, rag, mcp, memoryHealth, memoryConfig] = await Promise.all([
    readinessSnapshot(),
    configSecretsState(),
    auditBackups(),
    auditHealthReport(),
    getRagPublic().catch(() => ({ configured: false })),
    listMcpStatus().catch(() => []),
    memorySlot.health().catch(() => ({ providerId: "local" as const, status: "unavailable" as const, latencyMs: 0, message: "记忆状态不可用" })),
    readMemoryConfig().catch(() => null),
  ]);
  const memoryLocal = memoryStoreStatus();
  const journal = safeNdjson(journalHealthReport());
  const checkpoint = safeNdjson(checkpointHealthReport());
  const dependencies = listDependencyStatuses();
  const unhealthyMcp = mcp.filter((server) => server.enabled && !server.connected);
  const degraded = secrets === "plaintext-risk" || backups.invalid > 0 || Boolean(audit.lastError) || unhealthyMcp.length > 0 ||
    dependencies.some((item) => item.state === "down" || item.state === "degraded");
  return {
    generatedAt: Date.now(),
    status: !ready.ok ? "error" : degraded ? "degraded" : "ok",
    runtime: {
      version: ready.version,
      uptimeSeconds: ready.uptimeSeconds,
      production: isProductionMode(),
      authRequired: isAuthEnabled(),
      shuttingDown: ready.shuttingDown,
    },
    readiness: { ok: ready.ok, checks: ready.checks },
    schemaVersions: {
      config: CONFIG_SCHEMA_VERSION,
      journal: JOURNAL_SCHEMA_VERSION,
      checkpoint: CHECKPOINT_SCHEMA_VERSION,
      memory: MEMORY_SCHEMA_VERSION,
    },
    data: {
      journal,
      checkpoint,
      memory: {
        state: memoryLocal.state,
        activeCount: memoryLocal.activeCount,
        historyCount: memoryLocal.historyCount,
        migratedFrom: memoryLocal.migratedFrom ?? null,
        quarantined: Boolean(memoryLocal.quarantinedTo),
      },
    },
    backups: {
      total: backups.total,
      valid: backups.valid,
      invalid: backups.invalid,
      issues: backups.issues,
    },
    secrets,
    dependencies: {
      rag: { configured: Boolean((rag as { configured?: boolean }).configured), last: dependencies.find((d) => d.id === "rag") ?? null, runtime: ragRuntimeSnapshot() },
      memory: {
        activeProvider: memoryHealth.providerId,
        status: memoryHealth.status,
        latencyMs: memoryHealth.latencyMs ?? null,
        message: memoryHealth.message ?? "",
        httpEnabled: memoryConfig?.http.enabled ?? false,
        preset: memoryConfig?.http.preset ?? "generic",
      },
      mcp: mcp.map((server) => ({ id: server.id, enabled: server.enabled, connected: server.connected, error: server.error ?? "" })),
      mcpRuntime: mcpRuntimeSnapshots(),
      modelRuntime: modelGateSnapshots(),
      other: dependencies.filter((d) => d.id !== "rag"),
    },
  };
}
