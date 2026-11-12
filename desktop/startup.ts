/**
 * desktop/startup.ts — Electron 启动阶段的端口、就绪与页面加载原语
 * ============================================================
 * 把启动链路中可单测的 Node 逻辑从 Electron 生命周期中拆出：
 * 端口被孤儿进程占用时自动顺延；服务子进程提前退出时立即失败；
 * 页面首次加载遇到短暂断连时重试，避免停在 Chromium 的 ERR_CONNECTION_REFUSED 错误页。
 */
import http from "node:http";
import net from "node:net";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT_SCAN_LIMIT = 20;
const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_LOAD_RETRY_DELAYS_MS = [0, 300, 700, 1_500, 3_000] as const;

export interface WaitForServerOptions {
  timeoutMs: number;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
  /** 子进程启动期间记录的错误；一旦存在就不再继续等待端口。 */
  startupError?: () => Error | null;
}

export interface LoadRetryOptions {
  retryDelaysMs?: readonly number[];
  onRetry?: (failedAttempt: number, totalAttempts: number, error: Error) => void;
}

interface LoadableWindow {
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("桌面端端口必须是 1-65535 的整数");
  }
}

async function canListen(port: number): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    let settled = false;
    probe.unref();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (err.code === "EADDRINUSE" || err.code === "EACCES") resolve(false);
      else reject(err);
    });
    probe.listen({ port, host: LOOPBACK_HOST, exclusive: true }, () => {
      if (settled) return;
      probe.close((err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(true);
      });
    });
  });
}

/**
 * 优先使用用户指定端口；若被占用则从 preferred+1 开始顺延。
 * 桌面端服务只用于本机窗口，不需要坚持固定端口，能启动比端口号稳定更重要。
 */
export async function findAvailableDesktopPort(
  preferredPort: number,
  scanLimit = DEFAULT_PORT_SCAN_LIMIT,
): Promise<number> {
  assertPort(preferredPort);
  const limit = Math.max(0, Math.floor(scanLimit));
  const lastPort = Math.min(65_535, preferredPort + limit);
  for (let port = preferredPort; port <= lastPort; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`端口 ${preferredPort}-${lastPort} 均被占用，请设置 DESKTOP_PORT 后重试`);
}

async function probeServer(url: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      if (status >= 200 && status < 300) resolve();
      else reject(new Error(`就绪探测返回 HTTP ${status}`));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`就绪探测超过 ${timeoutMs}ms`));
    });
    request.on("error", reject);
  });
}

/** 轮询服务的真实配置接口，只有 2xx 才算就绪。 */
export async function waitForServer(baseUrl: string, options: WaitForServerOptions): Promise<void> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("服务就绪超时必须大于 0");
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const probeTimeoutMs = Math.min(
    options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    Math.max(1, options.timeoutMs),
  );
  const readyUrl = new URL("/api/config", baseUrl).toString();
  const deadline = Date.now() + options.timeoutMs;
  let lastError = new Error("服务尚未响应");

  while (true) {
    const startupError = options.startupError?.();
    if (startupError) throw startupError;

    try {
      await probeServer(readyUrl, probeTimeoutMs);
      return;
    } catch (err) {
      lastError = toError(err);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`在 ${Math.round(options.timeoutMs / 1_000)}s 内未能连上 ${baseUrl}：${lastError.message}`);
    }
    await delay(Math.min(pollIntervalMs, remainingMs));
  }
}

/**
 * Electron 的 loadURL 失败后默认停留错误页，不会自动重试。
 * 这里对连接拒绝等瞬时失败做有限次退避，最终失败交给主进程弹窗退出。
 */
export async function loadUrlWithRetry(
  target: LoadableWindow,
  url: string,
  options: LoadRetryOptions = {},
): Promise<void> {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_LOAD_RETRY_DELAYS_MS;
  if (retryDelays.length === 0) throw new Error("页面加载重试次数不能为 0");
  let lastError = new Error("页面尚未加载");

  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    const waitMs = retryDelays[attempt] ?? 0;
    if (waitMs > 0) await delay(waitMs);
    if (target.isDestroyed()) throw new Error("桌面窗口已关闭，停止加载页面");

    try {
      await target.loadURL(url);
      return;
    } catch (err) {
      lastError = toError(err);
      options.onRetry?.(attempt + 1, retryDelays.length, lastError);
    }
  }

  throw new Error(`桌面界面加载失败（已尝试 ${retryDelays.length} 次）：${lastError.message}`);
}
