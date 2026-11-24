/**
 * ============================================================
 * response-capture.ts — 原生 response 到 Hono Response 的兼容层
 * ============================================================
 * 现有领域 handler 仍使用 ServerResponse；M2 终态迁移期间用轻量捕获器把
 * JSON/二进制输出收束成标准 Response，避免 Hono 路由继续直写原生 socket。
 * SSE 不在这里缓冲，必须走 app.ts 的流式适配器。
 */
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

type HeaderValue = string | number | readonly string[];

/** 覆盖路由层实际使用的 writeHead/setHeader/write/end 的最小兼容实现。 */
export class CapturingResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = "";
  headersSent = false;
  writableEnded = false;
  private readonly headersStore = new Headers();
  private readonly chunks: Uint8Array[] = [];

  setHeader(name: string, value: HeaderValue): this {
    this.applyHeader(name, value);
    return this;
  }

  getHeader(name: string): string | null {
    return this.headersStore.get(name);
  }

  getHeaders(): Headers {
    return this.headersStore;
  }

  hasHeader(name: string): boolean {
    return this.headersStore.has(name);
  }

  removeHeader(name: string): void {
    this.headersStore.delete(name);
  }

  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | Record<string, HeaderValue>,
    maybeHeaders?: Record<string, HeaderValue>,
  ): this {
    this.statusCode = statusCode;
    this.headersSent = true;
    if (typeof statusMessageOrHeaders === "string") this.statusMessage = statusMessageOrHeaders;
    const headerObject = typeof statusMessageOrHeaders === "string" ? maybeHeaders : statusMessageOrHeaders;
    if (headerObject) {
      for (const [name, value] of Object.entries(headerObject)) this.applyHeader(name, value);
    }
    return this;
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  write(chunk: string | Uint8Array, _encoding?: unknown): boolean {
    this.headersSent = true;
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return true;
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk) this.write(chunk);
    this.headersSent = true;
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }

  /** 把捕获到的状态、headers 与 body 转换成标准 Web Response。 */
  toResponse(): Response {
    const body = this.chunks.length ? Buffer.concat(this.chunks.map((chunk) => Buffer.from(chunk))) : null;
    return new Response(body, { status: this.statusCode, statusText: this.statusMessage || undefined, headers: this.headersStore });
  }

  private applyHeader(name: string, value: HeaderValue): void {
    if (Array.isArray(value)) {
      for (const item of value) this.headersStore.append(name, String(item));
      return;
    }
    this.headersStore.set(name, String(value));
  }
}

/** 捕获器只实现路由实际需要的子集，集中在这里做类型收口。 */
export function asServerResponse(response: CapturingResponse | SseResponseCapture): ServerResponse {
  return response as unknown as ServerResponse;
}
/**
 * SSE 专用捕获器：先观察首个响应头，决定走普通 JSON 错误响应还是流式传输。
 * handler 仍按原有 SSE 文本写入；队列把帧交给 Hono streamSSE。
 */
export class SseResponseCapture extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  private readonly headersStore = new Headers();
  private readonly chunks: Uint8Array[] = [];
  private readonly waiters: Array<() => void> = [];
  private isSseResponse = false;
  private resolveReady!: () => void;
  readonly ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });

  get isSse(): boolean {
    return this.isSseResponse;
  }

  get headers(): Headers {
    return this.headersStore;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    if (Array.isArray(value)) {
      for (const item of value) this.headersStore.append(name, String(item));
    } else {
      this.headersStore.set(name, String(value));
    }
    return this;
  }

  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | Record<string, string | number | readonly string[]>,
    maybeHeaders?: Record<string, string | number | readonly string[]>,
  ): this {
    this.statusCode = statusCode;
    this.headersSent = true;
    if (typeof statusMessageOrHeaders === "string") {
      const headers = maybeHeaders ?? {};
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    } else if (statusMessageOrHeaders) {
      for (const [name, value] of Object.entries(statusMessageOrHeaders)) this.setHeader(name, value);
    }
    this.isSseResponse = statusCode === 200 && Boolean(this.headersStore.get("content-type")?.includes("text/event-stream"));
    this.resolveReady();
    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    this.headersSent = true;
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    this.wake();
    return true;
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    this.headersSent = true;
    this.resolveReady();
    this.wake();
    this.emit("finish");
    return this;
  }

  abort(): void {
    if (!this.writableEnded) {
      // close 必须在 writableEnded 置真前触发：chat handler 用该标志区分
      // 正常结束与客户端断连。
      this.emit("close");
      this.writableEnded = true;
      this.resolveReady();
      this.wake();
    }
  }

  toResponse(): Response {
    const body = this.chunks.length ? Buffer.concat(this.chunks.map((chunk) => Buffer.from(chunk))) : null;
    return new Response(body, { status: this.statusCode, headers: this.headersStore });
  }

  async *drain(): AsyncGenerator<Uint8Array> {
    while (true) {
      while (this.chunks.length) yield this.chunks.shift()!;
      if (this.writableEnded) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
