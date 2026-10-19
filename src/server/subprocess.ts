/**
 * ============================================================
 * subprocess.ts — 受控子进程运行器（Phase 1 T1-4）
 * ============================================================
 * 职责：estate / external 两类裸 spawn 站点共用的安全边界——输出字节上限、
 * stderr 只留尾部、运行时长上限、跨平台「整棵进程树」强杀。
 *
 * 设计立场（踩坑沉淀）：
 *  - Windows 上子进程常再 fork 孙进程（npm→node→应用），child.kill() 只杀
 *    直接子进程，孙进程会变孤儿继续占资源/端口 → 必须 taskkill /pid X /T /F；
 *  - 非 Windows 用 detached:true 建独立进程组，超时 process.kill(-pgid) 组杀;
 *  - stdout 是结果通道（beike 单行 JSON）超限保留**头部**；stderr 是日志通道
 *    报错信息在最后 → 只保留**尾部**；
 *  - runner 可注入（mockRunner）：测试超时/超限不必真的拉起进程。
 */
import { spawn, execFileSync } from "node:child_process";

/** stdout 结果通道的默认上限：beike JSON 单行 KB 级，4MB 已是异常刷屏 */
export const STDOUT_MAX_BYTES = 4_000_000;
/** stderr 日志通道的默认上限：只保尾部（报错通常集中在最后几屏） */
export const STDERR_MAX_BYTES = 64_000;
/** 强杀后等待 close 事件的兜底时长（Windows taskkill /T 偶发慢） */
const KILL_SETTLE_GRACE_MS = 5_000;

export interface RunResult {
  code: number;        // 子进程退出码；超时/超限等异常终止时为 -1
  stdout: string;
  stderr: string;      // 尾部截断后的 stderr
  killedBy?: "timeout" | "output-limit" | "abort"; // 异常终止原因（正常退出不带）
}

export interface ControlledSpawnOptions {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  /** 结束前写向 stdin 的数据（如 beike auth 的 Key）；null = 直接 ignore stdin */
  stdinData?: string | null;
  /** 中途取消信号（external 的「停止」按钮） */
  signal?: AbortSignal;
  timeoutMs: number;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
}

/**
 * 强杀整棵进程树：Windows 走系统 taskkill（/T 含孙进程），其它平台杀进程组。
 * 所有失败静默（进程可能已退出）。
 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: KILL_SETTLE_GRACE_MS });
    } catch { /* 已退出或权限不足则忽略 */ }
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { /* 组不存在 */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
  }
}

/**
 * 受控运行一个子进程并收齐三路输出。
 * 与 estate.ts 旧 runBeikeRaw 的约定一致：resolve 而非 reject，
 * 调用方按 code / killedBy 自行处理 —— 工具层错误要转译成模型可读文本。
 */
export function runControlled(command: string, opts: ControlledSpawnOptions): Promise<RunResult> {
  const stdoutCap = opts.stdoutMaxBytes ?? STDOUT_MAX_BYTES;
  const stderrCap = opts.stderrMaxBytes ?? STDERR_MAX_BYTES;
  return new Promise((resolve) => {
    // 非 Windows detached 建进程组（组杀前提）；Windows 上 taskkill /T 已覆盖树
    const child = spawn(command, opts.args ?? [], {
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.shell ?? false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: opts.stdinData === null ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    let code = 0;
    let killedBy: RunResult["killedBy"];
    let stdoutBytes = 0;
    let stdout = "";
    const stderrChunks: string[] = []; // 先攒后取尾部，避免逐片段字符串拼接 O(n²)
    let stderrBytes = 0;
    const done = (finalCode: number, by: RunResult["killedBy"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      // 终止原因统一写进 stderr 尾部：调用方（工具层）的 stderr 文案要能自解释
      const hint = by === "timeout" ? `\n[运行器] 超过 ${opts.timeoutMs}ms 被终止`
        : by === "output-limit" ? `\n[运行器] 输出超出上限被终止`
        : by === "abort" ? `\n[运行器] 被中止` : "";
      resolve({
        code: by ? finalCode : (finalCode ?? 0),
        stdout,
        stderr: (stderrChunks.join("") + hint).slice(-stderrCap),
        killedBy: by,
      });
    };

    /** 树杀 + 按「强杀路径」收结果（code 保留真实值，killedBy 标明原因） */
    const terminate = (by: NonNullable<RunResult["killedBy"]>, exitCode: number) => {
      if (settled) return;
      killedBy = by;
      code = exitCode;
      if (!child.pid) { done(code, killedBy); return; } // spawn 都没成功（ENOENT）：无进程可杀
      try { killProcessTree(child.pid); } catch { /* 已退出 */ }
      // taskkill 是异步的，close 事件会随后到达走 done；
      // 若 /T 失败进程还活着，用兜底时限强制 resolve
      setTimeout(() => done(code, killedBy), KILL_SETTLE_GRACE_MS);
    };

    const timer = setTimeout(() => terminate("timeout", -1), opts.timeoutMs);

    if (opts.signal) {
      if (opts.signal.aborted) { terminate("abort", -1); return; }
      opts.signal.addEventListener("abort", () => terminate("abort", -1), { once: true });
    }

    if (opts.stdinData !== null && child.stdin) {
      child.stdin.on("error", () => { /* 进程提前退出时管道破裂，忽略 */ });
      child.stdin.end(opts.stdinData ?? "");
    }

    child.stdout?.on("data", (c: Buffer) => {
      stdoutBytes += c.length;
      if (stdoutBytes > stdoutCap) {
        // 结果通道超限：保留已有头部，按输出上限终止
        terminate("output-limit", -1);
        return;
      }
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      // stderr 只需要尾部：攒原始量但每次把总字节压回去，内存恒定
      stderrBytes += c.length;
      stderrChunks.push(c.toString("utf8"));
      if (stderrBytes > stderrCap * 2) {
        const joined = stderrChunks.join("").slice(-stderrCap);
        stderrChunks.length = 0;
        stderrChunks.push(joined);
        stderrBytes = Buffer.byteLength(joined);
      }
    });
    child.on("error", (err) => done(-1, undefined));
    // spawn 自身失败（ENOENT 等）时 close 事件缺失 → error 事件后 resolve
    child.on("close", (c) => done(c ?? (killedBy ? code : -1), killedBy));
  });
}

/** 便于测试与替代实现的注入型 runner 签名 */
export type ControlledRunner = (command: string, opts: ControlledSpawnOptions) => Promise<RunResult>;

/** 默认真实实现（测试时可用 mockRunner 替换） */
export const realRunner: ControlledRunner = runControlled;
