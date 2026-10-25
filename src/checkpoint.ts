/**
 * ============================================================
 * checkpoint.ts — 持久化检查点（产品会话的重启续命层，F0）
 * ============================================================
 * 职责：general / estate 产品图共享一个文件版 checkpointer，
 * 把每个 thread 的检查点与中断写入落盘（.setting/checkpoints.ndjson），
 * 服务重启后多轮上下文完整延续 —— 不再退化为「journal 摘录注入」。
 *
 * 设计立场：
 * - 零新依赖：继承官方 MemorySaver，序列化完全复用其 serde
 *   （dumpsTyped/loadsTyped，消息类 ↔ 字节流的兼容性由官方包维护），
 *   本文件只做「把已序列化的字节 base64 后追加 NDJSON」。
 *   不引 @langchain/langgraph-checkpoint-sqlite：它带 better-sqlite3
 *   原生模块，Windows / Electron 部署与仓库零依赖红线冲突，
 *   而本方案的序列化与并发风险已由父类消化。
 * - 追加日志 + 回放收敛：put / putWrites / deleteThread 按调用顺序落行，
 *   启动回放走与运行时完全相同的内存路径（含 putWrites 的去重语义），
 *   重放后的状态与原进程严格一致。硬杀最多丢尾部半行 JSON，
 *   回放跳过坏行（与 journal 同策略）。
 * - 写入不阻塞回答流：落盘 fire-and-forget 自吞异常（同 journal 立场），
 *   优雅退出前 flushCheckpointLog() 兜底清队列。
 * - compact：文件超阈值时按行过滤重写 —— 每 (thread, ns) 只保留最近
 *   KEEP_PER_THREAD 个检查点及其写入行；最后操作是 delete 的线程整组丢弃。
 *   过滤只认本文件的行格式，不触碰 MemorySaver 内部结构。
 *
 * 边界：demo 图（示例 2/3）保持自建 MemorySaver 的教学形态，不经过本层；
 * 子 Agent（subagent.ts）一次性执行也不落盘，避免委派刷屏日志文件。
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemorySaver, type Checkpoint, type CheckpointMetadata } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { log } from "./server/logging.js";

/** 触发 compact 的文件大小上限（字节）；每线程只留最近 KEEP_PER_THREAD 个检查点 */
const CHECKPOINT_MAX_BYTES = 24_000_000;
/** compact 后每 (thread, ns) 保留的检查点数（留余量供 parent 链与回放定位） */
const KEEP_PER_THREAD = 10;
/** 每追加多少行探一次文件大小（避免每行 stat） */
const COMPACT_CHECK_EVERY = 64;

// 测试钩子：CHECKPOINT_FILE 指向临时文件（模式照抄 session-store 的 SESSIONS_FILE），
// 避免测试把检查点写进开发者真实的 .setting/ 目录。
// 注意：本文件在 src/ 顶层，只回退一层到仓库根（session-store 在 src/server/ 回退两层）。
const DEFAULT_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".setting",
  "checkpoints.ndjson"
);

type CkptLine = {
  type: "ckpt";
  thread: string;
  ns: string;
  id: string;
  /** 父检查点 id（checkpoint_ns 维度的链；可能为空） */
  parent?: string;
  /** serde 载荷类型与 base64 字节（正常都是 "json" 编码，成对存储以防未来换 serde） */
  ckptType: string;
  ckpt: string;
  metaType: string;
  meta: string;
};

type WriteLine = {
  type: "write";
  thread: string;
  ns: string;
  ckptId: string;
  taskId: string;
  entries: Array<{ channel: string; t: string; v: string }>;
};

type DeleteLine = { type: "delete"; thread: string };

type PersistLine = CkptLine | WriteLine | DeleteLine;

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromB64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

export class PersistentSaver extends MemorySaver {
  private readonly filePath: string;
  /** 当前实例的日志路径（备份枚举用；类外只读） */
  filePathOf(): string { return this.filePath; }
  /** 串行写链：保证行序 = 调用序（NDJSON 追加日志的收敛前提） */
  private writeChain: Promise<void> = Promise.resolve();
  private appendCount = 0;
  private loaded = false;
  /** 目录只建一次；所有文件 IO 前 await 它（appendFile 不会自建目录） */
  private readonly dirReady: Promise<void>;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    this.dirReady = mkdir(dirname(filePath), { recursive: true }).then(
      () => {},
      () => {}
    );
  }

  /** 启动时回放磁盘日志（幂等）。坏行跳过并告警，不影响其余行。 */
  async loadFromDisk(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.dirReady;
    const raw = await readFile(this.filePath, "utf8").catch(() => "");
    if (!raw) return;
    let badLines = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        badLines += 1; // 硬杀留下的半行等损坏 → 丢弃该行（与 journal 同策略）
        continue;
      }
      try {
        await this.replayLine(record as PersistLine);
      } catch {
        badLines += 1;
      }
    }
    if (badLines > 0) {
      log("warn", "checkpoint_load_corrupt_lines", { file: this.filePath, lines: badLines });
    }
  }

  /** 回放单行：走父类同一条内存路径（super.*，不再落盘），保证语义与运行时一致 */
  private async replayLine(record: PersistLine): Promise<void> {
    if (record.type === "ckpt") {
      const checkpoint = (await this.serde.loadsTyped(record.ckptType, fromB64(record.ckpt))) as Checkpoint;
      const metadata = (await this.serde.loadsTyped(record.metaType, fromB64(record.meta))) as CheckpointMetadata;
      await super.put(
        {
          configurable: {
            thread_id: record.thread,
            checkpoint_ns: record.ns,
            checkpoint_id: record.parent,
          },
        },
        checkpoint,
        metadata
      );
    } else if (record.type === "write") {
      for (const entry of record.entries ?? []) {
        const value = await this.serde.loadsTyped(entry.t, fromB64(entry.v));
        await super.putWrites(
          {
            configurable: {
              thread_id: record.thread,
              checkpoint_ns: record.ns,
              checkpoint_id: record.ckptId,
            },
          },
          [[entry.channel, value]],
          record.taskId
        );
      }
    } else if (record.type === "delete") {
      await super.deleteThread(record.thread);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    // 先自行序列化（super.put 内部会再序列一次；换来不依赖父类内部状态），
    // 再让父类落内存，最后把字节追加进日志 —— 三步顺序即回放顺序。
    const [[ckptType, ckptBytes], [metaType, metaBytes]] = await Promise.all([
      this.serde.dumpsTyped(checkpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    const result = await super.put(config, checkpoint, metadata);
    const threadId = config.configurable?.thread_id;
    if (typeof threadId !== "string") return result; // 父类已对缺 thread_id 抛错，这里只会是兜底
    this.queuePersist({
      type: "ckpt",
      thread: threadId,
      ns: (config.configurable?.checkpoint_ns as string | undefined) ?? "",
      id: checkpoint.id,
      parent: config.configurable?.checkpoint_id as string | undefined,
      ckptType,
      ckpt: toB64(ckptBytes),
      metaType,
      meta: toB64(metaBytes),
    });
    return result;
  }

  async putWrites(
    config: RunnableConfig,
    writes: Array<[string, unknown]>,
    taskId: string
  ): Promise<void> {
    // 与 put 同策略：先自行序列化全部写入，父类落内存后追加日志行。
    // 父类对重复 (taskId, idx) 有去重，回放时按同序走父类即可复现同样的去重结果。
    const entries = await Promise.all(
      writes.map(async ([channel, value]) => {
        const [t, bytes] = await this.serde.dumpsTyped(value);
        return { channel, t, v: toB64(bytes) };
      })
    );
    await super.putWrites(config, writes, taskId);
    const threadId = config.configurable?.thread_id;
    const ckptId = config.configurable?.checkpoint_id;
    if (typeof threadId !== "string" || typeof ckptId !== "string") return;
    this.queuePersist({
      type: "write",
      thread: threadId,
      ns: (config.configurable?.checkpoint_ns as string | undefined) ?? "",
      ckptId,
      taskId,
      entries,
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    this.queuePersist({ type: "delete", thread: threadId });
  }

  /**
   * 轻量存在性探测（restore 判定用）：直接看内存索引有没有该线程，
   * 不反序列化整个检查点。须在 loadFromDisk 之后调用。
   */
  hasThread(threadId: string): boolean {
    const byNs = this.storage[threadId];
    return Boolean(byNs) && Object.keys(byNs).length > 0;
  }

  /** 串行追加 + 周期性探大小触发 compact；失败只告警不打断回答流 */
  private queuePersist(line: PersistLine): void {
    this.appendCount += 1;
    const shouldProbe = this.appendCount % COMPACT_CHECK_EVERY === 0;
    this.writeChain = this.writeChain
      .then(async () => {
        await this.dirReady;
        await appendFile(this.filePath, JSON.stringify(line) + "\n", "utf8");
        if (shouldProbe) await this.maybeCompact();
      })
      .catch((err) => {
        log("error", "checkpoint_write_failed", {
          file: this.filePath,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /** 等待写链清空（优雅退出用）；期间可能又有新写入，循环等到链尾不再变化 */
  async flush(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const current = this.writeChain;
      await current;
      if (current === this.writeChain) break;
    }
  }

  private async maybeCompact(): Promise<void> {
    const st = await stat(this.filePath).catch(() => null);
    if (st && st.size >= CHECKPOINT_MAX_BYTES) await this.compactNow();
  }

  /**
   * 重写日志：只认本文件的行格式做过滤（不读 MemorySaver 内部结构）。
   *  - 最后操作是 delete 的线程：全部行丢弃（delete 行的使命随之完成）；
   *  - 每 (thread, ns) 只留 checkpoint_id 最近 KEEP_PER_THREAD 个（id 字典序
   *    即时间序，与 MemorySaver.getTuple 取最新的排序一致）；
   *  - write 行保留当且仅当其指向的检查点被保留。
   * 只会在写链内被调用（queuePersist），与追加天然串行，无竞态。
   */
  async compactNow(): Promise<void> {
    await this.dirReady;
    const raw = await readFile(this.filePath, "utf8").catch(() => "");
    if (!raw) return;
    const rows: PersistLine[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as PersistLine);
      } catch {
        /* 坏行直接在 compact 中丢弃 */
      }
    }
    const lastOp = new Map<string, "alive" | "deleted">();
    const order: Array<{ thread: string; ns: string; id: string }> = [];
    for (const row of rows) {
      if (row.type === "delete") lastOp.set(row.thread, "deleted");
      else {
        lastOp.set(row.thread, "alive");
        if (row.type === "ckpt") order.push({ thread: row.thread, ns: row.ns, id: row.id });
      }
    }
    const groups = new Map<string, Set<string>>();
    for (const { thread, ns, id } of order) {
      if (lastOp.get(thread) === "deleted") continue;
      const key = `${thread}\u0000${ns}`;
      const ids = groups.get(key) ?? new Set<string>();
      ids.add(id);
      groups.set(key, ids);
    }
    const keepIds = new Set<string>();
    for (const [key, ids] of groups) {
      const recent = [...ids].sort((a, b) => b.localeCompare(a)).slice(0, KEEP_PER_THREAD);
      for (const id of recent) keepIds.add(`${key}\u0000${id}`);
    }
    const kept = rows.filter((row) => {
      if (row.type === "ckpt") return keepIds.has(`${row.thread}\u0000${row.ns}\u0000${row.id}`);
      if (row.type === "write") {
        return (
          lastOp.get(row.thread) === "alive" &&
          keepIds.has(`${row.thread}\u0000${row.ns}\u0000${row.ckptId}`)
        );
      }
      return false; // delete 行：效果已由「整线程丢弃」体现
    });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, kept.length ? kept.map((r) => JSON.stringify(r)).join("\n") + "\n" : "", "utf8");
    await rename(tmp, this.filePath);
    log("info", "checkpoint_compacted", {
      file: this.filePath,
      linesBefore: rows.length,
      linesAfter: kept.length,
    });
  }
}

// ---------------------------------------------------------------------------
// 进程级单例：产品图（workflow 工厂）与 server 会话层共用同一实例。
// env 在首次取用时读取（测试按需先设 CHECKPOINT_FILE 再 resetCheckpointSaver）。
// ---------------------------------------------------------------------------

let saverSingleton: PersistentSaver | null = null;

export function getCheckpointSaver(): PersistentSaver {
  if (!saverSingleton) {
    saverSingleton = new PersistentSaver(process.env.CHECKPOINT_FILE || DEFAULT_FILE);
  }
  return saverSingleton;
}

/** 启动路径：取单例并完成磁盘回放（幂等，可安全重复调用） */
export async function ensureCheckpointsLoaded(): Promise<PersistentSaver> {
  const saver = getCheckpointSaver();
  await saver.loadFromDisk();
  return saver;
}

/** 优雅退出前等待检查点日志写完（index.ts 关停序列里与 flushJournal 并列） */
export async function flushCheckpointLog(): Promise<void> {
  await saverSingleton?.flush();
}

/** 当前检查点日志的实际路径（备份/恢复枚举用；env 钩子重绑后随之变化） */
export function checkpointFilePath(): string {
  if (saverSingleton) return saverSingleton.filePathOf();
  return process.env.CHECKPOINT_FILE || DEFAULT_FILE;
}

/** 测试专用：丢弃单例以便下一个用例换 CHECKPOINT_FILE 重建 */
export function resetCheckpointSaver(): void {
  saverSingleton = null;
}
