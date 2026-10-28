/**
 * ============================================================
 * start-server.ts — Playwright 专用 mock 服务
 * ============================================================
 * 所有数据写入系统临时目录；强制 API_KEY=""，不会读取用户 .env 或真实配置。
 * 固定测试端口与 token 仅用于本地浏览器 E2E，不进入生产镜像。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "agent-e2e-"));
process.env.HOST = "127.0.0.1";
process.env.PORT = process.env.E2E_PORT || "3467";
process.env.API_KEY = "";
process.env.AUTH_TOKEN = "e2e-login-token-123456";
process.env.SESSION_SECRET = "e2e-session-secret-with-at-least-thirty-two-characters";
process.env.COOKIE_SECURE = "false";
process.env.LOG_LEVEL = "error";
process.env.BEIKE_DISABLE_AUTO_INSTALL = "1";
process.env.WEB_CONFIG_FILE = join(data, "web-config.json");
process.env.SESSIONS_FILE = join(data, "sessions.ndjson");
process.env.CHECKPOINT_FILE = join(data, "checkpoints.ndjson");
process.env.MEMORIES_FILE = join(data, "memories.json");
process.env.SKILLS_DIR = join(data, "skills");
process.env.AUDIT_FILE = join(data, "audit.ndjson");
process.env.BACKUP_DIR = join(data, "backups");

await import("../../src/server/index.js");
