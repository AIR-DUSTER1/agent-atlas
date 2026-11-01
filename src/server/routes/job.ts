/**
 * routes/job.ts — 求职岗位 Agent（job-hunter CLI）路由
 * ============================================================
 * GET    /api/job            环境状态（技能目录 / python / 依赖 / 最近清单）
 * PUT    /api/job            保存技能目录 / python / 数据目录
 * POST   /api/job/login      打开指定平台的登录页等扫码（长请求，最长 5 分钟）
 * POST   /api/job/doctor     环境自检（对应技能 CLI 的 doctor）
 *
 * 设计立场：
 *  - 登录是**交互步骤**，必须停下来等用户扫码，所以不封装成 Agent 工具，
 *    只在这里暴露给设置页按钮；超时视为「二维码可能过期」，提示重试。
 *  - 所有错误转中文 400，前端直接展示。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, respondBadRequest, BodyTooLargeError } from "../http-body.js";
import { doctorJob, getJobPublic, saveJobConfig, startLogin, JOB_PLATFORMS, type JobPlatform } from "../job.js";
import { bumpConfigVersion } from "../sessions.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function handleGetJob(res: ServerResponse): Promise<void> {
  try {
    sendJson(res, 200, await getJobPublic());
  } catch (err) {
    // 探测失败也要给前端一个可渲染的降级状态，而不是 500 让卡片空着
    sendJson(res, 200, {
      installed: false,
      skillDir: "",
      hasOverride: false,
      pythonOK: false,
      pythonVersion: "",
      depsOK: false,
      depsError: err instanceof Error ? err.message : String(err),
      dataDir: "",
      lastRunJobs: 0,
      lastRunAt: "",
      profilePresent: false,
      platform: process.platform,
    });
  }
}

export async function handleSaveJob(res: ServerResponse, req: IncomingMessage): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
    const status = await saveJobConfig(body);
    // 配置变了：已有会话下一条消息要重建图（工具集随插件开关走，路径变化也影响探测）
    bumpConfigVersion();
    sendJson(res, 200, status);
  } catch (err) {
    if (err instanceof BodyTooLargeError) { respondBadRequest(res, req, err); return; }
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleJobLogin(res: ServerResponse, req: IncomingMessage): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as { platform?: unknown };
    const platform = typeof body.platform === "string" ? body.platform.trim() : "";
    if (!JOB_PLATFORMS.includes(platform as JobPlatform)) {
      throw new Error(`未知平台「${platform}」：可选 ${JOB_PLATFORMS.join(" / ")}`);
    }
    // 这条请求会一直挂到扫码完成或 5 分钟超时 —— 前端要显示「等待扫码中」
    const outcome = await startLogin(platform as JobPlatform);
    sendJson(res, 200, { ok: outcome.ok, summary: outcome.summary, output: outcome.output });
  } catch (err) {
    if (err instanceof BodyTooLargeError) { respondBadRequest(res, req, err); return; }
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleJobDoctor(res: ServerResponse, req: IncomingMessage): Promise<void> {
  await readBody(req).catch(() => "");
  try {
    sendJson(res, 200, await doctorJob());
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
