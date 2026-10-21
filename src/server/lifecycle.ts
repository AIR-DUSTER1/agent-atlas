/**
 * ============================================================
 * lifecycle.ts — 在途请求统计 + 优雅退出（Phase 4）
 * ============================================================
 * 为什么单独抽一层：index.ts 只决定「何时退」，「怎么退」必须可单测。
 * 契约：
 *  - beginRequest() 在关闭中返回 false（入口据此回 503，不再接新活）；
 *  - 退出时先给 active SSE 写 shutdown 事件、再 abort，客户端明确知道
 *    「服务在重启，不是网络断了」；
 *  - 等在途请求归零，超时则强制销毁连接（对应 docker stop 的宽限期）；
 *  - flush 由调用方注入（journal / audit 的待写队列），避免本模块反向依赖。
 */
import type { ServerResponse } from "node:http";
import { log } from "./logging.js";

/** 等待在途请求的自然收尾上限：超过即强制断开（docker stop 默认 10s 宽限） */
export const SHUTDOWN_TIMEOUT_MS = 10_000;
/** 轮询在途计数的间隔：25ms 对退出耗时可忽略，又不会空转 */
const SHUTDOWN_POLL_MS = 25;
/** 关闭中推给前端的最后一帧（前端 app.js 的 shutdown case 负责展示） */
const SHUTDOWN_EVENT = JSON.stringify({
  type: "shutdown",
  message: "服务正在关闭，请稍后刷新页面重连",
});

interface SseClient {
  res: ServerResponse;
  abort: () => void;
}

export interface ShutdownDeps {
  /** server.close()：停止接受新连接（返回 Promise 时等连接真正收尾） */
  closeServer: () => void | Promise<void>;
  /** 关掉 keep-alive 空闲连接，避免 close 永远等不到 */
  closeIdleConnections: () => void;
  /** 宽限期到点后强制销毁剩余连接 */
  closeAllConnections: () => void;
  /** 等待 journal / audit 的 fire-and-forget 写入落盘 */
  flush: () => Promise<void>;
  /** 注入便于单测；生产传 process.exit */
  exit: (code: number) => void;
  timeoutMs?: number;
}

export interface Lifecycle {
  beginRequest(): boolean;
  endRequest(): void;
  registerSse(res: ServerResponse, abort: () => void): () => void;
  isShuttingDown(): boolean;
  inFlight(): number;
  shutdown(deps: ShutdownDeps): Promise<"drained" | "timeout">;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 工厂导出：生产用下面的单例，单测每次 new 一个干净状态 */
export function createLifecycle(): Lifecycle {
  let shuttingDown = false;
  let requests = 0;
  const sseClients = new Set<SseClient>();

  return {
    beginRequest(): boolean {
      if (shuttingDown) return false;
      requests += 1;
      return true;
    },

    endRequest(): void {
      if (requests > 0) requests -= 1;
    },

    registerSse(res: ServerResponse, abort: () => void): () => void {
      const client: SseClient = { res, abort };
      sseClients.add(client);
      return () => sseClients.delete(client);
    },

    isShuttingDown(): boolean {
      return shuttingDown;
    },

    inFlight(): number {
      return requests;
    },

    async shutdown(deps: ShutdownDeps): Promise<"drained" | "timeout"> {
      // 幂等：重复信号由入口处理（第二次直接强退），这里再兜一层
      if (shuttingDown) return "drained";
      shuttingDown = true;
      const timeoutMs = deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;

      log("info", "server_shutdown", {
        inFlight: requests,
        sseClients: sseClients.size,
        timeoutMs,
      });

      // 先通知再 abort：保证 shutdown 帧排在 done 之前写进 socket（同一事件循环内顺序写）
      for (const client of [...sseClients]) {
        try {
          if (!client.res.writableEnded) {
            client.res.write(`data: ${SHUTDOWN_EVENT}\n\n`);
          }
        } catch { /* 连接已断：忽略 */ }
        try {
          client.abort();
        } catch { /* 已结束：忽略 */ }
      }
      sseClients.clear();

      let closing: Promise<void>;
      try {
        closing = Promise.resolve(deps.closeServer()).catch(() => {});
      } catch {
        closing = Promise.resolve();
      }
      deps.closeIdleConnections();

      const deadline = Date.now() + timeoutMs;
      while (requests > 0 && Date.now() < deadline) {
        await sleep(SHUTDOWN_POLL_MS);
      }

      const drained = requests === 0;
      if (!drained) {
        // 宽限期到点：还在跑的流（长模型调用等）强制断开，避免容器被 SIGKILL
        log("warn", "shutdown_forced", { remainingRequests: requests });
        deps.closeAllConnections();
      }
      // 最后一帧可能还在 socket 缓冲：等 close 回调最多 500ms，避免 exit 截断响应
      await Promise.race([closing, sleep(Math.min(timeoutMs, 500))]);

      try {
        await deps.flush();
      } catch { /* flush 失败不阻塞退出 */ }

      log("info", "server_stopped", { drained, exitCode: drained ? 0 : 1 });
      deps.exit(drained ? 0 : 1);
      return drained ? "drained" : "timeout";
    },
  };
}

/** 生产单例：index.ts 与 SSE 路由共用同一份在途/关闭状态 */
export const lifecycle = createLifecycle();
