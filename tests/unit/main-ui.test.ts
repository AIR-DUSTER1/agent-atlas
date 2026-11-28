/**
 * main-ui.test.ts — 主界面结构回归
 * ============================================================
 * 守：空会话有明确起步动作、顶栏有项目/会话面包屑、侧栏有日期分组、
 * 消息流有回到底部与未读提示；这些是“空白会话/不知道下一步”问题的回归门。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readClientFiles, readClientSource } from "../helpers/client-source.js";
import { readClientIndexHtml } from "../helpers/client-html.js";

test("空会话提供三个快捷起步且不会自动发送", async () => {
  const html = await readClientIndexHtml();
  const main = await readClientFiles(["main.ts"]);
  assert.match(html, /id="empty-session"/);
  assert.equal((html.match(/data-empty-prompt=/g) ?? []).length, 3);
  assert.match(main, /\[data-empty-prompt\]/);
  assert.match(main, /inputEl\.value = button\.dataset\.emptyPrompt/);
  assert.doesNotMatch(main, /data-empty-prompt[\s\S]{0,500}send\(\)/);
});

test("顶栏面包屑与空状态切换已接线", async () => {
  // M4 4.5：会话头 / 欢迎页文案迁入 Vue（stores/topbar.ts 派生 + 组件渲染）
  const html = await readClientIndexHtml();
  const source = await readClientFiles(["views/navigation.ts", "stores/topbar.ts", "views/topbar-vue.vue"]);
  assert.match(html, /id="topbar-head-mount"/);
  assert.match(source, /id="breadcrumb-project"/);
  assert.match(source, /data-icon="ChevronRight"/);
  assert.match(source, /breadcrumb = state\.projects\.find\(\(project\) => project\.id === session\.projectId\)\?\.name \?\? "未归属项目"/);
  assert.match(source, /classList\.toggle\("hidden", transcript\(session\.id\)\.length > 0\)/);
});

test("新建会话会刷新上下文容量条，不残留上一会话用量", async () => {
  const navigation = await readClientFiles(["views/navigation.ts"]);
  const turn = await readClientFiles(["stream/turn.ts"]);
  assert.match(navigation, /renderPermChip\(session\);\s*\/\/[^\n]*容量条/);
  assert.match(navigation, /updateContextBar\(\);/);
  assert.match(turn, /showChatState\(created\)/);
  assert.doesNotMatch(turn, /showChatState\(state\.sessions\[0\]\)/);
});

test("执行流程窗体位于上下文条和输入控制上方", async () => {
  const html = await readClientIndexHtml();
  // M4 4.6：workflow-panel 与 context-bar 由 Vue 组件渲染（骨架只剩挂载点），
  // 顺序断言改为「挂载点顺序」（组件内元素仍按 workflow → context 排列）。
  const workflow = html.indexOf('id="workflow-plan-mount"');
  const context = html.indexOf('id="context-meter-mount"');
  const composer = html.indexOf('id="composer-bar"');
  const input = html.indexOf('id="input-box"');
  assert.ok(workflow >= 0 && context >= 0 && composer >= 0 && input >= 0);
  assert.ok(workflow < context && context < composer && composer < input);
});

test("侧栏按项目与今天/昨天/更早分组，并显示相对时间", async () => {
  // M4 4.5：日期分组与时间文案在 modules/session-tree.ts，渲染在 .vue
  const shared = await readClientFiles(["modules/session-tree.ts"]);
  const vue = await readClientFiles(["views/session-tree-vue.vue"]);
  assert.match(shared, /export function sessionDayGroup/);
  assert.match(vue, /class="session-time-head"/);
  assert.match(shared, /昨天 \$\{time\}/);
  assert.match(shared, /天前/);
});

test("多个会话可并行生成，切换会话不再被全局流状态拦截", async () => {
  const turn = await readClientFiles(["stream/turn.ts"]);
  const navigation = await readClientFiles(["views/navigation.ts"]);
  const vue = await readClientFiles(["views/session-tree-vue.vue"]);
  const store = await readClientFiles(["stores/sessions.ts"]);
  const events = await readClientFiles(["stream/events.ts"]);

  assert.match(turn, /state\.streams\[sid\]/);
  assert.match(turn, /syncComposerState\(sid\)/);
  // 停止必须同时通知服务端：断连只 detach 不取消，只 abort 本地流会让后台继续跑。
  assert.match(turn, /const local = state\.streams\[sid\]/);
  assert.match(turn, /local\.ctrl\.abort\(\)/);
  assert.match(turn, /\/api\/sessions\/\$\{sid\}\/stop/);
  assert.match(navigation, /export function selectSession\(sid: string\): void \{\s*closeComposerMenu\(\);/);
  assert.doesNotMatch(navigation, /当前正在生成回复，请先停止或等待完成/);
  // 侧栏「生成中」= 本地流 或 服务端 running（刷新后只剩后者）。
  assert.match(store, /Boolean\(state\.streams\[session\.id\]\) \|\| Boolean\(session\.running\)/);
  assert.match(vue, /class="s-running"/);
  assert.match(events, /const visible = sid === state\.currentId/);
});

test("后台跑完自动重放消息区：running 翻转触发 reloadSessionTranscript", async () => {
  // 真实事故：job_collect 采完 3-5 分钟，本浏览器的消息区还冻结在断开那一刻 ——
  // 工具条停在「运行中」、审批卡停在旧状态。轮询发现 running true→false 必须强制重放。
  const sessions = await readClientFiles(["views/sessions.ts"]);
  const navigation = await readClientFiles(["views/navigation.ts"]);
  assert.match(sessions, /prev && !next && !state\.streams\[session\.id\] && !state\.approvalResuming\[session\.id\]/);
  assert.match(sessions, /reloadSessionTranscript\(session\.id\)/);
  // 强制重放必须清本地缓存，否则 hydrateFromServer 走 hadLocal 分支不重建 DOM
  assert.match(navigation, /export async function reloadSessionTranscript/);
  assert.match(navigation, /transcript\(sid\)\.length = 0/);
  assert.match(navigation, /delete state\.usage\[sid\]/);
});

test("执行流程面板：回合结束后不再显示「执行中」假进度", async () => {
  // 真实事故：模型创建流程后从未调用 updates（planProgress 只在失败时收口），
  // 面板永远停在 01 运行中。store 必须结合会话运行态降级为「已结束 · 未完成」。
  const store = await readClientFiles(["stores/chat/workflow-plan.ts"]);
  const vue = await readClientFiles(["views/chat/workflow-plan-vue.vue"]);
  assert.match(store, /已结束 · 未完成/);
  assert.match(store, /displayStatus\(\): "running" \| "completed" \| "failed" \| "ended"/);
  assert.match(store, /notifyRunStateChange/);
  assert.match(vue, /status-\$\{store\.displayStatus\}/);
  assert.match(vue, /store\.displayStatus === "running"/, "回合结束后进行中步骤不再有活动态高亮");
  // 运行态变化要有触发点进 store（core state 非响应式，不触发 getter 就永远不重算）
  const turn = await readClientFiles(["stream/turn.ts"]);
  assert.match(turn, /notifyRunStateChange\(\)/);
});

test("求职采集实时画面：dock 支持 job 源且不抢占 Browser Use 会话", async () => {
  const dock = await readClientFiles(["views/browser/browser-use.ts"]);
  const events = await readClientFiles(["stream/events.ts"]);
  assert.match(dock, /export function notifyJobLiveProgress/);
  assert.match(dock, /if \(dockSessionId\) return;/, "已在看 Browser Use 时 job 源不得抢占");
  assert.match(dock, /refreshJobView/);
  assert.match(dock, /\/api\/job\/browser\/view/);
  assert.match(dock, /\/api\/job\/browser\/screenshot/);
  assert.match(dock, /jobIdlePolls >= 2/, "连续无活动才收起，防止阶段空窗闪退");
  assert.match(dock, /采集浏览器启动后（登录预检 → 逐平台采集）画面会在这里实时更新/);
  // 防闪烁双闸：服务端只在内容变化时推进 frameId；前端只在 frameId 变化时换
  // img src（时间戳当 v 会让 img 每次轮询重载，画面必然一直闪 —— 真实事故）。
  assert.match(dock, /view\.frameId !== lastJobFrameId/);
  assert.match(dock, /frameChanged \? \{ screenshotSrc/);
  assert.match(dock, /lastJobFrameId = -1;/, "重开面板强制拉一帧新画面");
  // Vue 端 screenReady 重置必须跟随 src 变化，不能跟着快照推送走（状态文本
  // 变化时 img 不触发 load，无条件重置会把画面隐藏且不再恢复）。
  const dockVue = await readClientFiles(["views/browser/browser-dock-vue.vue"]);
  assert.match(dockVue, /watch\(screenshotSrc, \(\) => \{ screenReady\.value = false; \}\)/);
  assert.doesNotMatch(dockVue, /store\.apply\(window\.__agentatlasBrowserDock \?\? null\);\s*screenReady\.value = false/);
  // chat 流收到 job_progress 必须驱动画面打开
  assert.match(events, /case "job_progress":[\s\S]*notifyJobLiveProgress/);
  // 设置页登录也走同一画面（无头容器里扫码全靠它）
  const jobStore = await readClientFiles(["stores/job/job.ts"]);
  assert.match(jobStore, /notifyJobLiveProgress/);
});
test("消息流有回到底部按钮与未读累计", async () => {
  const source = await readClientSource();
  assert.match(source, /function distanceFromBottom/);
  assert.match(source, /NEAR_BOTTOM_PX = 120/);
  assert.match(source, /markNewMessage\(\)/);
  assert.match(source, /条新消息/);
  assert.match(source, /prefers-reduced-motion: reduce/);
});

test("没有项目时首屏和新建对话直接进入 Agent 选择页", async () => {
  const main = await readClientFiles(["main.ts"]);
  // M4 4.5：欢迎态文案由 stores/topbar.ts 派生，welcome-head-vue.vue 渲染
  const navigation = await readClientFiles(["views/navigation.ts", "stores/topbar.ts", "views/welcome-head-vue.vue"]);
  assert.match(main, /state\.projects\.length === 0/);
  assert.match(main, /showWelcomeState\("agent-picker"\)/);
  assert.match(navigation, /WelcomeMode = "default" \| "agent-picker"/);
  assert.match(navigation, /选择一个 Agent 开始新会话/);
  assert.match(navigation, /请选择 Agent 开始新会话/);
  assert.match(navigation, /id="welcome-title"/);
  assert.match(navigation, /id="welcome-cards-label"/);
});
