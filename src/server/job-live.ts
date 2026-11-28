/**
 * job-live.ts — 求职采集浏览器的实时画面与进度
 * ============================================================
 * 职责：
 *  1) live registry：采集 / 登录期间登记当前 Playwright page 与阶段信息，
 *     供 `/api/job/browser/{view,screenshot}` 只读轮询 —— 与 Browser Use
 *     右侧实时画面同模式（前端 1.2s 轮询截图）。采集浏览器是无头的
 *     （NAS 容器无显示服务），这是用户「看着采集」的唯一窗口。
 *  2) progress 队列：按 threadId 发布 job_progress 事件，SSE 层在模型
 *     退避间隙像 model_retry 一样排出（chat.ts 的 drain 轮询）。threadId
 *     由工具层从 `configurable.thread_id` 取（与 Browser Use 同一透传约定）。
 *
 * 红线：截图是只读操作，**绝不进采集串行队列**（job-browser 的 enqueue），
 * 否则 1.2s 轮询会排在导航后面拖慢采集；导航瞬间截图可能抛错 → 返回上一帧。
 */
import { createHash } from "node:crypto";
import type { Page } from "playwright-core";

export type JobLivePhase = "login" | "collecting";

export interface JobLiveState {
  phase: JobLivePhase;
  /** 当前平台中文名（BOSS直聘 / 智联招聘 / 前程无忧 / 猎聘）。 */
  platform: string;
  /** 已采集条数（登录阶段恒为 0）。 */
  collected: number;
  /** 人类可读的当前动作（如「正在解析列表页」）。 */
  message: string;
  url: string;
  startedAt: number;
  /** 帧序号：只在画面内容真正变化时递增。前端据此决定要不要换 img src ——
   *  用时间戳做 v 会让 img 每次轮询都重载（先清空再等加载），右侧画面必然
   *  一直闪烁（真实事故），所以帧去重必须在服务端做。 */
  frameId: number;
}

/** job_progress 的 SSE 事件载荷（与 server/events.ts 的变体保持一致）。 */
export interface JobProgressRecord {
  phase: JobLivePhase | "done";
  platform?: string;
  collected?: number;
  message: string;
  at: number;
}

/** 采集全程只允许一个（job-browser 的 enqueue 全局串行），live 是天然单例。 */
let live: JobLiveState | null = null;
let livePage: Page | null = null;
let lastFrame: Buffer | null = null;
let lastFrameHash: string | null = null;
let frameId = 0;
/** 进度事件要发进哪个会话的聊天流；由工具层入口设置（采集结束/异常清除）。 */
let liveThreadId: string | null = null;

const progressQueues = new Map<string, JobProgressRecord[]>();
const MAX_PROGRESS_RECORDS = 40;

function publish(record: JobProgressRecord): void {
  if (!liveThreadId) return;
  const queue = progressQueues.get(liveThreadId) ?? [];
  queue.push(record);
  // 只承载可观测性，不允许队列本身变成泄漏点（与 model-retry 同策略）。
  if (queue.length > MAX_PROGRESS_RECORDS) queue.splice(0, queue.length - MAX_PROGRESS_RECORDS);
  progressQueues.set(liveThreadId, queue);
}

function publishNow(patch: Omit<JobProgressRecord, "at">): void {
  publish({ ...patch, at: Date.now() });
}

/** 工具层入口调用：后续进度事件发进该会话的聊天流；finally 必须清掉。 */
export function setJobLiveThread(threadId: string | null): void {
  liveThreadId = typeof threadId === "string" && threadId ? threadId : null;
}

export function beginJobLive(phase: JobLivePhase, platform: string, message: string): void {
  live = { phase, platform, collected: 0, message, url: "", startedAt: Date.now(), frameId: 0 };
  publishNow({ phase, platform, message });
}

export function updateJobLive(patch: Partial<Pick<JobLiveState, "platform" | "collected" | "message" | "url">>): void {
  if (!live) return;
  Object.assign(live, patch);
  publishNow({
    phase: live.phase,
    ...(patch.platform !== undefined || live.platform ? { platform: live.platform } : {}),
    ...(patch.collected !== undefined ? { collected: live.collected } : {}),
    message: patch.message ?? live.message,
  });
}

export function endJobLive(message: string): void {
  if (live) publishNow({ phase: "done", platform: live.platform, collected: live.collected, message });
  live = null;
  livePage = null;
}

export function attachJobLivePage(page: Page | null): void {
  livePage = page;
}

/** 画面轮询入口；无采集/登录进行中时返回 null（前端据此收起面板）。 */
export function getJobLiveState(): JobLiveState | null {
  return live ? { ...live } : null;
}

/** 新帧吸收：内容哈希与上一帧相同则 frameId 不变（前端不换 src → 不闪）。
 *  JPEG 对同一像素内容的编码是确定的，页面静止时哈希稳定一致。 */
export function absorbJobFrame(frame: Buffer): number {
  const hash = createHash("md5").update(frame).digest("hex");
  if (hash !== lastFrameHash) {
    lastFrameHash = hash;
    lastFrame = frame;
    frameId += 1;
  }
  return frameId;
}

/** 单帧截图最长等待；导航/渲染中的页面可能拿不到，超时即回退上一帧。 */
const SCREENSHOT_TIMEOUT_MS = 3_000;
const SCREENSHOT_MAX_BYTES = 900_000;

/** 捕获一帧（view 轮询时调用）；失败（导航中/页面跳转/超时）保留上一帧。 */
async function captureFrame(): Promise<void> {
  if (!livePage || livePage.isClosed()) return;
  try {
    const frame = await livePage.screenshot({
      type: "jpeg",
      quality: 55,
      timeout: SCREENSHOT_TIMEOUT_MS,
    });
    if (frame.length <= SCREENSHOT_MAX_BYTES) {
      absorbJobFrame(frame);
      if (live) live.url = livePage.url();
    }
  } catch {
    // 导航瞬间截图会抛错：保留上一帧，绝不能把错误抛进 1.2s 轮询的 HTTP 层。
  }
}

/**
 * 前端画面轮询入口（GET /api/job/browser/view）：顺便驱动一次截图捕获，
 * 只有内容真正变化时 frameId 才前进 —— 前端只在 frameId 变化时才拉新图，
 * 静止页面不再每 1.2s 重传一整张 JPEG，也不再闪烁。
 */
export async function pollJobLiveView(): Promise<JobLiveState | null> {
  if (!live) return null;
  await captureFrame();
  return live ? { ...live, frameId } : null;
}

/** 画面字节（缓存帧；捕获只发生在 view 轮询里）。无任何帧时返回 null → 404。 */
export function getJobLiveScreenshot(): Buffer | null {
  return lastFrame;
}

/** SSE 层每 250ms 排空该会话的进度队列（与 drainModelRetryRecords 同节奏）。 */
export function drainJobProgress(threadId: string | undefined): JobProgressRecord[] {
  if (!threadId) return [];
  const queue = progressQueues.get(threadId);
  if (!queue?.length) return [];
  progressQueues.set(threadId, []);
  return queue;
}

/** 会话流结束时清队列，防泄漏。 */
export function clearJobProgress(threadId: string | undefined): void {
  if (threadId) progressQueues.delete(threadId);
}

/** （测试用）重置全部状态。 */
export function resetJobLiveForTest(): void {
  live = null;
  livePage = null;
  lastFrame = null;
  lastFrameHash = null;
  frameId = 0;
  liveThreadId = null;
  progressQueues.clear();
}
