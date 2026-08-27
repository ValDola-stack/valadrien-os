# Reconciliation backlog — work on branches that never reached production

**Audited 2026-08-26** against the production lineage `sync/upstream-20260713` (`51969773a`).

## Why this file exists

`rebrand/valadrien-os` and `sync/upstream-20260713` are **178 commits / 1,654 files apart**.
Nearly every feature branch in this repo hangs off the *rebrand* lineage, while production runs
the *sync* lineage. So a branch being merged (into rebrand) does **not** mean its work is live.
This file records, per branch, what is still missing from production.

Reconciliation is already running in slices (slice 1 = agent portraits read-path + Digest,
`9716fe530`; slice 2 = portrait generation, `cb050b6f0`). Plan:
`~/Documents/Claude/Projects/ValAdrien.DEV/deliverables/valadrien-os-reconciliation-plan.md`.

## Highest-value items

1. **`feat/db-backed-run-logs` fixes a live, still-open bug.** Production has no run-log schema at
   all — it still uses the file/object-store path (`server/src/services/run-log-store.ts`) that
   produces **"Run log not found"** on every transcript. See `HANDOFF-run-logs-not-loading.md`:
   the fix exists, unmerged, since 2026-06-13. Its own schema comment names the root cause —
   the Railway worker writes logs where the Vercel control plane cannot read them.
2. **`feat/usage-billing-foundation` is an entire feature absent from production** — service,
   routes, schema, migration, and both test files.
3. **Several authz fixes are live in production but their tests are not**
   (`fix/cloud-upstreams-cross-tenant-authz`, `feat/per-tenant-runtime-fairness`,
   `feat/self-service-company-creation`) — guards running without a regression test behind them.

## Method (so this can be re-run)

Per branch: fork point = `git merge-base rebrand/valadrien-os <branch>`; the branch's own files =
`git diff --name-only <fork>..<branch>`; then each file's blob on the branch is compared against
the same path in `sync/upstream-20260713`. **ABSENT** = path does not exist in production.
**DIFFERS** = it exists, but production's content is not the branch's.

> Validated with a positive control: `feat/ceo-chat-port`, whose files were provably removed in
> `e8079cbd2`, is correctly reported ABSENT. An earlier pass computed the fork point against the
> wrong lineage and produced false "already in sync" verdicts — keep the control if you re-run this.

## Per-branch detail

### `feat/usage-billing-foundation`

`d75a4f11e` · 2026-06-15 · feat(billing): usage-based billing foundation (per-token + markup)

**6 absent from production:**

- `packages/db/src/migrations/0095_parallel_blizzard.sql`
- `packages/db/src/schema/billing_accounts.ts`
- `server/src/__tests__/billing-routes-authz.test.ts`
- `server/src/__tests__/billing-statement.test.ts`
- `server/src/routes/billing.ts`
- `server/src/services/billing.ts`

**5 differ from production:** `packages/db/src/migrations/meta/0095_snapshot.json`, `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/schema/index.ts`, `server/src/app.ts`, `server/src/services/index.ts`

### `feat/agent-portraits`

`8d07180c9` · 2026-06-15 · chore: regenerate portraits migration as 0094 (rebased after run-logs 0093)

**2 absent from production:**

- `packages/db/src/migrations/0094_clean_giant_girl.sql`
- `packages/db/src/migrations/meta/0094_snapshot.json`

**10 differ from production:** `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/schema/agents.ts`, `packages/shared/src/types/agent.ts`, `server/src/app.ts`, `server/src/routes/agents.ts`, `server/src/services/agent-portraits.ts`, `ui/src/api/agents.ts`, `ui/src/pages/AgentDetail.tsx`

### `feat/db-backed-run-logs`

`2019db0f4` · 2026-06-13 · feat(run-logs): DB-backed run transcripts (fixes "Run log not found")

**2 absent from production:**

- `packages/db/src/migrations/0093_burly_archangel.sql`
- `packages/db/src/schema/heartbeat_run_log_chunks.ts`

**7 differ from production:** `packages/db/src/migrations/meta/0093_snapshot.json`, `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/schema/index.ts`, `server/src/services/heartbeat.ts`, `server/src/services/issues.ts`, `server/src/services/recovery/service.ts`, `server/src/services/run-log-store.ts`

### `feat/observability`

`10562fc0c` · 2026-06-14 · feat(observability): wire Sentry (server + ui) + PostHog (ui)

**2 absent from production:**

- `server/src/instrument.ts`
- `ui/src/observability.ts`

**8 differ from production:** `packages/db/package.json`, `pnpm-lock.yaml`, `server/package.json`, `server/src/app.ts`, `server/src/index.ts`, `ui/package.json`, `ui/src/main.tsx`, `ui/vite.config.ts`

### `fix/linear-sync-hardening`

`29b9857a7` · 2026-07-02 · fix(bridge): drop os:dispatch by name, not first id (CodeRabbit #20)

**2 absent from production:**

- `packages/db/src/migrations/0096_early_hardball.sql`
- `server/src/routes/linear-os-sync.ts`

**3 differ from production:** `packages/db/src/migrations/meta/0096_snapshot.json`, `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/schema/issues.ts`

### `ui/tenant-guide`

`3cd89d7a8` · 2026-07-14 · docs(ui): add JSDoc to TenantGuide functions

**2 absent from production:**

- `HANDOFF-color-token-tests.md`
- `HANDOFF-stale-ui-bundle.md`

**15 differ from production:** `HANDOFF-vercel-production-branch.md`, `packages/db/src/schema/agents.ts`, `packages/shared/src/types/agent.ts`, `pnpm-lock.yaml`, `server/package.json`, `server/src/app.ts`, `server/src/routes/agents.ts`, `ui/src/App.tsx`

### `chore/coderabbit-primary-retire-korije`

`69634fbfe` · 2026-06-15 · chore(review): adopt CodeRabbit as primary PR reviewer, retire Korije

**1 absent from production:**

- `.coderabbit.yaml`

### `chore/governance-reconciliation`

`cce0f504a` · 2026-07-02 · docs: resolve Codex review on #18 (CodeRabbit/Korije status, fork authority)

**1 absent from production:**

- `OPERATING-SYSTEM.md`

**3 differ from production:** `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`

### `feat/db-backed-instructions`

`18b46b9a5` · 2026-06-10 · fix(instructions): harden materializer per Korije re-review — orphan cleanup + skip escaping paths

**1 absent from production:**

- `packages/db/src/migrations/0092_goofy_beast.sql`

**5 differ from production:** `packages/db/src/migrations/meta/0092_snapshot.json`, `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/schema/agents.ts`, `server/src/routes/agents.ts`, `server/src/services/heartbeat.ts`

### `feat/linear-os-sync`

`e601fc372` · 2026-07-02 · fix(bridge): address CodeRabbit review on #19

**1 absent from production:**

- `server/src/routes/linear-os-sync.ts`

**3 differ from production:** `server/src/app.ts`, `server/src/routes/index.ts`, `vercel.json`

### `feat/per-tenant-runtime-fairness`

`635613bf4` · 2026-06-15 · feat(runtime): per-tenant fairness + global concurrency caps

**1 absent from production:**

- `server/src/__tests__/runtime-fairness.test.ts`

**1 differ from production:** `server/src/services/heartbeat.ts`

### `feat/self-service-company-creation`

`5ab6f5853` · 2026-06-15 · feat(tenancy): self-service company creation (opt-in)

**1 absent from production:**

- `server/src/__tests__/self-service-company-creation-routes.test.ts`

**5 differ from production:** `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/instance.ts`, `server/src/routes/companies.ts`, `server/src/services/instance-settings.ts`, `ui/src/pages/InstanceGeneralSettings.tsx`

### `fix/cloud-upstreams-cross-tenant-authz`

`c32986488` · 2026-06-15 · fix(security): enforce company access on cloud-upstreams routes

**1 absent from production:**

- `server/src/__tests__/cloud-upstreams-cross-tenant-authz-routes.test.ts`

**1 differ from production:** `server/src/routes/cloud-upstreams.ts`

### `feat/auto-portrait-on-hire`

`7ebd0c459` · 2026-06-17 · feat(agents): auto-generate portrait on hire (fire-and-forget)

**1 differ from production:** `server/src/routes/agents.ts`

### `feat/deepseek-adapter-env`

`6b5124b62` · 2026-06-16 · feat(adapters): pass DEEPSEEK_API_KEY through to the agent runtime

**2 differ from production:** `server/src/services/plugin-loader.ts`, `server/src/services/secrets.ts`

### `feat/per-tenant-provider-keys`

`8de1e732c` · 2026-06-15 · feat(secrets): per-tenant provider keys override shared instance key

**3 differ from production:** `server/src/__tests__/heartbeat-project-env.test.ts`, `server/src/services/heartbeat.ts`, `server/src/services/secrets.ts`

### `fix/db-backup-watchdog`

`f3ced1157` · 2026-07-13 · fix(backup): watchdog + pg_dump so a stalled dump can't wedge all future backups

**7 differ from production:** `Dockerfile`, `packages/db/src/backup-lib.test.ts`, `packages/db/src/backup-lib.ts`, `packages/db/src/index.ts`, `packages/shared/src/config-schema.ts`, `server/src/config.ts`, `server/src/index.ts`

### `ui/agent-card-density`

`f0b4b0e2b` · 2026-07-14 · fix(dashboard): retry transient issue lookups so more resolve

**3 differ from production:** `ui/src/components/ActiveAgentsPanel.test.tsx`, `ui/src/components/ActiveAgentsPanel.tsx`, `ui/src/pages/DashboardLive.tsx`

## Deleted 2026-08-26 (recoverable by SHA)

Six branches were deleted as dead or content-contained. Recover any with
`git checkout -b <name> <sha>` while the objects survive gc:

| Branch | SHA | Why |
|---|---|---|
| `adopt/upstream-hotfixes` | `f68c31697` | ancestor of `rebrand/valadrien-os` |
| `deploy-merged` | `0aa233ea5` | ancestor of `rebrand/valadrien-os` |
| `pr-1-head` | `2fd521921` | ancestor of `rebrand/valadrien-os` |
| `pr-1-merge` | `4fab74306` | merge commit, zero file changes |
| `feat/portrait-gender-uniqueness` | `fe4df876c` | content already in production |
| `feat/ceo-chat-port` | `7facd82b6` | **dead by decision** — the PR #27 duplicate chat, stripped in `e8079cbd2`; Conference Room was kept instead. Do not revive. |

## Do not delete

- **`rebrand/valadrien-os`** — still the configured Vercel **Production Branch**, and therefore the
  only path production currently has. See `HANDOFF-vercel-production-branch.md`.
- Any branch above with absent files, until its work is reconciled or explicitly dropped.
