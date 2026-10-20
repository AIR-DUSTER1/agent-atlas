/**
 * ============================================================
 * limits.ts — 并发与频控收口（Phase 2 T2-5）
 * ============================================================
 * 三种闸门：
 *   1) 会话级「同时只有一个流」：同一会话上一条回答还在生成时拒绝新发送
 *      （比静默排队更好 —— 用户能明确知道自己该等）；
 *   2) 发送间隔节流：同一会话 MIN_CHAT_INTERVAL_MS 内连发直接 400；
 *   3) 全局资源桶 runWithLimit(key,max,fn)：外部 Agent 子进程 / 贝壳 CLI
 *      这类「执行后改世界」的一律过桶，超出即中文报错。
 *
 * 设计立场：不引入任何新依赖（无 p-limit），用 Map + Promise 链实现；
 * 每个闸门的粒度是「请求级」而不是「进程级」，AbortSignal 仍然可以直接
 * 打断正在跑的流（桶只管准入，不管中途取消）。
 */

// ---------------------------------------------------------------------------
// 1) 会话级唯一流
// ---------------------------------------------------------------------------

/** 正在生成中的会话 id 集合 */
const activeStreamSessions = new Set<string>();

/**
 * 申请会话流槽位：成功返回释放函数，同会话已有流在跑时抛中文错误。
 * chat 路由在开启响应流**之前**调用（确保第二个请求拿不到槽位就不写 SSE）。
 */
export function acquireSessionSlot(sessionId: string): () => void {
  if (activeStreamSessions.has(sessionId)) {
    throw new Error("上一条回答还在生成中，请等待它结束（或点停止按钮）后再发送。");
  }
  activeStreamSessions.add(sessionId);
  return () => activeStreamSessions.delete(sessionId);
}

/**
 * 发送间隔节流：同一会话两次发送至少隔 MIN_CHAT_INTERVAL_MS。
 * 目的：防手滑连点造成重复消耗模型配额（前端已有停止/去防抖，这里兜底）。
 */
const MIN_CHAT_INTERVAL_MS = 1_500;
const lastChatAt = new Map<string, number>();

export function assertChatInterval(sessionId: string): void {
  const now = Date.now();
  const last = lastChatAt.get(sessionId);
  if (last !== undefined && now - last < MIN_CHAT_INTERVAL_MS) {
    throw new Error(`发送太快了，请稍等 ${(MIN_CHAT_INTERVAL_MS - (now - last)) / 1000 | 0} 秒后再试`);
  }
  lastChatAt.set(sessionId, now);
}

// ---------------------------------------------------------------------------
// 2) 全局资源桶（外部子进程 / 贝壳 CLI 等）
// ---------------------------------------------------------------------------

interface Bucket {
  running: number;
  /** 排队中的 resolve 队列（FIFO，避免饿死） */
  queue: Array<() => void>;
}
const buckets = new Map<string, Bucket>();

/**
 * 过桶执行：桶满时中文报错（不排队 —— 这类任务都以「用户可见请求」或
 * 「后台保底」出现，排队的饥饿体验比直接报错差）。
 * 成功后 try/finally 归还令牌，异常也照样归还。
 */
export async function runWithLimit<T>(
  key: string,
  max: number,
  fn: () => Promise<T>,
): Promise<T> {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { running: 0, queue: [] };
    buckets.set(key, bucket);
  }
  if (bucket.running >= max) {
    throw new Error(`该资源并发已达上限（${max}），请稍后再试`);
  }
  bucket.running++;
  try {
    return await fn();
  } finally {
    bucket.running--;
    // 桶没有排队者，这里不需要唤醒（future 若支持排队再扩展）
  }
}

/** （测试用）读取桶当前运行数 */
export function limitInspect(key: string): number {
  return buckets.get(key)?.running ?? 0;
}
