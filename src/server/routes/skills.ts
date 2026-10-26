/**
 * ============================================================
 * routes/skills.ts — 技能库 HTTP 接口
 * ============================================================
 * GET    /api/skills        列出全部技能（含正文，供设置页编辑）
 * POST   /api/skills        新增或更新（同名覆盖）
 * DELETE /api/skills/:id    删除
 * 扫描/匹配逻辑在 skills.ts；这里只做 HTTP 形状与中文错误。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http-body.js";
import { deleteSkill, listSkills, saveSkill, SKILLS_DIR } from "../../skills.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function handleListSkills(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { skills: await listSkills(), dir: SKILLS_DIR });
}

export async function handleSaveSkill(res: ServerResponse, req: IncomingMessage): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "请求体不是合法的 JSON" });
    return;
  }
  try {
    const { skill, created } = await saveSkill(payload as Record<string, unknown>);
    sendJson(res, 200, { skill, created, skills: await listSkills() });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleDeleteSkill(res: ServerResponse, id: string): Promise<void> {
  const decoded = decodeURIComponent(id);
  try {
    const { removed } = await deleteSkill(decoded);
    if (!removed) {
      sendJson(res, 404, { error: `技能「${decoded}」不存在` });
      return;
    }
    sendJson(res, 200, { removed: true, skills: await listSkills() });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
