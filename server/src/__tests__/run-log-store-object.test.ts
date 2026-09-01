import { describe, expect, it, beforeEach } from "vitest";
import { Readable } from "node:stream";
import type { StorageProvider } from "../storage/types.ts";
import { createObjectStoreRunLogStore, type RunLogHandle } from "../services/run-log-store.ts";

// Faithful in-memory object store: honours ranged GET and reports contentLength from HEAD, so the
// byte maths and paging contract are exercised for real. Instrumented for upload volume, and able
// to stall or fail on demand.
function memoryProvider(opts: { putDelayMs?: number } = {}) {
  const objects = new Map<string, Buffer>();
  const stats = { puts: 0, bytesUploaded: 0 };
  let failReadsWith: Error | null = null;
  let failPuts = 0;
  const notFound = () => { const e = new Error("NoSuchKey"); e.name = "NoSuchKey"; return e; };
  const provider: StorageProvider = {
    id: "s3" as never,
    async putObject({ objectKey, body }) {
      if (opts.putDelayMs) await new Promise((r) => setTimeout(r, opts.putDelayMs));
      if (failPuts > 0) { failPuts -= 1; throw new Error("ServiceUnavailable"); }
      stats.puts += 1; stats.bytesUploaded += body.length;
      objects.set(objectKey, Buffer.from(body));
    },
    async headObject({ objectKey }) {
      if (failReadsWith) throw failReadsWith;
      const o = objects.get(objectKey);
      return o ? { exists: true, contentLength: o.length } : { exists: false };
    },
    async getObject({ objectKey, range }) {
      if (failReadsWith) throw failReadsWith;
      const o = objects.get(objectKey);
      if (!o) throw notFound();
      return { stream: Readable.from([range ? o.subarray(range.start, range.end + 1) : o]) };
    },
    async deleteObject({ objectKey }) { objects.delete(objectKey); },
  };
  return {
    provider, objects, stats,
    failReads: (e: Error | null) => { failReadsWith = e; },
    failNextPuts: (n: number) => { failPuts = n; },
  };
}

const KEY = "co/run-logs/ag/run-1.ndjson";
const begin = (s: ReturnType<typeof createObjectStoreRunLogStore>, runId = "run-1") =>
  s.begin({ companyId: "co", agentId: "ag", runId });
const ev = (chunk: string, seq?: number) =>
  ({ stream: "stdout" as const, chunk, ts: new Date(0).toISOString(), seq });

async function walk(s: ReturnType<typeof createObjectStoreRunLogStore>, h: RunLogHandle, limit: number) {
  let offset = 0, out = "", guard = 0;
  for (;;) {
    if (++guard > 5000) throw new Error("paging did not terminate");
    const r = await s.read(h, { offset, limitBytes: limit });
    out += r.content;
    if (r.nextOffset == null) break;
    offset = r.nextOffset;
  }
  return out;
}

describe("object-store run logs (single object per run)", () => {
  let mem: ReturnType<typeof memoryProvider>;
  beforeEach(() => { mem = memoryProvider(); });

  it("writes a company-prefixed key so tenant scoping holds", async () => {
    const s = createObjectStoreRunLogStore(mem.provider);
    expect((await begin(s)).logRef).toBe(KEY);
  });

  it("persists seq — the transcript UI dedupes websocket vs poller on it", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s);
    await s.append(h, ev("hello", 7));
    expect(JSON.parse(mem.objects.get(KEY)!.toString("utf8").trim()).seq).toBe(7);
  });

  it("an EMPTY log reads back empty and TERMINATES paging", async () => {
    const s = createObjectStoreRunLogStore(mem.provider);
    const h = await begin(s);
    const r = await s.read(h, { offset: 0, limitBytes: 4096 });
    expect(r.content).toBe("");
    expect(r.nextOffset).toBeUndefined();
  });

  it("paged reads match full-content slicing across every offset/limit pair", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s);
    for (const [i, w] of ["alpha", "beta", "gamma", "delta"].entries()) await s.append(h, ev(w, i));
    const whole = mem.objects.get(KEY)!;
    for (let offset = 0; offset <= whole.length + 2; offset += 1) {
      for (const limit of [1, 5, 17, 4096]) {
        const r = await s.read(h, { offset, limitBytes: limit });
        const end = Math.min(offset + limit, whole.length);
        expect(r.content, `o=${offset} l=${limit}`).toBe(whole.subarray(offset, end).toString("utf8"));
      }
    }
    for (const limit of [1, 7, 4096]) expect(await walk(s, h, limit)).toBe(whole.toString("utf8"));
  });

  it("does NOT lose output appended while a flush is in flight", async () => {
    const slow = memoryProvider({ putDelayMs: 20 });
    const s = createObjectStoreRunLogStore(slow.provider, { flushBytes: 1, flushMs: 10_000 });
    const h = await begin(s);
    await Promise.all(Array.from({ length: 8 }, (_, i) => s.append(h, ev(`chunk-${i}`, i))));
    await s.finalize(h);
    const whole = slow.objects.get(KEY)!.toString("utf8");
    for (let i = 0; i < 8; i += 1) expect(whole, `chunk-${i} must survive`).toContain(`chunk-${i}`);
  });

  it("flushes on a TIMER when the run goes quiet", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1_000_000, flushMs: 30 });
    const h = await begin(s);
    await s.append(h, ev("quiet-run-output", 0));
    expect(mem.objects.get(KEY)!.length, "not flushed yet").toBe(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(mem.objects.get(KEY)!.toString("utf8")).toContain("quiet-run-output");
  });

  it("PROPAGATES a storage failure instead of returning an empty log", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s);
    await s.append(h, ev("real output", 0));
    const boom = new Error("AccessDenied"); boom.name = "AccessDenied";
    mem.failReads(boom);
    await expect(s.read(h, { offset: 0, limitBytes: 4096 })).rejects.toThrow(/AccessDenied/);
  });

  it("REPORTS a missing object rather than reading back a blank transcript", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s);
    await s.append(h, ev("output", 0));
    mem.objects.delete(KEY); // deleted object / wrong bucket-prefix
    await expect(s.read(h, { offset: 0, limitBytes: 4096 })).rejects.toThrow(/Run log not found/);
  });

  it("does not corrupt multibyte UTF-8 split by a page boundary", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s);
    await s.append(h, ev("héllo — wörld ✅ Ωmega", 0));
    const whole = mem.objects.get(KEY)!.toString("utf8");
    for (const limit of [1, 2, 3, 5, 7, 11]) {
      const paged = await walk(s, h, limit);
      expect(paged, `limit=${limit}`).toBe(whole);
      expect(paged.includes("�"), `limit=${limit} must not emit U+FFFD`).toBe(false);
    }
  });

  it("REQUEUES buffered output when an upload fails, and retries it", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1, flushMs: 10_000 });
    const h = await begin(s);
    mem.failNextPuts(1);
    await expect(s.append(h, ev("important-output", 0))).rejects.toThrow(/ServiceUnavailable/);
    await s.append(h, ev("second-output", 1));
    const whole = mem.objects.get(KEY)!.toString("utf8");
    expect(whole, "bytes from the failed flush must be retried, not dropped").toContain("important-output");
    expect(whole).toContain("second-output");
  });

  it("finalize THROWS rather than reporting bytes that never reached storage", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1_000_000, flushMs: 10_000 });
    const h = await begin(s);
    await s.append(h, ev("buffered-only", 0));
    mem.failNextPuts(99);
    await expect(s.finalize(h)).rejects.toThrow(/ServiceUnavailable/);
  });

  it("finalize is IDEMPOTENT — a second call repeats the summary", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s);
    await s.append(h, ev("some output", 0));
    const first = await s.finalize(h);
    const second = await s.finalize(h);
    expect(first.bytes).toBeGreaterThan(0);
    expect(second.bytes).toBe(first.bytes);
    expect(second.sha256).toBe(first.sha256);
  });

  it("finalize DRAINS appends that arrive during its own flush", async () => {
    const slow = memoryProvider({ putDelayMs: 25 });
    const s = createObjectStoreRunLogStore(slow.provider, { flushBytes: 1_000_000, flushMs: 10_000 });
    const h = await begin(s);
    await s.append(h, ev("first", 0));
    const fin = s.finalize(h);
    await new Promise((r) => setTimeout(r, 5));
    await s.append(h, ev("late-but-before-seal", 1));
    const summary = await fin;
    const durable = slow.objects.get(KEY)!.toString("utf8");
    // append() returned a byte count for this chunk, i.e. it claimed the output was accepted.
    // Finalizing with a single flush silently drops it: the snapshot was already detached when it
    // arrived, so it sits in p.chunks and is never uploaded.
    expect(durable, "output accepted before sealing must reach storage").toContain("late-but-before-seal");
    expect(durable).toContain("first");
    expect(summary.bytes, "summary must match what is actually durable").toBe(
      Buffer.byteLength(durable, "utf8"));
  });

  // --- Codex round 5, P1: finalize must await a flush already in flight -------------------
  it("WAITS for an in-flight flush before summarizing", async () => {
    const slow = memoryProvider({ putDelayMs: 40 });
    const s2 = createObjectStoreRunLogStore(slow.provider, { flushBytes: 1, flushMs: 10_000 });
    const h = await begin(s2);
    // Start a flush and do NOT await it: its snapshot is detached, so p.chunks is empty while the
    // PUT is still pending. A chunks-only drain loop would skip it and summarise stale state.
    const inflight = s2.append(h, ev("in-flight-output", 0));
    await new Promise((r) => setTimeout(r, 5));
    const summary = await s2.finalize(h);
    await inflight;
    const durable = slow.objects.get(KEY)!.toString("utf8");
    expect(durable, "the in-flight chunk must be durable").toContain("in-flight-output");
    expect(summary.bytes, "summary must cover the in-flight flush, not stale state")
      .toBe(Buffer.byteLength(durable, "utf8"));
  });

  // --- Codex round 5, P2: a failed timed flush must re-arm the timer ----------------------
  it("RE-ARMS the timer after a timed flush fails, so bytes still reach storage", async () => {
    const s2 = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1_000_000, flushMs: 30 });
    const h = await begin(s2);
    mem.failNextPuts(1);
    await s2.append(h, ev("quiet-output", 0));   // buffered; timer armed
    await new Promise((r) => setTimeout(r, 90)); // timer fires, PUT fails, must re-arm
    await new Promise((r) => setTimeout(r, 90)); // second attempt should succeed
    expect(mem.objects.get(KEY)!.toString("utf8"),
      "a failed timed flush must be retried without further output").toContain("quiet-output");
  });

  // --- Codex round 5, P2: in-flight bytes count against the cap ---------------------------
  it("COUNTS in-flight bytes against the size cap", async () => {
    const slow = memoryProvider({ putDelayMs: 40 });
    const s2 = createObjectStoreRunLogStore(slow.provider, { maxBytes: 300, flushBytes: 1, flushMs: 10_000 });
    const h = await begin(s2);
    const big = "x".repeat(180);
    const first = s2.append(h, ev(big, 0));      // detaches ~200b into an in-flight flush
    await new Promise((r) => setTimeout(r, 5));
    await s2.append(h, ev(big, 1));              // must NOT be admitted as if the log were empty
    await first;
    await s2.finalize(h).catch(() => undefined);
    const durable = slow.objects.get(KEY)!;
    expect(durable.length, "the cap must account for in-flight bytes").toBeLessThanOrEqual(300 + 200);
    expect(durable.toString("utf8")).toContain("run log truncated");
  });

  it("DROPS appends after finalize instead of rewriting the transcript", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s);
    await s.append(h, ev("original-output", 0));
    await s.finalize(h);
    expect(await s.append(h, ev("late-straggler", 99))).toBe(0);
    const whole = mem.objects.get(KEY)!.toString("utf8");
    expect(whole).toContain("original-output");
    expect(whole).not.toContain("late-straggler");
  });

  it("a late append after the finalized cache evicts the run ADOPTS durable content", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s, "victim");
    const key = "co/run-logs/ag/victim.ndjson";
    await s.append(h, ev("ORIGINAL-TRANSCRIPT", 0));
    await s.finalize(h);
    for (let i = 0; i < 300; i += 1) {
      const o = await begin(s, `filler-${i}`);
      await s.append(o, ev("x", 0));
      await s.finalize(o);
    }
    await s.append(h, ev("LATE-STRAGGLER", 99));
    const whole = mem.objects.get(key)!.toString("utf8");
    expect(whole, "the completed transcript must survive").toContain("ORIGINAL-TRANSCRIPT");
  });

  it("ABORTS rather than overwriting when adoption hits a transient read failure", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s, "victim2");
    const key = "co/run-logs/ag/victim2.ndjson";
    await s.append(h, ev("ORIGINAL", 0));
    await s.finalize(h);
    for (let i = 0; i < 300; i += 1) {
      const o = await begin(s, `f2-${i}`);
      await s.append(o, ev("x", 0));
      await s.finalize(o);
    }
    const boom = new Error("Timeout"); boom.name = "Timeout";
    mem.failReads(boom);
    await expect(s.append(h, ev("LATE", 99))).rejects.toThrow(/Timeout/);
    mem.failReads(null);
    expect(mem.objects.get(key)!.toString("utf8"), "must not have been overwritten").toContain("ORIGINAL");
  });

  it("enforces the per-run size cap and marks the log truncated", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { maxBytes: 400, flushBytes: 1 });
    const h = await begin(s);
    for (let i = 0; i < 200; i += 1) await s.append(h, ev("padding-padding", i));
    expect(mem.objects.get(KEY)!.toString("utf8")).toContain("run log truncated at 400 bytes");
  });

  it("finalize reports the byte count and a sha256 over the whole log", async () => {
    const s = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(s);
    await s.append(h, ev("abc", 0));
    const summary = await s.finalize(h);
    expect(summary.bytes).toBe(mem.objects.get(KEY)!.length);
    expect(summary.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a foreign handle rather than silently reading nothing", async () => {
    const s = createObjectStoreRunLogStore(mem.provider);
    await expect(s.read({ store: "local_file", logRef: "x" } as RunLogHandle)).rejects.toThrow();
  });
});
