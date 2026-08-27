import { describe, expect, it } from "vitest";
import { getRunLogStore, type RunLogHandle } from "../services/run-log-store.js";

// Pure-logic guard only. The paging contract and byte maths are covered against a real
// database in run-log-store-postgres-range.test.ts — a hand-stubbed db cannot meaningfully
// fake the SQL the read path now issues.
describe("postgres run-log store — append guard", () => {
  it("REJECTS a handle with no companyId instead of inserting an empty string", async () => {
    const db = {
      select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }),
      insert: () => ({ values: async () => {} }),
    } as never;
    const store = getRunLogStore(db);
    const bad: RunLogHandle = { store: "postgres", logRef: "11111111-1111-1111-1111-111111111111" };
    await expect(store.append(bad, { stream: "stdout", chunk: "x", ts: new Date(0).toISOString() }))
      .rejects.toThrow(/companyId/i);
  });
});
