/**
 * ============================================================
 * routes/skills.ts — 技能库 HTTP 接口
 * ============================================================
 * GET    /api/skills              列出全部技能（含正文与 enabled，供设置页展示）
 * POST   /api/skills              更新已有技能（管理界面不提供新建入口）
 * POST   /api/skills/import       批量导入用户上传的 .md / .markdown
 * PATCH  /api/skills/:id          启用或禁用技能
 * DELETE /api/skills/:id          删除
 * 扫描/匹配逻辑在 skills.ts；这里只做 HTTP 形状与中文错误。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyTooLargeError, readBody, respondBadRequest } from "../http-body.js";
import { deleteSkill, importSkillFiles, listSkills, saveSkill, setSkillEnabled, SKILLS_DIR } from "../../skills.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readBody(req));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(res, 400, { error: "请求体必须是 JSON 对象" });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      respondBadRequest(res, req, err);
      return null;
    }
    sendJson(res, 400, { error: "请求体不是合法的 JSON" });
    return null;
  }
}

function decodeSkillId(id: string): string | null {
  try {
    return decodeURIComponent(id);
  } catch {
    return null;
  }
}

export async function handleListSkills(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { skills: await listSkills(), dir: SKILLS_DIR });
}

export async function handleSaveSkill(res: ServerResponse, req: IncomingMessage): Promise<void> {
  const payload = await readJsonObject(req, res);
  if (!payload) return;
  try {
    const { skill, created } = await saveSkill(payload);
    sendJson(res, 200, { skill, created, skills: await listSkills() });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleImportSkills(res: ServerResponse, req: IncomingMessage): Promise<void> {
  const payload = await readJsonObject(req, res);
  if (!payload) return;
  try {
    const result = await importSkillFiles(payload.files, payload.overwrite);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleSetSkillEnabled(res: ServerResponse, req: IncomingMessage, rawId: string): Promise<void> {
  const id = decodeSkillId(rawId);
  if (!id) {
    sendJson(res, 400, { error: "技能标识编码无效" });
    return;
  }
  const payload = await readJsonObject(req, res);
  if (!payload) return;
  try {
    const skill = await setSkillEnabled(id, payload.enabled);
    sendJson(res, 200, { skill, skills: await listSkills() });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleDeleteSkill(res: ServerResponse, rawId: string): Promise<void> {
  const id = decodeSkillId(rawId);
  if (!id) {
    sendJson(res, 400, { error: "技能标识编码无效" });
    return;
  }
  try {
    const { removed } = await deleteSkill(id);
    if (!removed) {
      sendJson(res, 404, { error: `技能「${id}」不存在` });
      return;
    }
    sendJson(res, 200, { removed: true, skills: await listSkills() });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}