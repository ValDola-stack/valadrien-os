import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, heartbeatRunLogChunks } from "@valadrien-os/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";
import { getRunLogStore, type RunLogHandle } from "../services/run-log-store.ts";

// Differential test for the range-limited postgres read: for every (offset, limit) pair the
// paged read must return exactly what slicing the fully-materialised log would return.
describe("postgres run-log store — range read byte math", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let store: ReturnType<typeof getRunLogStore>;
  const companyId = randomUUID();
  const runId = randomUUID();
  const chunks = ["alpha\n", "beta-beta\n", "c\n", "dddddddddddddddd\n", "e\n"];
  const whole = chunks.join("");
  const handle = (): RunLogHandle => ({ store: "postgres", logRef: runId, companyId });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("valadrien-os-run-log-range-");
    db = createDb(tempDb.connectionString);
    store = getRunLogStore(db);
    // The harness applies real migrations, so the table already exists WITH its FKs. This test
    // only exercises byte-offset maths, so drop the parent FKs in this throwaway database rather
    // than fabricating full companies/heartbeat_runs rows. FK behaviour is covered separately by
    // the migration test (cascade + orphan rejection against a real database).
    await db.execute(`ALTER TABLE heartbeat_run_log_chunks
      DROP CONSTRAINT IF EXISTS heartbeat_run_log_chunks_company_id_companies_id_fk,
      DROP CONSTRAINT IF EXISTS heartbeat_run_log_chunks_run_id_heartbeat_runs_id_fk` as never);
    for (const content of chunks) {
      await db.insert(heartbeatRunLogChunks).values({
        companyId, runId, stream: "stdout", ts: new Date(), content,
      });
    }
  }, 30_000);

  afterAll(async () => { await tempDb?.stop?.(); });

  it("matches full-materialisation slicing for every offset/limit pair", async () => {
    const total = Buffer.byteLength(whole, "utf8");
    for (let offset = 0; offset <= total + 2; offset += 1) {
      for (const limit of [1, 2, 3, 7, 16, 512]) {
        const r = await store.read(handle(), { offset, limitBytes: limit });
        const expected = Buffer.from(whole, "utf8")
          .subarray(offset, Math.min(offset + limit, total)).toString("utf8");
        expect(r.content, `offset=${offset} limit=${limit}`).toBe(expected);
        const expNext = offset >= total ? undefined
          : (Math.min(offset + limit, total) < total ? Math.min(offset + limit, total) : undefined);
        expect(r.nextOffset, `nextOffset offset=${offset} limit=${limit}`).toBe(expNext);
      }
    }
  }, 120_000);

  it("an EMPTY log terminates paging (nextOffset undefined, not 0)", async () => {
    // Regression: returning a numeric nextOffset here made readFullRunLog() spin forever, and
    // begin() is explicitly designed to leave a run with no output reading back as empty.
    const empty = randomUUID();
    const r = await store.read({ store: "postgres", logRef: empty, companyId }, { offset: 0, limitBytes: 512_000 });
    expect(r.content).toBe("");
    expect(r.nextOffset).toBeUndefined();

    let guard = 0, offset = 0;
    for (;;) {
      if (++guard > 5) throw new Error("paging over an empty log did not terminate");
      const page = await store.read({ store: "postgres", logRef: empty, companyId }, { offset, limitBytes: 512_000 });
      if (page.nextOffset == null) break;
      offset = page.nextOffset;
    }
  }, 30_000);

  it("offset at or past the end terminates paging", async () => {
    const total = Buffer.byteLength(whole, "utf8");
    for (const offset of [total, total + 1, total + 999]) {
      const r = await store.read(handle(), { offset, limitBytes: 512_000 });
      expect(r.content, `offset=${offset}`).toBe("");
      expect(r.nextOffset, `offset=${offset}`).toBeUndefined();
    }
  }, 30_000);

  it("a full page walk reassembles the log exactly and terminates", async () => {
    for (const limit of [1, 5, 13, 1024]) {
      let offset = 0, combined = "", guard = 0;
      for (;;) {
        if (++guard > 500) throw new Error(`paging did not terminate at limit=${limit}`);
        const r = await store.read(handle(), { offset, limitBytes: limit });
        combined += r.content;
        if (r.nextOffset == null) break;
        offset = r.nextOffset;
      }
      expect(combined, `limit=${limit}`).toBe(whole);
    }
  }, 60_000);
});
