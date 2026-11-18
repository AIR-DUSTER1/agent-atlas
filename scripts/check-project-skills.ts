/**
 * ============================================================
 * scripts/check-project-skills.ts — 项目 Skill 校验入口
 * ============================================================
 * 输出常驻规范大小、领域 Skill 大小和路由完整性；任一结构问题以非 0 退出。
 */
import { validateProjectSkills } from "./project-skills.js";

async function main(): Promise<void> {
  const { issues, report } = await validateProjectSkills();
  if (issues.length) {
    for (const issue of issues) console.error(`✗ ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 项目规范分层通过：AGENTS.md ${report.agentsBytes} bytes / ${report.agentsLines} lines`);
  for (const skill of report.skills) {
    console.log(`  - ${skill.name}: ${skill.bytes} bytes / ${skill.lines} lines / description ${skill.descriptionChars} chars`);
  }
  console.log(`  领域 Skill 总计：${report.skills.length} 个，${report.totalSkillBytes} bytes（按需加载）`);
}

void main().catch((err) => {
  console.error(`项目 Skill 校验失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
