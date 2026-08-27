import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { loadConfig } from "../config.js";
import { createStorageProviderFromConfig } from "../storage/provider-registry.js";
import type { StorageProvider } from "../storage/types.js";
import { resolveValadrienOsInstanceRoot } from "../home-paths.js";

export type RunLogStoreType = "local_file" | "object_store";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
}

/**
 * Per-run total cap for object-store run logs. `doc/spec/agent-runs.md` requires strict caps on
 * non-file run-log backends; without one a stuck or noisy adapter can write unboundedly. Past the
 * cap we stop accepting output and append a single truncation marker.
 */
export const OBJECT_STORE_RUN_LOG_MAX_BYTES = 32 * 1024 * 1024;
/** Flush thresholds: bytes buffered, or age of the oldest unflushed byte. */
const OBJECT_STORE_FLUSH_BYTES = 64 * 1024;
const OBJECT_STORE_FLUSH_MS = 1_000;

/** True when a persisted `runs.log_store` value names a backend this process can read. */
export function isRunLogStoreType(value: string | null | undefined): value is RunLogStoreType {
  return value === "local_file" || value === "object_store";
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface RunLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string; seq?: number },
  ): Promise<number>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
}

function safeSegments(...segments: string[]) {
  return segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", nextOffset: start };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
  }

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return 0;
      const absPath = resolveWithin(basePath, handle.logRef);
      const line = JSON.stringify({
        ts: event.ts,
        stream: event.stream,
        chunk: event.chunk,
        // Monotonic per-run sequence so readers can dedupe and order records
        // even when several identical chunks share the same millisecond ts
        // (common for ACP-style token deltas).
        ...(typeof event.seq === "number" && Number.isFinite(event.seq) ? { seq: event.seq } : {}),
      });
      const persisted = `${line}\n`;
      await fs.appendFile(absPath, persisted, "utf8");
      return Buffer.byteLength(persisted, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");

      const hash = await sha256File(absPath);
      return {
        bytes: stat.size,
        sha256: hash,
        compressed: false,
      };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      return readFileRange(absPath, offset, limitBytes);
    },
  };
}

/**
 * Object-store run logs. Per `doc/spec/agent-runs.md` this is the cloud/serverless default: the
 * Railway worker writes to the shared object store and the Vercel control plane reads it back,
 * which is what the old local-file logs could not do across the two filesystems.
 *
 * Object stores cannot append, so a run buffers in memory and rewrites its object on a size/time
 * threshold rather than once per chunk. That keeps `append()` off the network for the common case
 * — it is awaited inside the adapter's stdout pump, so a per-chunk round trip would stall the
 * child process — at the cost of the reader trailing the writer by at most one flush interval.
 * Live tailing is served by the websocket path, which carries `seq`; this is the durable copy.
 */
export interface ObjectStoreRunLogOptions {
  /** Per-run byte cap. Defaults to OBJECT_STORE_RUN_LOG_MAX_BYTES. */
  maxBytes?: number;
  /** Flush once this many bytes are buffered. */
  flushBytes?: number;
  /** Flush once the oldest unflushed byte is this old (ms). */
  flushMs?: number;
}

export function createObjectStoreRunLogStore(
  provider: StorageProvider,
  options: ObjectStoreRunLogOptions = {},
): RunLogStore {
  const maxBytes = options.maxBytes ?? OBJECT_STORE_RUN_LOG_MAX_BYTES;
  const flushBytes = options.flushBytes ?? OBJECT_STORE_FLUSH_BYTES;
  const flushMs = options.flushMs ?? OBJECT_STORE_FLUSH_MS;
  type Pending = { chunks: Buffer[]; flushed: Buffer; oldestUnflushedAt: number; truncated: boolean };
  const pending = new Map<string, Pending>();

  function state(logRef: string): Pending {
    let p = pending.get(logRef);
    if (!p) {
      p = { chunks: [], flushed: Buffer.alloc(0), oldestUnflushedAt: 0, truncated: false };
      pending.set(logRef, p);
    }
    return p;
  }

  async function flush(logRef: string) {
    const p = state(logRef);
    if (p.chunks.length === 0) return;
    const body = Buffer.concat([p.flushed, ...p.chunks]);
    await provider.putObject({
      objectKey: logRef,
      body,
      contentType: "application/x-ndjson",
      contentLength: body.length,
    });
    p.flushed = body;
    p.chunks = [];
    p.oldestUnflushedAt = 0;
  }

  async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
    return Buffer.concat(parts);
  }

  async function totalBytes(logRef: string): Promise<number> {
    const head = await provider.headObject({ objectKey: logRef }).catch(() => null);
    // A run that produced no output never gets an object written; that reads back as an empty
    // transcript, not a 404 — the same contract begin() implies for the other stores.
    return head?.exists ? head.contentLength ?? 0 : 0;
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      // Keys must be company-prefixed to satisfy the storage layer's tenant scoping.
      const logRef = `${companyId}/run-logs/${agentId}/${runId}.ndjson`;
      pending.delete(logRef);
      return { store: "object_store", logRef };
    },

    async append(handle, event) {
      if (handle.store !== "object_store") return 0;
      const p = state(handle.logRef);
      if (p.truncated) return 0;

      const line = JSON.stringify({
        ts: event.ts,
        stream: event.stream,
        chunk: event.chunk,
        // Monotonic per-run sequence. The transcript UI dedupes and orders the websocket and
        // poller delivery paths on this; dropping it makes streamed tokens render twice.
        ...(typeof event.seq === "number" && Number.isFinite(event.seq) ? { seq: event.seq } : {}),
      });
      const persisted = Buffer.from(`${line}\n`, "utf8");

      const buffered = p.chunks.reduce((n, c) => n + c.length, 0);
      if (p.flushed.length + buffered + persisted.length > maxBytes) {
        p.truncated = true;
        p.chunks.push(Buffer.from(`${JSON.stringify({
          ts: event.ts,
          stream: "system",
          chunk: `[run log truncated at ${maxBytes} bytes]`,
        })}\n`, "utf8"));
        await flush(handle.logRef);
        return 0;
      }

      p.chunks.push(persisted);
      if (p.oldestUnflushedAt === 0) p.oldestUnflushedAt = Date.now();
      const nowBuffered = buffered + persisted.length;
      if (nowBuffered >= flushBytes || Date.now() - p.oldestUnflushedAt >= flushMs) {
        await flush(handle.logRef);
      }
      return persisted.length;
    },

    async finalize(handle) {
      if (handle.store !== "object_store") return { bytes: 0, compressed: false };
      await flush(handle.logRef);
      const p = state(handle.logRef);
      const body = p.flushed;
      pending.delete(handle.logRef);
      return { bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), compressed: false };
    },

    async read(handle, opts) {
      if (handle.store !== "object_store") throw notFound("Run log not found");
      const offset = Math.max(0, opts?.offset ?? 0);
      const limitBytes = opts?.limitBytes ?? 256_000;
      // headObject is O(1) — no scan of the log to learn its size.
      const total = await totalBytes(handle.logRef);
      // nextOffset MUST be undefined at/after the end, matching the local_file store: paging
      // callers (readFullRunLog) loop until it is null, so a number here spins forever on an
      // empty log — exactly what a run with no output produces.
      if (offset >= total) return { content: "", nextOffset: undefined };
      const end = Math.min(offset + limitBytes, total);
      // Native ranged GET: transfers only the requested window.
      const result = await provider.getObject({ objectKey: handle.logRef, range: { start: offset, end: end - 1 } });
      const buf = await drain(result.stream);
      return { content: buf.toString("utf8"), nextOffset: end < total ? end : undefined };
    },
  };
}

let cachedStore: RunLogStore | null = null;

/**
 * Dispatcher. `doc/spec/agent-runs.md` §6.3: local_file is the dev/local default and object_store
 * is the cloud/serverless default. We follow the instance's configured storage provider — a
 * local_disk instance keeps writing files; anything else (S3/R2/GCS) gets object-store run logs,
 * which is the only backend both the worker and the control plane can reach.
 */
export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const config = loadConfig();
  if (config.storageProvider === "local_disk") {
    const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolveValadrienOsInstanceRoot(), "data", "run-logs");
    cachedStore = createLocalFileRunLogStore(basePath);
  } else {
    cachedStore = createObjectStoreRunLogStore(createStorageProviderFromConfig(config));
  }
  return cachedStore;
}

/** Test seam: drop the cached store so a test can re-resolve it under different config. */
export function __resetRunLogStoreForTests() {
  cachedStore = null;
}
