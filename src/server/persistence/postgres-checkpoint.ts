/**
 * ============================================================
 * persistence/postgres-checkpoint.ts — owner 隔离的 PostgreSQL 检查点
 * ============================================================
 * 复用 MemorySaver 的 serde 与内存语义，只把 checkpoint/write 行落 PostgreSQL。
 * 所有查询都通过 withOwnerTransaction；thread_id 即使被猜到，也会被 RLS 拒绝。
 */
import { MemorySaver, type Checkpoint, type CheckpointMetadata } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { sanitizeCheckpointMessage } from "../../agent/checkpoint-sanitize.js";
import { log } from "../logging.js";
import { withOwnerTransaction } from "./postgres.js";

function sanitizeCheckpoint(checkpoint: Checkpoint): Checkpoint {
  const messages = (checkpoint.channel_values as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return checkpoint;
  return {
    ...checkpoint,
    channel_values: {
      ...checkpoint.channel_values,
      messages: messages.map((message) => {
        const candidate = message as { response_metadata?: unknown };
        return candidate && typeof candidate === "object" && "content" in candidate
          ? sanitizeCheckpointMessage(message as never)
          : message;
      }),
    },
  };
}

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_id: string | null;
  checkpoint_type: string;
  checkpoint_data: Buffer;
  metadata_type: string;
  metadata_data: Buffer;
}

interface WriteRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  channel: string;
  value_type: string;
  value_data: Buffer;
}

export class PostgresPersistentSaver extends MemorySaver {
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly ownerId: string;

  constructor(ownerId: string) {
    super();
    this.ownerId = ownerId;
  }

  filePathOf(): string {
    return `postgres:${this.ownerId}`;
  }

  async loadFromDisk(): Promise<void> {
    if (this.loaded) return;
    try {
      const rows = await withOwnerTransaction(this.ownerId, (client) => client.query<CheckpointRow & { seq: string }>(
        `SELECT seq, thread_id, checkpoint_ns, checkpoint_id, parent_id,
                checkpoint_type, checkpoint_data, metadata_type, metadata_data
         FROM checkpoint_rows WHERE owner_id = $1 ORDER BY seq ASC`,
        [this.ownerId],
      ));
      for (const row of rows.rows) {
        const checkpoint = await this.serde.loadsTyped(row.checkpoint_type, row.checkpoint_data) as Checkpoint;
        const metadata = await this.serde.loadsTyped(row.metadata_type, row.metadata_data) as CheckpointMetadata;
        await super.put({
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.parent_id ?? undefined,
          },
        }, checkpoint, metadata);
      }
      const writes = await withOwnerTransaction(this.ownerId, (client) => client.query<WriteRow & { seq: string }>(
        `SELECT seq, thread_id, checkpoint_ns, checkpoint_id, task_id, channel, value_type, value_data
         FROM checkpoint_writes WHERE owner_id = $1 ORDER BY seq ASC`,
        [this.ownerId],
      ));
      for (const row of writes.rows) {
        const value = await this.serde.loadsTyped(row.value_type, row.value_data);
        await super.putWrites({
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        }, [[row.channel, value]], row.task_id);
      }
      this.loaded = true;
    } catch (error) {
      log("error", "postgres_checkpoint_load_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    checkpoint = sanitizeCheckpoint(checkpoint);
    const [checkpointType, checkpointBytes] = await this.serde.dumpsTyped(checkpoint);
    const [metadataType, metadataBytes] = await this.serde.dumpsTyped(metadata);
    const result = await super.put(config, checkpoint, metadata);
    const threadId = config.configurable?.thread_id;
    if (typeof threadId === "string") {
      this.queue(async () => {
        await withOwnerTransaction(this.ownerId, (client) => client.query(
          `INSERT INTO checkpoint_rows
             (owner_id, thread_id, checkpoint_ns, checkpoint_id, parent_id,
              checkpoint_type, checkpoint_data, metadata_type, metadata_data, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            this.ownerId, threadId, String(config.configurable?.checkpoint_ns ?? ""), checkpoint.id,
            typeof config.configurable?.checkpoint_id === "string" ? config.configurable.checkpoint_id : null,
            checkpointType, Buffer.from(checkpointBytes), metadataType, Buffer.from(metadataBytes), Date.now(),
          ],
        ));
      });
    }
    return result;
  }

  override async putWrites(
    config: RunnableConfig,
    writes: Array<[string, unknown]>,
    taskId: string,
  ): Promise<void> {
    const entries = await Promise.all(writes.map(async ([channel, value]) => {
      const [valueType, valueBytes] = await this.serde.dumpsTyped(value);
      return { channel, valueType, valueBytes };
    }));
    await super.putWrites(config, writes, taskId);
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (typeof threadId !== "string" || typeof checkpointId !== "string") return;
    const checkpointNs = String(config.configurable?.checkpoint_ns ?? "");
    this.queue(async () => {
      await withOwnerTransaction(this.ownerId, async (client) => {
        for (const [idx, entry] of entries.entries()) {
          await client.query(
            `INSERT INTO checkpoint_writes
               (owner_id, thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value_data, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [this.ownerId, threadId, checkpointNs, checkpointId, taskId, idx, entry.channel,
              entry.valueType, Buffer.from(entry.valueBytes), Date.now()],
          );
        }
      });
    });
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    this.queue(async () => {
      await withOwnerTransaction(this.ownerId, async (client) => {
        await client.query("DELETE FROM checkpoint_writes WHERE owner_id = $1 AND thread_id = $2", [this.ownerId, threadId]);
        await client.query("DELETE FROM checkpoint_rows WHERE owner_id = $1 AND thread_id = $2", [this.ownerId, threadId]);
      });
    });
  }

  hasThread(threadId: string): boolean {
    const byNs = this.storage[threadId];
    return Boolean(byNs) && Object.keys(byNs).length > 0;
  }

  async flush(): Promise<void> {
    while (true) {
      const current = this.writeChain;
      await current;
      if (current === this.writeChain) break;
    }
  }

  async compactNow(): Promise<void> {
    // PostgreSQL 只做行级保留，不在请求热路径重写整个租户检查点。
  }

  private queue(work: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(work).catch((error) => {
      log("error", "postgres_checkpoint_write_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
}