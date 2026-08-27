import { describe, expect, it, beforeEach } from "vitest";
import { Readable } from "node:stream";
import type { StorageProvider } from "../storage/types.ts";
import { createObjectStoreRunLogStore, type RunLogHandle } from "../services/run-log-store.ts";

// Faithful in-memory object store: honours ranged GET, so byte maths is exercised for real.
// Instrumented for upload volume, and able to stall or fail on demand.
function memoryProvider(opts: { putDelayMs?: number } = {}) {
  const objects = new Map<string, Buffer>();
  const stats = { puts: 0, bytesUploaded: 0, gets: 0 };
  let failHeadAndGetWith: Error | null = null;
  let failPutMatching: { pattern: RegExp; error: Error; times: number } | null = null;
  const provider: StorageProvider = {
    id: "s3" as never,
    async putObject({ objectKey, body }) {
      if (opts.putDelayMs) await new Promise((r) => setTimeout(r, opts.putDelayMs));
      if (failPutMatching && failPutMatching.times > 0 && failPutMatching.pattern.test(objectKey)) {
        failPutMatching.times -= 1;
        throw failPutMatching.error;
      }
      stats.puts += 1;
      if (objectKey.endsWith(".ndjson")) stats.bytesUploaded += body.length;
      objects.set(objectKey, Buffer.from(body));
    },
    async headObject({ objectKey }) {
      if (failHeadAndGetWith) throw failHeadAndGetWith;
      const o = objects.get(objectKey);
      return o ? { exists: true, contentLength: o.length } : { exists: false };
    },
    async getObject({ objectKey, range }) {
      if (failHeadAndGetWith) throw failHeadAndGetWith;
      stats.gets += 1;
      const o = objects.get(objectKey);
      if (!o) { const e = new Error("NoSuchKey"); e.name = "NoSuchKey"; throw e; }
      return { stream: Readable.from([range ? o.subarray(range.start, range.end + 1) : o]) };
    },
    async deleteObject({ objectKey }) { objects.delete(objectKey); },
  };
  return {
    provider, objects, stats,
    fail: (e: Error | null) => { failHeadAndGetWith = e; },
    failPut: (pattern: RegExp, error: Error, times = 1) => { failPutMatching = { pattern, error, times }; },
  };
}

const begin = (s: ReturnType<typeof createObjectStoreRunLogStore>) =>
  s.begin({ companyId: "co", agentId: "ag", runId: "run-1" });
const ev = (chunk: string, seq?: number) =>
  ({ stream: "stdout" as const, chunk, ts: new Date(0).toISOString(), seq });

async function walk(store: ReturnType<typeof createObjectStoreRunLogStore>, h: RunLogHandle, limit: number) {
  let offset = 0, out = "", guard = 0;
  for (;;) {
    if (++guard > 2000) throw new Error("paging did not terminate");
    const r = await store.read(h, { offset, limitBytes: limit });
    out += r.content;
    if (r.nextOffset == null) break;
    offset = r.nextOffset;
  }
  return out;
}

describe("object-store run logs", () => {
  let mem: ReturnType<typeof memoryProvider>;
  beforeEach(() => { mem = memoryProvider(); });

  it("writes company-prefixed keys so tenant scoping holds", async () => {
    const s = createObjectStoreRunLogStore(mem.provider);
    const h = await begin(s);
    expect(h.logRef.startsWith("co/")).toBe(true);
  });

  it("persists seq — the transcript UI dedupes websocket vs poller on it", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s);
    await s.append(h, ev("hello", 7));
    const seg = [...mem.objects.entries()].find(([k]) => k.endsWith(".ndjson"))![1];
    expect(JSON.parse(seg.toString("utf8").trim()).seq).toBe(7);
  });

  it("an EMPTY log reads back empty and terminates paging", async () => {
    const s = createObjectStoreRunLogStore(mem.provider);
    const h = await begin(s);
    const r = await s.read(h, { offset: 0, limitBytes: 4096 });
    expect(r.content).toBe("");
    expect(r.nextOffset).toBeUndefined();
  });

  it("paged reads match full-content slicing across every offset/limit pair", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 20 });
    const h = await begin(s);
    for (const [i, w] of ["alpha", "beta", "gamma", "delta", "epsilon"].entries()) await s.append(h, ev(w, i));
    await s.finalize(h);
    const whole = await walk(s, h, 1_000_000);
    const buf = Buffer.from(whole, "utf8");
    for (let offset = 0; offset <= buf.length + 2; offset += 3) {
      for (const limit of [1, 4, 29, 4096]) {
        const r = await s.read(h, { offset, limitBytes: limit });
        expect(r.content, `o=${offset} l=${limit}`)
          .toBe(buf.subarray(offset, Math.min(offset + limit, buf.length)).toString("utf8"));
      }
    }
    for (const limit of [1, 7, 64, 4096]) expect(await walk(s, h, limit), `limit=${limit}`).toBe(whole);
  });

  // --- Codex P1: flush must not discard a chunk that arrives mid-upload -------------------
  it("does NOT lose output appended while a flush is in flight", async () => {
    const slow = memoryProvider({ putDelayMs: 25 });
    const s = createObjectStoreRunLogStore(slow.provider, { flushBytes: 1, flushMs: 10_000 });
    const h = await begin(s);
    // Fire concurrently: each append triggers a flush at flushBytes=1, so uploads overlap.
    await Promise.all(Array.from({ length: 8 }, (_, i) => s.append(h, ev(`chunk-${i}`, i))));
    await s.finalize(h);
    const whole = await walk(s, h, 1_000_000);
    for (let i = 0; i < 8; i += 1) expect(whole, `chunk-${i} must survive`).toContain(`chunk-${i}`);
  });

  // --- Codex P1: a quiet run must still reach durable storage ----------------------------
  it("flushes on a TIMER when the run goes quiet (no further append)", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1_000_000, flushMs: 30 });
    const h = await begin(s);
    await s.append(h, ev("quiet-run-output", 0));
    expect(mem.objects.has("co/run-logs/ag/run-1/00001.ndjson"),
      "nothing should be flushed yet").toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    const whole = await walk(s, h, 1_000_000);
    expect(whole, "timer must persist output without another append").toContain("quiet-run-output");
  });

  // --- Codex P1: segments, not whole-object rewrites -------------------------------------
  it("uploads O(bytes emitted), not the whole log on every flush", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 64, flushMs: 10_000 });
    const h = await begin(s);
    for (let i = 0; i < 120; i += 1) await s.append(h, ev(`line-${i}-padding`, i));
    await s.finalize(h);
    const logBytes = Buffer.byteLength(await walk(s, h, 1_000_000), "utf8");
    // Rewriting the full object each flush made this quadratic; segments keep it ~1x.
    expect(mem.stats.bytesUploaded).toBeLessThan(logBytes * 2);
  });

  // --- Codex P2: storage failures must not read as an empty transcript -------------------
  it("PROPAGATES a storage failure instead of returning an empty log", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s);
    await s.append(h, ev("real output", 0));
    const boom = new Error("AccessDenied"); boom.name = "AccessDenied";
    mem.fail(boom);
    await expect(s.read(h, { offset: 0, limitBytes: 4096 })).rejects.toThrow(/AccessDenied/);
  });

  // --- Codex P2: never split a multibyte character across pages --------------------------
  it("does not corrupt multibyte UTF-8 split by a page boundary", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s);
    await s.append(h, ev("héllo — wörld ✅ Ωmega", 0));
    await s.finalize(h);
    const whole = await walk(s, h, 1_000_000);
    for (const limit of [1, 2, 3, 5, 7, 11]) {
      const paged = await walk(s, h, limit);
      expect(paged, `limit=${limit}`).toBe(whole);
      expect(paged.includes("�"), `limit=${limit} must not emit U+FFFD`).toBe(false);
    }
  });

  // --- Codex round 3, P1: a failed flush must not silently drop its bytes ----------------
  it("REQUEUES buffered output when a segment upload fails, and finalize surfaces it", async () => {
    const s2 = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1, flushMs: 10_000 });
    const h = await begin(s2);
    const boom = new Error("ServiceUnavailable");
    mem.failPut(/\.ndjson$/, boom, 1);
    // First flush fails; its bytes must survive for the retry rather than vanishing.
    await expect(s2.append(h, ev("important-output", 0))).rejects.toThrow(/ServiceUnavailable/);
    await s2.append(h, ev("second-output", 1));
    const whole = await walk(s2, h, 1_000_000);
    expect(whole, "bytes from the failed flush must be retried, not dropped").toContain("important-output");
    expect(whole).toContain("second-output");
  });

  it("finalize THROWS rather than reporting a byte count the manifest does not cover", async () => {
    const s2 = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1_000_000, flushMs: 10_000 });
    const h = await begin(s2);
    await s2.append(h, ev("buffered-only", 0));
    mem.failPut(/\.ndjson$/, new Error("ServiceUnavailable"), 99);
    await expect(s2.finalize(h)).rejects.toThrow(/ServiceUnavailable/);
  });

  // --- Codex round 3, P2: heartbeat.ts finalizes the same handle twice -------------------
  it("finalize is IDEMPOTENT — a second call repeats the summary, not an empty log", async () => {
    const s2 = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s2);
    await s2.append(h, ev("some output", 0));
    const first = await s2.finalize(h);
    const second = await s2.finalize(h);
    expect(second.bytes, "second finalize must not report 0 bytes").toBe(first.bytes);
    expect(second.sha256).toBe(first.sha256);
    expect(first.bytes).toBeGreaterThan(0);
  });

  it("enforces the per-run size cap and marks the log truncated", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { maxBytes: 400, flushBytes: 1 });
    const h = await begin(s);
    for (let i = 0; i < 200; i += 1) await s.append(h, ev("padding-padding", i));
    const whole = await walk(s, h, 1_000_000);
    expect(whole).toContain("run log truncated at 400 bytes");
  });

  it("finalize reports byte count and a sha256 over the whole log", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s);
    await s.append(h, ev("abc", 0));
    const summary = await s.finalize(h);
    expect(summary.bytes).toBeGreaterThan(0);
    expect(summary.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a foreign handle rather than silently reading nothing", async () => {
    const s = createObjectStoreRunLogStore(mem.provider);
    await expect(s.read({ store: "local_file", logRef: "x" } as RunLogHandle)).rejects.toThrow();
  });
});
