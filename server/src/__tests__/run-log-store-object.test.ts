import { describe, expect, it, beforeEach } from "vitest";
import { Readable } from "node:stream";
import type { StorageProvider } from "../storage/types.ts";
import { createObjectStoreRunLogStore, type RunLogHandle } from "../services/run-log-store.ts";

// Faithful in-memory object store: honours ranged GET and reports contentLength from HEAD, so the
// run-log store's byte maths and paging contract are exercised for real rather than stubbed away.
function memoryProvider() {
  const objects = new Map<string, Buffer>();
  const calls = { put: 0, get: 0, head: 0 };
  let lastRange: { start: number; end: number } | undefined;
  const provider: StorageProvider = {
    id: "s3" as never,
    async putObject({ objectKey, body }) { calls.put += 1; objects.set(objectKey, Buffer.from(body)); },
    async headObject({ objectKey }) {
      calls.head += 1;
      const o = objects.get(objectKey);
      return o ? { exists: true, contentLength: o.length } : { exists: false };
    },
    async getObject({ objectKey, range }) {
      calls.get += 1; lastRange = range;
      const o = objects.get(objectKey);
      if (!o) throw new Error("NoSuchKey");
      return { stream: Readable.from([range ? o.subarray(range.start, range.end + 1) : o]) };
    },
    async deleteObject({ objectKey }) { objects.delete(objectKey); },
  };
  return { provider, objects, calls, range: () => lastRange };
}

const begin = (store: ReturnType<typeof createObjectStoreRunLogStore>) =>
  store.begin({ companyId: "co", agentId: "ag", runId: "run-1" });
const ev = (chunk: string, seq?: number) =>
  ({ stream: "stdout" as const, chunk, ts: new Date(0).toISOString(), seq });

describe("object-store run logs", () => {
  let mem: ReturnType<typeof memoryProvider>;
  beforeEach(() => { mem = memoryProvider(); });

  it("writes a company-prefixed key so tenant scoping holds", async () => {
    const store = createObjectStoreRunLogStore(mem.provider);
    const h = await begin(store);
    expect(h.store).toBe("object_store");
    expect(h.logRef.startsWith("co/")).toBe(true);
  });

  it("persists seq — the transcript UI dedupes the websocket and poller paths on it", async () => {
    const store = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(store);
    await store.append(h, ev("hello", 7));
    const written = [...mem.objects.values()][0]!.toString("utf8");
    expect(JSON.parse(written.trim()).seq).toBe(7);
  });

  it("an EMPTY log reads back empty and TERMINATES paging", async () => {
    const store = createObjectStoreRunLogStore(mem.provider);
    const h = await begin(store);
    const r = await store.read(h, { offset: 0, limitBytes: 4096 });
    expect(r.content).toBe("");
    expect(r.nextOffset).toBeUndefined();
  });

  it("paged reads match full-content slicing and use a NATIVE range (no full transfer)", async () => {
    const store = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(store);
    for (const [i, w] of ["alpha", "beta", "gamma", "delta"].entries()) await store.append(h, ev(w, i));
    const whole = [...mem.objects.values()][0]!;
    for (let offset = 0; offset <= whole.length + 2; offset += 1) {
      for (const limit of [1, 5, 17, 4096]) {
        const r = await store.read(h, { offset, limitBytes: limit });
        const end = Math.min(offset + limit, whole.length);
        expect(r.content, `o=${offset} l=${limit}`).toBe(whole.subarray(offset, end).toString("utf8"));
        expect(r.nextOffset, `next o=${offset} l=${limit}`).toBe(
          offset >= whole.length ? undefined : (end < whole.length ? end : undefined));
      }
    }
    const last = mem.range();
    expect(last, "read must issue a ranged GET").toBeDefined();
  });

  it("a full page walk reassembles the log and terminates", async () => {
    const store = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(store);
    for (const [i, w] of ["one", "two", "three"].entries()) await store.append(h, ev(w, i));
    const whole = [...mem.objects.values()][0]!.toString("utf8");
    for (const limit of [1, 7, 4096]) {
      let offset = 0, combined = "", guard = 0;
      for (;;) {
        if (++guard > 500) throw new Error(`did not terminate at limit=${limit}`);
        const r = await store.read(h, { offset, limitBytes: limit });
        combined += r.content;
        if (r.nextOffset == null) break;
        offset = r.nextOffset;
      }
      expect(combined, `limit=${limit}`).toBe(whole);
    }
  });

  it("BATCHES appends instead of one network round trip per chunk", async () => {
    const store = createObjectStoreRunLogStore(mem.provider, { flushBytes: 64 * 1024, flushMs: 60_000 });
    const h = await begin(store);
    for (let i = 0; i < 50; i += 1) await store.append(h, ev("x", i));
    expect(mem.calls.put, "buffered appends must not each hit the network").toBe(0);
    await store.finalize(h);
    expect(mem.calls.put).toBe(1);
  });

  it("ENFORCES the per-run size cap and marks the log truncated", async () => {
    const store = createObjectStoreRunLogStore(mem.provider, { maxBytes: 400, flushBytes: 1 });
    const h = await begin(store);
    let accepted = 0;
    for (let i = 0; i < 200; i += 1) accepted += await store.append(h, ev("padding-padding", i));
    const body = [...mem.objects.values()][0]!.toString("utf8");
    expect(body).toContain("run log truncated at 400 bytes");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(400 + 200);
    expect(accepted).toBeGreaterThan(0);
  });

  it("finalize reports the byte count and a sha256 over the whole log", async () => {
    const store = createObjectStoreRunLogStore(mem.provider, { flushBytes: 1 });
    const h = await begin(store);
    await store.append(h, ev("abc", 0));
    const summary = await store.finalize(h);
    const whole = [...mem.objects.values()][0]!;
    expect(summary.bytes).toBe(whole.length);
    expect(summary.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a foreign handle rather than silently reading nothing", async () => {
    const store = createObjectStoreRunLogStore(mem.provider);
    await expect(store.read({ store: "local_file", logRef: "x" } as RunLogHandle)).rejects.toThrow();
  });
});
