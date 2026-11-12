/**
 * parent-watchdog.ts — 桌面端托管的 Web 服务监视 Electron 主进程
 * ============================================================
 * Electron 被系统信号或崩溃直接终止时，子进程不一定收到退出事件。
 * 桌面端注入 ELECTRON_PARENT_PID 后，本模块周期性检查父进程；一旦消失，
 * 立即复用服务优雅退出链路，避免孤儿进程长期占用本机端口。
 */
const DEFAULT_INTERVAL_MS = 1_500;

export interface ParentWatchdogOptions {
  parentPid: number;
  onParentGone: () => void;
  intervalMs?: number;
  /** 单测注入；默认使用 process.kill(pid, 0) 探测。 */
  isAlive?: (pid: number) => boolean;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存在但当前用户无权发信号，不能误判成已退出。
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 返回 stop 函数；stop 必须幂等。定时器 unref，避免单独运行本模块时阻止进程退出。
 */
export function startParentWatchdog(options: ParentWatchdogOptions): () => void {
  const intervalMs = Math.max(50, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const alive = options.isAlive ?? isProcessAlive;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    let parentAlive = false;
    try {
      parentAlive = alive(options.parentPid);
    } catch {
      parentAlive = true; // 探测自身异常时宁可下轮再试，不能误杀正常服务。
    }
    if (parentAlive) return;

    stopped = true;
    clearInterval(timer);
    try {
      options.onParentGone();
    } catch { /* 退出回调异常不能把看门狗变成未处理异常 */ }
  }, intervalMs);
  timer.unref();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
