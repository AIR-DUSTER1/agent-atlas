/**
 * modules/goal.ts — /goal 内置命令解析
 * ============================================================
 * `/goal <任务>` = 以连续工作模式发送该任务：本轮未完成就持续回炉执行，
 * 直到任务完成 / 请求出错 / 空转熔断 / 用户手动停止。
 * 解析必须是纯函数：菜单填充、发送拦截与单测共用同一份语义，
 * 避免三处各写一套正则后各自漂移。
 */

export const GOAL_COMMAND = "/goal";

export interface GoalCommand {
  /** 命令后的任务描述；裸 `/goal`（没写任务）时为空串，调用方应提示用法而不是发空请求 */
  task: string;
}

/**
 * 解析 /goal 命令；不是 goal 命令返回 null。
 * 命令名必须独立成词（`/goals` 不算），后接任务描述可有可无；
 * 允许前后空白，菜单选中后输入框里是 `/goal `，直接回车就是裸命令。
 */
export function parseGoalCommand(text: string): GoalCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(GOAL_COMMAND)) return null;
  const rest = trimmed.slice(GOAL_COMMAND.length);
  if (rest && !/^\s/.test(rest)) return null;
  return { task: rest.trim() };
}
