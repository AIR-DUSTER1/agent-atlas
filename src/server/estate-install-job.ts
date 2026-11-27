/**
 * estate-install-job.ts — 贝壳 CLI 后台安装状态机
 * ============================================================
 * 下载官方二进制可能持续数分钟，不能绑定单个 HTTP 请求；否则反向代理会在
 * 后端完成前返回 504。本模块只负责启动一次后台安装并保存可轮询状态。
 */

export type BeikeInstallStatus = "installing" | "succeeded" | "failed";

export interface BeikeInstallJob {
  status: BeikeInstallStatus;
  startedAt: string;
  finishedAt?: string;
  version?: string;
  error?: string;
}

export interface BeikeInstallCoordinator {
  start(): BeikeInstallJob;
  get(): BeikeInstallJob | null;
}

/**
 * 创建安装协调器。runInstall 由调用方注入，测试可用假 Promise，生产注入 installBeike。
 * 同一时刻只允许一个后台任务；重复点击会返回同一个进行中状态。
 */
export function createBeikeInstallCoordinator(
  runInstall: () => Promise<{ version?: string }>,
): BeikeInstallCoordinator {
  let job: BeikeInstallJob | null = null;
  let running: Promise<void> | null = null;

  const snapshot = (): BeikeInstallJob | null => (job ? { ...job } : null);

  return {
    start(): BeikeInstallJob {
      if (running && job) return { ...job };
      const startedAt = new Date().toISOString();
      job = { status: "installing", startedAt };
      running = Promise.resolve()
        .then(runInstall)
        .then((result) => {
          job = {
            status: "succeeded",
            startedAt,
            finishedAt: new Date().toISOString(),
            version: result.version || "",
          };
        })
        .catch((err: unknown) => {
          job = {
            status: "failed",
            startedAt,
            finishedAt: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
          };
        })
        .finally(() => {
          running = null;
        });
      return { ...job };
    },
    get(): BeikeInstallJob | null {
      return snapshot();
    },
  };
}