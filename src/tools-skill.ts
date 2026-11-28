/**
 * tools-skill.ts — use_skill：模型主动读取项目技能全文的受控内部工具
 * ============================================================
 * 渐进式披露第三层：技能目录（skills.ts 常驻注记）让模型知道有什么，
 * 关键词命中自动注入覆盖强相关场景；本工具承接「目录里有、但没自动加载」
 * 的长尾——模型按标识取全文并遵循，不再依赖触发词碰运气。
 * 技能是文档不是代码：工具只把文件内容读进上下文，无副作用、不登记审批。
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getSkillBodyById } from "./skills.js";

export const USE_SKILL_TOOL_NAME = "use_skill";

export const useSkillTool = tool(
  async ({ id }) => {
    const found = await getSkillBodyById(id);
    if (!found) {
      return JSON.stringify({
        ok: false,
        error: `技能「${id}」不存在或未启用。可用技能与标识见上下文中的【技能目录】；目录为空说明当前项目没有可用技能，此时不要编造技能。`,
      });
    }
    return JSON.stringify({ ok: true, id: found.id, name: found.name, body: found.body });
  },
  {
    name: USE_SKILL_TOOL_NAME,
    description:
      "读取项目技能（SKILL 文档）的全文。只有上下文出现【技能目录】注记时才有技能可取：" +
      "目录里有与当前任务相关、但尚未〔已自动加载〕的技能时，用其标识调用本工具，读完按技能执行；" +
      "与任务无关时不要调用。本工具只读文档、无副作用。",
    schema: z.object({
      id: z.string().trim().max(60).describe("技能标识（技能目录每行括号里的 id）"),
    }),
  },
);
