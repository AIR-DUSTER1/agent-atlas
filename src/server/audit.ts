/**
 * ============================================================
 * audit.ts — 安全动作审计日志（append-only NDJSON，Phase 1）
 * ============================================================
 * 职责：把「改了配置/执行了什么/下载了什么」这类安全边界动作落到达
 * `.setting/audit.ndjson`，每个事件一行 JSON：{ ts, ev, ...detail }。
 * 覆盖面：外部 Agent 注册/删除/凭证开关/每次执行、贝壳 CLI 安装（含
 * URL/版本/sha256）、','-32001' 手动升级确认等。
 * 设计立场：
 *  - append-only：不修改已有行，滚动只做尾部截断（超 1MB 留最近 512KB）；
 *  - 写审计绝不能挂业务：fire-and-forget 且函数内自吞全部异常（AGENTS §4.4）；
 *  - 调用方负责在 detail 里完成敏感信息（Api Key 等）掩码，这里只保证单行化。
 */
import { promises as fsp } from "node:fs";
import { join, dirname } from "node:path";
import { PROJECT_ROOT } from "./files.js";

const AUDIT_FILE = join(PROJECT_ROOT, ".setting", "audit.ndjson");
/** 单文件字节上限：学习项目敲定 1MB，超出滚动（尾部保留） */
const AUDIT_MAX_BYTES = 1_000_000;
const AUDIT_TRIM_KEEP_BYTES = 512_000;

export function writeAudit(event: string, detail: Record<string, unknown>): void {
  void (async () => {
    try {
      await fsp.mkdir(dirname(AUDIT_FILE), { recursive: true });
      const line = JSON.stringify({ ts: new Date().toISOString(), ev: event, ...detail }) + "\n";
      await fsp.appendFile(AUDIT_FILE, line, "utf8");
      const st = await fsp.stat(AUDIT_FILE).catch(() => null);
      if (st && st.size > AUDIT_MAX_BYTES) {
        const raw = await fsp.readFile(AUDIT_FILE, "utf8");
        const tail = raw.slice(-AUDIT_TRIM_KEEP_BYTES).replace(/^[^\n]*\n/, ""); // 去掉被截的半行
        await fsp.writeFile(AUDIT_FILE, tail, "utf8");
      }
    } catch { /* 审计失败静默：不能影响主流程 */ }
  })();
}
