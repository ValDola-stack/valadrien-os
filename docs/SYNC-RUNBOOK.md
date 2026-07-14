# Upstream Sync Runbook — valadrien-os ⇄ paperclipai/paperclip

**Owner:** Val · **Last major sync:** 2026-07-13 (533 commits, forkpoint `96f0279e` 2026-05-23 → upstream release 2026.626.0+)

## Why this exists

valadrien-os is a fork of `paperclipai/paperclip` carrying one fork commit that is
**not** just a rebrand — it also contains fork features (company *infra managed*
mode / ValAdrien Cloud, infra entitlements, Vercel deployment support, disabled
release scripts). Upstream ships ~10 commits/day. Without discipline the fork
rots; with this pipeline a sync is a bounded, mostly-automated procedure.

## The toolchain (all in `scripts/sync/`)

| File | Role |
|---|---|
| `check-upstream.sh` | Read-only drift monitor → ntfy. Run by LaunchAgent daily. |
| `dev.valadrien.upstream-check.plist` | Mac LaunchAgent (08:00 daily). Edit `REPO_DIR`/`NTFY_TOPIC`, copy to `~/Library/LaunchAgents/`, `launchctl load`. |
| `.github/workflows/upstream-drift.yml` | Same monitor in GitHub Actions (Mon/Thu) — works with the Mac offline. Needs `NTFY_TOPIC` repo secret. |
| `sync-upstream.sh` | The sync driver. Creates `sync/upstream-<date>`, merges, auto-resolves, verifies. **Never touches master.** |
| `rebrand-codemod.py` | Idempotent brand transform (upstream→fork tokens) with protected keeps. Self-safe. |
| `three-way-resolve.py` | Rename-normalized 3-way merge: preserves fork *feature* code, not just branding. Writes real conflicts to `sync-conflicts.txt`. |

### Brand rules the codemod enforces
`@valadrien-os/`, `VALADRIEN_OS_*`, `valadrien_os_*`, `valadrienOs*`, `ValadrienOs*`,
kebab `valadrien-os`, header `x-valadrien-os-run-id`.
**Protected keeps (never renamed):** `hermes-paperclip-adapter`,
`paperclip_required`, `paperclipai` org / repo-slug URLs, lucide-react
`Paperclip` icon identifiers. Top-level identity docs (README, AGENTS, DESIGN,
CONTRIBUTING, Architecture, PRD, ROADMAP) are never auto-rewritten.

## Ongoing sync procedure (target: every 2–4 weeks, or on ntfy ping)

1. `NTFY_TOPIC=<topic> scripts/sync/sync-upstream.sh`
2. Exit 0 → nothing to do. Exit 2 → open Claude Code on the repo: files in
   `scripts/sync/sync-conflicts.txt` carry `<<<<<<<` markers where fork features
   collide with upstream refactors. Resolution policy: **upstream structure
   wins; port the fork feature delta onto it.**
3. `pnpm test:run` (or at minimum `test:run:general`) on the sync branch.
4. **Migrations gate (critical, client data):** see below.
5. Read upstream release notes (`releases/`) for breaking changes; check
   `docs/deploy/environment-variables.md` diff for NEW env vars → add to Vercel
   (Env vars, NOT Sensitive flag, per locked decision).
6. Deploy the sync branch to a staging Vercel deployment; smoke the client-facing flows.
7. Merge to master (`git checkout master && git merge sync/upstream-<date>`), push, deploy, tag `synced-<date>`.
8. Rollback path: master history is append-only (no force pushes); redeploy the previous tag from Vercel if anything regresses.

## Database migrations — the one place that can hurt clients

The fork added migrations `0090–0092` (infra managed/entitlements). Upstream
independently used those numbers for different migrations. Resolution adopted
in the 2026-07 sync:

- The migrations dir + journal are **upstream's** (through `0146`).
- The fork's three migration files are preserved in
  `scripts/sync/fork-migrations-backup/`.
- The fork's infra schema lives in `packages/db/src/schema/*`; regenerate its
  DDL as the **next** migration number via `pnpm db:generate` after every
  schema-level sync.
- **Production DB reconciliation:** the live DB already has the fork's infra
  tables (applied as old 0090–0092). Before running the migrator against prod:
  1. Back up (`pnpm db:backup`).
  2. Test the full migration run against a restored copy first.
  3. The regenerated infra migration must be idempotent (`IF NOT EXISTS`
     guards) OR pre-inserted into the drizzle migrations table on prod so it
     is skipped. Verify which applies before deploying.
  4. Upstream migrations 0090–0146 are NEW to prod and must apply cleanly on
     top of the existing schema — the restored-copy test is what proves this.

## First-sync status (2026-07-13, done in Claude cloud sandbox)

- 533 upstream commits merged; 406 conflicted files.
- 151 resolved as pure-rename, 51 by clean rename-normalized 3-way merge,
  21 markdown files taken upstream-side, migrations dir reset to upstream,
  remaining feature conflicts resolved file-by-file (see git history of the
  sync branch).
- Fork infra DDL regenerated as `0147_company_infra_managed.sql` with
  idempotent guards; journal entry appended. NOTE: `pnpm db:generate` is
  unusable in this repo — upstream stopped committing drizzle snapshots at
  `0099` while its journal runs to `0146`, so drizzle-kit diffs against a
  stale snapshot and prompts nonsense renames. Write future fork migrations
  by hand (SQL + journal entry), mirroring upstream's own practice.
- Verified on fresh Postgres: full chain 0000–0147 applies; companies-service
  13/13, heartbeat + teams-catalog suites green.
- Known follow-ups: `SYNC-TODO:` comments in code mark any fork behavior that
  could not be cleanly ported — `git grep -n 'SYNC-TODO'` lists them.
