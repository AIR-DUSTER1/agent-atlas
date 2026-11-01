import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGoalCommand } from "../../src/client/modules/goal.js";

test("goal 命令：带任务、裸命令与普通消息三种形态", () => {
  const withTask = parseGoalCommand("/goal 修复所有构建错误并让测试通过");
  assert.equal(withTask?.task, "修复所有构建错误并让测试通过");

  // 菜单选中后输入框是 "/goal "，直接回车 = 裸命令
  const bare = parseGoalCommand("/goal ");
  assert.deepEqual(bare, { task: "" });

  const bareNoSpace = parseGoalCommand("/goal");
  assert.deepEqual(bareNoSpace, { task: "" });

  // 命令名必须独立成词：/goals 与正文里的 goal 不算
  assert.equal(parseGoalCommand("/goals 修复"), null);
  assert.equal(parseGoalCommand("帮我看看这个 goal 怎么写"), null);
  assert.equal(parseGoalCommand("普通消息"), null);
});
