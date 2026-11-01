/**
 * composer/goal.ts — /goal 命令的 Goal 徽标模式
 * ============================================================
 * textarea 无法只给前缀文本上样式，所以「/goal 」不留在正文里：
 * 转成 Goal 徽标（Target 图标 + 文案）+ 任务占位符，正文只放任务描述。
 * 徽标是发送层的语义开关（send 读 goalDraft 决定 continuous），不是纯视觉装饰；
 * 入口有三处：命令菜单选中、手打 /goal 前缀自动转换、发送后自动退出。
 */
import { $, autoGrowImpl, inputEl } from "../core/dom.js";
import { state } from "../core/state.js";
import { parseGoalCommand } from "../modules/goal.js";

const GOAL_PLACEHOLDER = "描述要持续完成的任务…（任务未完成会持续执行，直到完成、出错或手动停止）";
let defaultPlaceholder: string | null = null;

/** 进入 Goal 徽标模式：正文留给任务描述，前缀语义由徽标承载 */
export function enterGoalMode(): void {
  state.goalDraft = true;
  renderGoalChip();
}

/** 退出徽标模式（发送后 / 点徽标 / 清空输入），占位符还原 */
export function exitGoalMode(): void {
  if (!state.goalDraft) return;
  state.goalDraft = false;
  renderGoalChip();
}

/** 徽标显隐与占位符切换的唯一渲染点 */
export function renderGoalChip(): void {
  const chip = $("goal-chip");
  if (!chip) return;
  defaultPlaceholder ??= inputEl.placeholder;
  chip.classList.toggle("hidden", !state.goalDraft);
  inputEl.placeholder = state.goalDraft ? GOAL_PLACEHOLDER : defaultPlaceholder;
}

/**
 * 空输入下按退格退出徽标。必须拦 keydown：空 textarea 的 Backspace 不产生
 * input 事件，挂在 input 上的 syncGoalDraftFromInput 永远收不到通知。
 */
export function handleGoalKeydown(event: KeyboardEvent): boolean {
  if (event.key === "Backspace" && state.goalDraft && !inputEl.value) {
    event.preventDefault();
    exitGoalMode();
    return true;
  }
  return false;
}

/**
 * 输入事件钩子：手打 /goal 前缀自动转成徽标（正文剥掉前缀只留任务）；
 * 徽标模式下正文又出现 /goal 前缀同样剥掉（语义一致）。
 * 「清空退出」只在退格（handleGoalKeydown）里做 —— 前缀刚剥掉时输入框会
 * 瞬时为空，这里若因空值退出会把「/goal 后继续打字」的节奏打断。
 */
export function syncGoalDraftFromInput(): void {
  const parsed = parseGoalCommand(inputEl.value);
  if (state.goalDraft) {
    if (parsed) {
      inputEl.value = parsed.task;
      autoGrowImpl();
    }
    return;
  }
  // /goal 后必须跟空白或任务文本才转换；裸 /goal 留给命令菜单选中，
  // 避免用户只想浏览菜单时输入框被提前清空
  if (!parsed || (!parsed.task && !/\s$/.test(inputEl.value))) return;
  inputEl.value = parsed.task;
  enterGoalMode();
  autoGrowImpl();
  const end = inputEl.value.length;
  inputEl.setSelectionRange(end, end);
}
