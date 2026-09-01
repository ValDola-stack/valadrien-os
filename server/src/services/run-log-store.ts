import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { loadConfig } from "../config.js";
import { createStorageProviderFromConfig } from "../storage/provider-registry.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
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
export const OBJECT_STORE_RUN_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** Flush thresholds: bytes buffered, or age of the oldest unflushed byte. */
const OBJECT_STORE_FLUSH_BYTES = 256 * 1024;
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

export interface ObjectStoreRunLogOptions {
  /** Per-run byte cap. Defaults to OBJECT_STORE_RUN_LOG_MAX_BYTES. */
  maxBytes?: number;
  /** Flush once this many bytes are buffered. */
  flushBytes?: number;
  /** Flush this long after the first unflushed byte, even if the run has gone quiet (ms). */
  flushMs?: number;
}

/**
 * Object-store run logs. Per `doc/spec/agent-runs.md` this is the cloud/serverless default: the
 * Railway worker writes to the shared object store and the Vercel control plane reads it back,
 * which is what the old local-file logs could not do across the two filesystems.
 *
 * ONE OBJECT PER RUN, rewritten on flush. An earlier revision split runs into numbered segments
 * plus a manifest to make writes O(new bytes); that bought efficiency at the cost of segment
 * numbering, manifest adoption, dirty-manifest retries and missing-manifest semantics — six
 * interacting pieces of state that produced a data-corruption bug at every review round. The cap
 * is 4MB precisely so whole-object rewrites stay affordable: at a 256KB flush threshold a run that
 * fills the cap re-uploads ~34MB total, which is a bounded, boring cost in exchange for deleting
 * that entire class of failure.
 *
 * The remaining state is deliberately small: buffered chunks, a mirror of what is durable, and a
 * serial flush chain. Because the whole log is held in memory to rewrite it, `bytes` and `sha256`
 * are derived from that mirror at finalize rather than accumulated incrementally.
 */
export function createObjectStoreRunLogStore(
  provider: StorageProvider,
  options: ObjectStoreRunLogOptions = {},
): RunLogStore {
  const maxBytes = options.maxBytes ?? OBJECT_STORE_RUN_LOG_MAX_BYTES;
  const flushBytes = options.flushBytes ?? OBJECT_STORE_FLUSH_BYTES;
  const flushMs = options.flushMs ?? OBJECT_STORE_FLUSH_MS;

  type Pending = {
    /** Buffered, not yet durable. */
    chunks: Buffer[];
    buffered: number;
    /** Bytes detached into an in-flight flush: no longer in `buffered`, not yet in `flushed`. */
    inFlight: number;
    /** Mirror of the object as last written. The whole log, because we rewrite it wholesale. */
    flushed: Buffer;
    /** Whether `flushed` is known to match durable state (true for a run this process began). */
    adopted: boolean;
    truncated: boolean;
    timer: NodeJS.Timeout | null;
    /** Last flush failure; finalize rethrows so a short log is never reported as complete. */
    lastError: unknown;
    /** Serialises uploads: a flush must never overlap another flush on the same run. */
    chain: Promise<void>;
  };

  const pending = new Map<string, Pending>();
  /**
   * Completed summaries. heartbeat.ts finalizes the same handle twice when a run fails after its
   * normal finalize (success path :12972, then the error path :13244); a second call must repeat
   * the summary rather than report an empty log over correct metadata.
   */
  const finalized = new Map<string, RunLogFinalizeSummary>();
  const FINALIZED_CACHE_MAX = 256;

  function state(logRef: string): Pending {
    let p = pending.get(logRef);
    if (!p) {
      p = {
        chunks: [], buffered: 0, inFlight: 0, flushed: Buffer.alloc(0), adopted: false,
        truncated: false, timer: null, lastError: null, chain: Promise.resolve(),
      };
      pending.set(logRef, p);
    }
    return p;
  }

  async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
    return Buffer.concat(parts);
  }

  async function put(logRef: string, body: Buffer) {
    await provider.putObject({
      objectKey: logRef, body, contentType: "application/x-ndjson", contentLength: body.length,
    });
  }

  /**
   * Reconcile `flushed` against durable state. Only needed when in-memory state was RECREATED for
   * a run whose object already exists — a late append for a run that has aged out of the finalized
   * cache, say. Without this, the rewrite would replace a complete transcript with just the late
   * chunk. A run this process began is already adopted, so the common path costs nothing.
   */
  async function adopt(logRef: string, p: Pending) {
    if (p.adopted) return;
    let result;
    try {
      result = await provider.getObject({ objectKey: logRef });
    } catch (error) {
      // begin() writes the object before the handle is persisted, so a missing object means it was
      // deleted or the bucket/prefix is wrong — a real fault. Proceeding on ANY error would let a
      // transient timeout overwrite a good transcript with an empty one.
      if (isObjectNotFound(error)) throw notFound("Run log not found");
      throw error;
    }
    p.flushed = await drain(result.stream);
    p.adopted = true;
  }

  /** Enqueue a flush on the run's serial chain and wait for it. */
  function flush(logRef: string): Promise<void> {
    const p = state(logRef);
    const next = p.chain.then(async () => {
      // Detach the snapshot BEFORE awaiting so an append landing mid-upload accumulates into the
      // next flush instead of being cleared by this one.
      const snapshot = p.chunks;
      const snapshotBytes = p.buffered;
      if (snapshot.length === 0) return;
      p.chunks = [];
      p.buffered = 0;
      // Accounted as in-flight until it lands, so the cap check cannot admit another chunk on the
      // strength of bytes that are neither buffered nor durable yet.
      p.inFlight = snapshotBytes;
      if (p.timer) { clearTimeout(p.timer); p.timer = null; }

      try {
        await adopt(logRef, p);
        const body = Buffer.concat([p.flushed, ...snapshot]);
        await put(logRef, body);
        p.flushed = body;
        p.inFlight = 0;
        p.lastError = null;
      } catch (error) {
        // Put the bytes back at the FRONT so ordering holds and the next flush (or finalize)
        // retries them. Dropping them would let finalize report a byte count covering data that
        // never reached storage.
        p.chunks = [...snapshot, ...p.chunks];
        p.buffered += snapshotBytes;
        p.inFlight = 0;
        p.lastError = error;
        // :304 — the flush cleared the timer on its way in. Without re-arming, a quiet run whose
        // timed flush failed keeps its bytes in memory indefinitely: it still reads as empty and a
        // later worker death still loses the transcript, which is the case the timer exists for.
        armTimer(logRef);
        throw error;
      }
    });
    // Keep the chain usable after a failure, and never leave a rejection unobserved.
    p.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  function armTimer(logRef: string) {
    const p = state(logRef);
    if (p.timer) return;
    // A run that emits a little then goes quiet must still reach durable storage. Checking elapsed
    // time only on the NEXT append left such a run in process memory until finalize — and lost it
    // entirely if the worker hung or exited, which is the data loss this store exists to remove.
    // The rejection is recorded on lastError and retried; swallow it here so a timer cannot raise
    // an unhandled rejection.
    p.timer = setTimeout(() => { void flush(logRef).catch(() => undefined); }, flushMs);
    p.timer.unref?.();
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      // Keys must be company-prefixed to satisfy the storage layer's tenant scoping.
      const logRef = `${companyId}/run-logs/${agentId}/${runId}.ndjson`;
      pending.delete(logRef);
      finalized.delete(logRef);
      // Write the object up front so a run that produces no output reads back as an empty
      // transcript, and so a LATER missing object is unambiguously a fault rather than "no output".
      await put(logRef, Buffer.alloc(0));
      const p = state(logRef);
      p.adopted = true; // we just wrote it; durable content is known-empty
      return { store: "object_store", logRef };
    },

    async append(handle, event) {
      if (handle.store !== "object_store") return 0;
      // A finalized run is sealed. Recreating state here and rewriting would replace a completed
      // transcript with just the late chunk. Late callbacks (an adapter's unawaited socket-error
      // logger firing as the socket closes) are dropped rather than thrown, because throwing into
      // a fire-and-forget callback surfaces as an unhandled rejection in the worker.
      if (finalized.has(handle.logRef)) return 0;
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
      const current = p.flushed.length + p.buffered + p.inFlight;

      if (current + persisted.length > maxBytes) {
        p.truncated = true;
        const marker = Buffer.from(`${JSON.stringify({
          ts: event.ts, stream: "system",
          chunk: `[run log truncated at ${maxBytes} bytes]`,
        })}\n`, "utf8");
        p.chunks.push(marker);
        p.buffered += marker.length;
        await flush(handle.logRef);
        return 0;
      }

      p.chunks.push(persisted);
      p.buffered += persisted.length;
      if (p.buffered >= flushBytes) await flush(handle.logRef);
      else armTimer(handle.logRef);
      return persisted.length;
    },

    async finalize(handle) {
      if (handle.store !== "object_store") return { bytes: 0, compressed: false };
      const cached = finalized.get(handle.logRef);
      if (cached) return cached;
      const p = state(handle.logRef);
      if (p.timer) { clearTimeout(p.timer); p.timer = null; }

      // Settle, don't single-flush. Two orderings must both be handled: a flush ALREADY in flight
      // when finalize starts (its snapshot is detached, so p.chunks is empty and a chunks-only
      // loop would skip it and summarise stale p.flushed), and an append arriving DURING
      // finalize's own flush. Awaiting the chain first covers the former; re-checking covers the
      // latter.
      for (let guard = 0; ; guard += 1) {
        if (guard > 32) throw new Error(`Run log did not settle for ${handle.logRef}`);
        await p.chain;
        if (p.chunks.length === 0) break;
        await flush(handle.logRef);
      }
      if (p.lastError) throw p.lastError;

      const summary: RunLogFinalizeSummary = {
        bytes: p.flushed.length,
        sha256: createHash("sha256").update(p.flushed).digest("hex"),
        compressed: false,
      };
      if (finalized.size >= FINALIZED_CACHE_MAX) {
        const oldest = finalized.keys().next().value;
        if (oldest !== undefined) finalized.delete(oldest);
      }
      finalized.set(handle.logRef, summary);
      pending.delete(handle.logRef);
      return summary;
    },

    async read(handle, opts) {
      if (handle.store !== "object_store") throw notFound("Run log not found");
      const offset = Math.max(0, opts?.offset ?? 0);
      const limitBytes = opts?.limitBytes ?? 256_000;
      // headObject is O(1) — no scan, and no full transfer just to learn the size.
      const head = await provider.headObject({ objectKey: handle.logRef });
      // begin() always writes the object, so a missing one is a fault, not "no output". Reporting
      // it as an empty transcript would recreate the silent-empty failure this store removes.
      if (!head.exists) throw notFound("Run log not found");
      const total = head.contentLength ?? 0;
      // nextOffset MUST be undefined at/after the end, matching the local_file store: paging
      // callers (readFullRunLog) loop until it is null, so a number here spins forever on an empty
      // log — exactly what a run with no output produces.
      if (offset >= total) return { content: "", nextOffset: undefined };

      const end = Math.min(offset + limitBytes, total);
      // Over-fetch up to 3 bytes so a page boundary inside a multibyte character can advance to the
      // next code point. Decoding a split character independently emits U+FFFD on both sides, and
      // the caller advancing by byte offset never recombines them.
      const fetchEnd = Math.min(end + 3, total);
      const result = await provider.getObject({
        objectKey: handle.logRef, range: { start: offset, end: fetchEnd - 1 },
      });
      const buf = await drain(result.stream);
      const consumed = utf8BoundaryAtOrAfter(buf, end - offset);
      const nextOffset = offset + consumed < total ? offset + consumed : undefined;
      return { content: buf.subarray(0, consumed).toString("utf8"), nextOffset };
    },
  };
}

function utf8BoundaryAtOrAfter(buf: Buffer, want: number): number {
  if (want >= buf.length) return buf.length;
  let i = Math.max(0, want);
  while (i < buf.length && (buf[i]! & 0xc0) === 0x80) i += 1;
  return i === 0 ? buf.length : i;
}

/** True when a storage error means "no such object" rather than a transport/permission failure. */
function isObjectNotFound(error: unknown): boolean {
  const code = (error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null);
  if (!code) return false;
  if (code.$metadata?.httpStatusCode === 404) return true;
  return code.name === "NoSuchKey" || code.name === "NotFound" || code.Code === "NoSuchKey";
}

let cachedStore: RunLogStore | null = null;

/**
 * Dispatcher. `doc/spec/agent-runs.md` §6.3: local_file is the dev/local default and object_store
 * is the cloud/serverless default.
 *
 * Crucially, `begin()` picks the backend from configuration but every OTHER operation routes on
 * the handle's own `store`. An instance that switches to S3 keeps historical `local_file` runs
 * readable — routing reads by current config would send every pre-existing run to the object-store
 * reader, which rejects them even though the file is still sitting on disk.
 */
export function getRunLogStore(): RunLogStore {
  if (cachedStore) return cachedStore;
  const config = loadConfig();
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolveValadrienOsInstanceRoot(), "data", "run-logs");
  const local = createLocalFileRunLogStore(basePath);
  // Build the object-store READER whenever S3 settings exist, independently of which backend
  // begin() selects. Tying the reader to the current provider broke both directions in turn:
  // switching to S3 stranded local_file runs, and gating it the other way strands object_store
  // runs the moment an instance switches back to local_disk, even though the objects are still
  // there. Both readers stay available; only new runs follow the configured provider.
  const objectProvider = config.storageProvider === "local_disk"
    ? (config.storageS3Bucket
        ? createS3StorageProvider({
            bucket: config.storageS3Bucket,
            region: config.storageS3Region,
            endpoint: config.storageS3Endpoint,
            prefix: config.storageS3Prefix,
            forcePathStyle: config.storageS3ForcePathStyle,
          })
        : null)
    : createStorageProviderFromConfig(config);
  const object = objectProvider ? createObjectStoreRunLogStore(objectProvider) : null;

  function forHandle(handle: RunLogHandle): RunLogStore {
    if (handle.store !== "object_store") return local;
    if (!object) throw notFound("Run log not found");
    return object;
  }

  cachedStore = {
    begin: (input) => (config.storageProvider === "local_disk" ? local : (object ?? local)).begin(input),
    append: (handle, event) => forHandle(handle).append(handle, event),
    finalize: (handle) => forHandle(handle).finalize(handle),
    read: (handle, opts) => forHandle(handle).read(handle, opts),
  };
  return cachedStore;
}

/** Test seam: drop the cached store so a test can re-resolve it under different config. */
export function __resetRunLogStoreForTests() {
  cachedStore = null;
}
