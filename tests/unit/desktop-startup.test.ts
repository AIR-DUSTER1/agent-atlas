/**
 * desktop-startup.test.ts — Electron 启动链路的端口、就绪与加载重试
 * ============================================================
 * 用真实 loopback 服务验证 503→200 就绪探测，并覆盖端口顺延、
 * 子进程启动错误快速失败、ERR_CONNECTION_REFUSED 类加载重试与退出清理接线。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  findAvailableDesktopPort,
  loadUrlWithRetry,
  waitForServer,
} from "../../desktop/startup.js";

async function listenHttp(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as AddressInfo).port };
}

async function closeServer(server: http.Server | net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("就绪探测忽略非 2xx，直到服务真正返回 200", async () => {
  let attempts = 0;
  const { server, port } = await listenHttp((_req, res) => {
    attempts += 1;
    res.statusCode = attempts < 3 ? 503 : 200;
    res.end(attempts < 3 ? "starting" : "{\"ok\":true}");
  });
  try {
    await waitForServer(`http://127.0.0.1:${port}`, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
      probeTimeoutMs: 250,
    });
    assert.equal(attempts, 3);
  } finally {
    await closeServer(server);
  }
});

test("服务子进程提前退出时，就绪等待立即失败", async () => {
  const startupError = new Error("服务子进程启动失败（退出码 1）");
  await assert.rejects(
    () => waitForServer("http://127.0.0.1:9", {
      timeoutMs: 5_000,
      pollIntervalMs: 1_000,
      startupError: () => startupError,
    }),
    (err) => err === startupError,
  );
});

test("首选端口被占用时自动顺延到可用端口", async () => {
  const occupied = net.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const occupiedPort = (occupied.address() as AddressInfo).port;
  try {
    const selected = await findAvailableDesktopPort(occupiedPort, 10);
    assert.notEqual(selected, occupiedPort);
    assert.ok(selected > occupiedPort && selected <= Math.min(65_535, occupiedPort + 10));
  } finally {
    await closeServer(occupied);
  }
});

test("页面首次连接拒绝后按退避重试并成功加载", async () => {
  let calls = 0;
  const failedAttempts: number[] = [];
  const result = await loadUrlWithRetry({
    isDestroyed: () => false,
    loadURL: async () => {
      calls += 1;
      if (calls < 3) throw new Error("ERR_CONNECTION_REFUSED");
    },
  }, "http://127.0.0.1:3123", {
    retryDelaysMs: [0, 1, 1, 1],
    onRetry: (attempt) => failedAttempts.push(attempt),
  });
  assert.equal(result, undefined);
  assert.equal(calls, 3);
  assert.deepEqual(failedAttempts, [1, 2]);
});

test("页面重试耗尽后返回最后错误，不误报成功", async () => {
  await assert.rejects(
    () => loadUrlWithRetry({
      isDestroyed: () => false,
      loadURL: async () => { throw new Error("ERR_CONNECTION_REFUSED"); },
    }, "http://127.0.0.1:3123", { retryDelaysMs: [0, 1] }),
    /已尝试 2 次.*ERR_CONNECTION_REFUSED/,
  );
});

test("主进程直接启动 Electron-as-Node，并接管信号与父 PID 看门狗", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../../desktop/main.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /ELECTRON_RUN_AS_NODE/);
  assert.match(source, /ELECTRON_PARENT_PID/);
  assert.doesNotMatch(source, /npx\.cmd tsx/);
  assert.match(source, /process\.on\("SIGINT", handleTerminationSignal\)/);
  assert.match(source, /process\.on\("SIGTERM", handleTerminationSignal\)/);
  assert.match(source, /stopServer\(\);\s*app\.exit\(0\);/);
});
