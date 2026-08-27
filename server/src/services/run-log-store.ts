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
 * Object stores cannot append, so a run is stored as IMMUTABLE SEGMENTS plus a small manifest:
 *
 *   <prefix>/index.json      { segments: [{ key, bytes }], truncated }
 *   <prefix>/00001.ndjson    one flush worth of complete NDJSON lines
 *   <prefix>/00002.ndjson    ...
 *
 * Each flush uploads only the newly buffered bytes and rewrites the (tiny) manifest, so write
 * traffic is O(bytes emitted) rather than O(bytes²) — replacing one growing blob meant a run at
 * the 32MB cap re-uploaded roughly 8GiB across ~512 PUTs, each awaited by the adapter's output
 * pump. Reads consult the manifest for sizes (no scan) and issue ranged GETs against only the
 * segments overlapping the requested window.
 */
export function createObjectStoreRunLogStore(
  provider: StorageProvider,
  options: ObjectStoreRunLogOptions = {},
): RunLogStore {
  const maxBytes = options.maxBytes ?? OBJECT_STORE_RUN_LOG_MAX_BYTES;
  const flushBytes = options.flushBytes ?? OBJECT_STORE_FLUSH_BYTES;
  const flushMs = options.flushMs ?? OBJECT_STORE_FLUSH_MS;

  type Segment = { key: string; bytes: number };
  type Manifest = { segments: Segment[]; truncated: boolean };
  type Pending = {
    chunks: Buffer[];
    buffered: number;
    manifest: Manifest;
    hash: ReturnType<typeof createHash>;
    total: number;
    truncated: boolean;
    timer: NodeJS.Timeout | null;
    /** Last flush failure, surfaced by finalize() so a short transcript is never reported clean. */
    lastError: unknown;
    /** Segment landed but its manifest write failed; the manifest must be retried on its own. */
    manifestDirty: boolean;
    /** Serialises uploads: a flush must never overlap another flush on the same run. */
    chain: Promise<void>;
  };
  const pending = new Map<string, Pending>();
  /**
   * Completed summaries. heartbeat.ts finalizes the same handle twice when a run fails after its
   * normal finalize (normal path, then the error path), and a second call must not report an
   * empty log — that would persist zero bytes and the hash of "" over correct metadata.
   */
  const finalized = new Map<string, RunLogFinalizeSummary>();
  const FINALIZED_CACHE_MAX = 256;

  function state(logRef: string): Pending {
    let p = pending.get(logRef);
    if (!p) {
      p = {
        chunks: [], buffered: 0, manifest: { segments: [], truncated: false },
        hash: createHash("sha256"), total: 0, truncated: false, timer: null, lastError: null, manifestDirty: false,
        chain: Promise.resolve(),
      };
      pending.set(logRef, p);
    }
    return p;
  }

  const manifestKey = (logRef: string) => `${logRef}/index.json`;

  async function putManifest(logRef: string, manifest: Manifest) {
    const body = Buffer.from(JSON.stringify(manifest), "utf8");
    await provider.putObject({ objectKey: manifestKey(logRef), body, contentType: "application/json", contentLength: body.length });
  }

  async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
    return Buffer.concat(parts);
  }

  async function getManifest(logRef: string): Promise<Manifest> {
    let result;
    try {
      result = await provider.getObject({ objectKey: manifestKey(logRef) });
    } catch (error) {
      // begin() writes an empty manifest for EVERY object-store run before the handle is
      // persisted, so a run that emitted nothing still has one. A missing manifest therefore means
      // the object was deleted or the bucket/prefix is misconfigured — a real fault. Treating it
      // as "no output" would reproduce the silent-empty failure mode this store exists to remove.
      if (isObjectNotFound(error)) throw notFound("Run log not found");
      throw error;
    }
    try {
      return JSON.parse((await drain(result.stream)).toString("utf8")) as Manifest;
    } catch {
      throw new Error(`Run log manifest is unreadable for ${logRef}`);
    }
  }

  /** Enqueue a flush on the run's serial chain and wait for it. */
  function flush(logRef: string): Promise<void> {
    const p = state(logRef);
    const next = p.chain.then(async () => {
      // Detach the exact snapshot being uploaded BEFORE awaiting, so an append that lands during
      // the upload accumulates into the next flush instead of being cleared by this one.
      const snapshot = p.chunks;
      const snapshotBytes = p.buffered;
      if (snapshot.length === 0) {
        // Nothing new to upload, but a previous flush may have landed its segment and then failed
        // to write the manifest. Returning early there left the manifest permanently behind and
        // finalize() rethrowing a stale error turned an otherwise successful quiet run into a
        // failed one.
        if (p.manifestDirty) {
          await putManifest(logRef, p.manifest);
          p.manifestDirty = false;
          p.lastError = null;
        }
        return;
      }
      p.chunks = [];
      p.buffered = 0;
      if (p.timer) { clearTimeout(p.timer); p.timer = null; }

      const body = Buffer.concat(snapshot);
      const key = `${logRef}/${String(p.manifest.segments.length + 1).padStart(5, "0")}.ndjson`;
      try {
        await provider.putObject({ objectKey: key, body, contentType: "application/x-ndjson", contentLength: body.length });
      } catch (error) {
        // The segment never landed. Put the bytes back at the FRONT so ordering holds and the next
        // flush (or finalize) retries them — dropping them would let finalize report a byte count
        // and sha256 covering data that is not in the manifest, i.e. a silently short transcript.
        p.chunks = [...snapshot, ...p.chunks];
        p.buffered += snapshotBytes;
        p.lastError = error;
        throw error;
      }
      // Segment first, then manifest: a crash between the two leaves an unreferenced segment
      // (harmless) rather than a manifest pointing at an object that does not exist.
      p.manifest.segments.push({ key, bytes: body.length });
      p.manifest.truncated = p.truncated;
      p.manifestDirty = true;
      try {
        await putManifest(logRef, p.manifest);
        p.manifestDirty = false;
      } catch (error) {
        // The bytes ARE durable in the segment; only the manifest write failed. Do not requeue
        // (that would upload the same bytes again as a second segment). The in-memory manifest
        // already lists this segment, so the next flush's manifest write is self-healing.
        p.lastError = error;
        throw error;
      }
      p.lastError = null;
    });
    // Keep the chain usable after a failure, but never let a rejection go unobserved.
    p.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  function armTimer(logRef: string) {
    const p = state(logRef);
    if (p.timer) return;
    // A run that emits a little and then goes quiet must still reach durable storage. Checking the
    // age only on the NEXT append meant such a run stayed in process memory until finalize — and
    // vanished entirely if the worker hung or exited, which is the data-loss case this store exists
    // to remove.
    // A rejected timer flush is recorded on p.lastError and retried; swallow here so it
    // cannot surface as an unhandled rejection.
    p.timer = setTimeout(() => { void flush(logRef).catch(() => undefined); }, flushMs);
    p.timer.unref?.();
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      // Keys must be company-prefixed to satisfy the storage layer's tenant scoping.
      const logRef = `${companyId}/run-logs/${agentId}/${runId}`;
      pending.delete(logRef);
      // Write an empty manifest up front so a run that produces no output reads back as an empty
      // transcript rather than being indistinguishable from a storage failure.
      await putManifest(logRef, { segments: [], truncated: false });
      return { store: "object_store", logRef };
    },

    async append(handle, event) {
      if (handle.store !== "object_store") return 0;
      // A finalized run is sealed. Recreating pending state here would start a fresh manifest,
      // so the next flush would write 00001.ndjson OVER the original first segment and replace
      // index.json with a manifest listing only the late chunk — destroying a completed
      // transcript. Late callbacks (e.g. an adapter's unawaited socket-error logger firing as the
      // socket closes) are dropped rather than thrown, because throwing into a fire-and-forget
      // callback surfaces as an unhandled rejection in the worker.
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

      if (p.total + persisted.length > maxBytes) {
        p.truncated = true;
        const marker = Buffer.from(`${JSON.stringify({
          ts: event.ts, stream: "system",
          chunk: `[run log truncated at ${maxBytes} bytes]`,
        })}\n`, "utf8");
        p.chunks.push(marker);
        p.buffered += marker.length;
        p.total += marker.length;
        p.hash.update(marker);
        await flush(handle.logRef);
        return 0;
      }

      p.chunks.push(persisted);
      p.buffered += persisted.length;
      p.total += persisted.length;
      p.hash.update(persisted);
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
      await flush(handle.logRef);
      if (p.lastError) throw p.lastError;
      const summary = { bytes: p.total, sha256: p.hash.copy().digest("hex"), compressed: false };
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
      const manifest = await getManifest(handle.logRef);
      const segments = manifest.segments;
      const total = segments.reduce((n, seg) => n + seg.bytes, 0);
      // nextOffset MUST be undefined at/after the end, matching the local_file store: paging
      // callers (readFullRunLog) loop until it is null, so a number here spins forever on an
      // empty log — exactly what a run with no output produces.
      if (offset >= total) return { content: "", nextOffset: undefined };

      const end = Math.min(offset + limitBytes, total);
      // Over-fetch by up to 3 bytes so a page boundary landing inside a multibyte character can be
      // advanced to the next code-point boundary. Decoding a split character independently would
      // emit U+FFFD on both sides, and the caller — advancing by byte offset — never recombines
      // them, permanently corrupting that output.
      const fetchEnd = Math.min(end + 3, total);
      const parts: Buffer[] = [];
      let cursor = 0;
      for (const seg of segments) {
        const segStart = cursor;
        const segEnd = cursor + seg.bytes;
        cursor = segEnd;
        if (segEnd <= offset || segStart >= fetchEnd) continue;
        const from = Math.max(offset, segStart) - segStart;
        const to = Math.min(fetchEnd, segEnd) - segStart;
        const result = await provider.getObject({ objectKey: seg.key, range: { start: from, end: to - 1 } });
        parts.push(await drain(result.stream));
      }
      const buf = Buffer.concat(parts);
      const consumed = utf8BoundaryAtOrAfter(buf, end - offset);
      const nextOffset = offset + consumed < total ? offset + consumed : undefined;
      return { content: buf.subarray(0, consumed).toString("utf8"), nextOffset };
    },
  };
}

/**
 * Byte length to consume so a page ends on a complete UTF-8 code point: the smallest boundary at
 * or after `want`. If `want` lands mid-character the bytes there are continuation bytes (10xxxxxx),
 * so walking forward past them reaches the next lead byte. A page may therefore exceed the
 * requested limit by up to 3 bytes, which guarantees forward progress even at limitBytes=1.
 */
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
