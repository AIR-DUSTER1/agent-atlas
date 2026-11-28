/**
 * job-live.test.ts — 求职采集实时画面与进度队列
 * ============================================================
 * 守真实事故：job_collect 采 3-5 分钟全程黑盒（画面只有一条「运行中」转圈），
 * 用户以为卡死；进度事件必须按 threadId 入队、SSE 层排空，截图必须在无页面/
 * 导航中时回退上一帧而不是抛错穿透到 HTTP 层。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  absorbJobFrame, beginJobLive, clearJobProgress, drainJobProgress, endJobLive, getJobLiveScreenshot,
  getJobLiveState, resetJobLiveForTest, setJobLiveThread, updateJobLive,
} from "../../src/server/job-live.js";

test("live 生命周期：begin → update → end，view 状态逐步可见", () => {
  resetJobLiveForTest();
  assert.equal(getJobLiveState(), null, "未开始时 view 必须为空（前端据此收起面板）");

  beginJobLive("collecting", "预检", "登录预检中");
  assert.equal(getJobLiveState()?.phase, "collecting");
  assert.equal(getJobLiveState()?.collected, 0);

  updateJobLive({ platform: "BOSS直聘", collected: 12, message: "正在采集" });
  const view = getJobLiveState();
  assert.equal(view?.platform, "BOSS直聘");
  assert.equal(view?.collected, 12);

  endJobLive("采集完成：共 23 条");
  assert.equal(getJobLiveState(), null, "end 后 view 必须清空");
});

test("进度队列按 threadId 隔离；线程清空后不再发布；end 收尾事件不丢", () => {
  resetJobLiveForTest();

  beginJobLive("login", "BOSS直聘", "等待扫码登录");
  assert.equal(drainJobProgress("thread-A").length, 0, "未绑定线程时不发布");

  setJobLiveThread("thread-A");
  updateJobLive({ message: "等待扫码/登录中" });
  const events = drainJobProgress("thread-A");
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "login");
  assert.match(events[0].message, /等待扫码/);

  // 排空后再 drain 必须为空（幂等消费），且不影响其它线程
  assert.equal(drainJobProgress("thread-A").length, 0);
  setJobLiveThread("thread-B");
  updateJobLive({ message: "x" });
  assert.equal(drainJobProgress("thread-A").length, 0, "切换线程后 A 不再收到事件");
  assert.equal(drainJobProgress("thread-B").length, 1);

  setJobLiveThread("thread-B");
  endJobLive("登录流程结束");
  const last = drainJobProgress("thread-B");
  assert.equal(last.length, 1, "endJobLive 在线程挂着时发布收尾事件");
  assert.equal(last[0].phase, "done");

  // 线程已清空：再 update 不发布（采集异常后工具 finally 清线程的兜底）
  setJobLiveThread(null);
  updateJobLive({ message: "孤儿事件" });
  assert.equal(drainJobProgress("thread-B").length, 0);

  clearJobProgress("thread-B");
});

test("帧去重：内容相同 frameId 不动（前端不换 src 不闪），变化才递增并缓存", () => {
  resetJobLiveForTest();
  const frameA = Buffer.from("jpeg-frame-A");
  const frameB = Buffer.from("jpeg-frame-B");

  assert.equal(getJobLiveScreenshot(), null, "无任何帧时返回 null（端点回 404）");

  assert.equal(absorbJobFrame(frameA), 1);
  assert.equal(absorbJobFrame(frameA), 1, "同内容重复吸收不得推进帧号 —— 否则画面每秒重载闪烁");
  assert.equal(absorbJobFrame(frameB), 2);
  assert.equal(absorbJobFrame(frameA), 3, "内容回退到旧画面也是一次真实变化");
  assert.ok(getJobLiveScreenshot()?.equals(frameA), "截图端点服务的是最新缓存帧");
});
