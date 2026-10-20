/**
 * http-body.ts — 请求体读取 + 统一失败响应（413/400）
 * ============================================================
 * 从 index.ts 抽出的横切关注点：不依赖任何业务模块；
 * 「丢弃式排水」是此处最要紧的契约（踩坑见函数内注释）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** 单次请求体字节数上限：聊天消息 + 附件 base64 正常都在 1MB 内；文件上传另有 12MB 白名单 */
export const BODY_MAX_BYTES = 2_000_000;
export const BODY_TOO_LARGE_MSG = "请求体过大：单次请求上限 2MB，请减少附件或文本内容后重试";
/** 413 后丢弃式排水的追加字节上限：正常客户端的超限余量是 MB 级，超过视为攻击性流，直接断开 */
export const BODY_DRAIN_EXTRA_MAX_BYTES = 8_000_000;

/** readBody 超限时抛出；respondBadRequest 据此统一回 413（区别于业务错误的 400） */
export class BodyTooLargeError extends Error {
  constructor() { super(BODY_TOO_LARGE_MSG); this.name = "BodyTooLargeError"; }
}

/**
 * 读取请求体（Phase 0 加固版）。
 * 旧实现的两个内存 DoS 坑：① 按「字符串长度」统计而非字节数（多字节字符会被放大统计，
 * 但二进制 base64 反而漏判）；② 超限后只是 reject，data 监听仍挂着继续把数据拼进字符串。
 * 现在：Content-Length 预检可提前拒绝；流式累计字节数，超限立刻 pause + reject，
 * 由响应层回 413 并断开连接（Connection: close），不再累积任何数据。
 */
export function readBody(req: IncomingMessage, maxBytes = BODY_MAX_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    // Content-Length 预检：声明的长度已超限 → 不读不拼，直接判
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return;
      total += c.length;
      if (total > maxBytes) {
        tooLarge = true;
        req.pause(); // 停止接收：响应层回完 413 后由全局处理器断开连接
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 路由统一的失败响应：BodyTooLargeError → 413，其余一律 400 + 中文错误 */
export function respondBadRequest(res: ServerResponse, req: IncomingMessage, err: unknown): void {
  const tooLarge = err instanceof BodyTooLargeError;
  // 注意：这里**不要**带 `Connection: close`。node:http 在「响应结束 + 请求体没读完」
  // 时会自行 destroy socket（发 RST），可能把已写出的 413 冲掉（客户端只见 ECONNRESET）。
  // 正确姿势是保持 keep-alive，由下面的「丢弃式排水」读完剩余 body 后自己 end() 优雅关闭。
  res.writeHead(tooLarge ? 413 : 400, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  if (tooLarge) {
    // 请求体没被读完 → keep-alive 无法继续。不能直接 destroy：
    // 客户端可能还有积压 body 未送达，带 unread-data 关闭会触发 RST，
    // 把已发出的 413 一并冲掉（踩坑：客户端只见 ECONNRESET 拿不到状态码）。
    // 对策「丢弃式排水」：继续把剩余 body 读进黑洞直到流结束再关；
    // 攻击性无限流靠排水总量上限兜底（超限直接 destroy，RST 可接受）。
    res.on("finish", () => {
      let drained = 0;
      req.on("data", (c: Buffer) => {
        drained += c.length;
        if (drained > BODY_DRAIN_EXTRA_MAX_BYTES) req.socket?.destroy();
      });
      // 已读完剩余 body → 用 end() 发 FIN，不用 destroy()：destroy 在 Windows 上
      // 带未读数据/未清发送缓冲时会发 RST，可能把刚写出的 413 一起冲掉（ECONNRESET）。
      // 攻击性无限流才 destroy（此时 RST 可接受）。
      req.on("end", () => req.socket?.end());
      req.on("error", () => req.socket?.end());
      req.resume();
    });
  }
}
