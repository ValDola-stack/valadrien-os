# Vercel production branch — RESOLVED 2026-08-31

> **✅ DONE.** Production Branch is now `sync/upstream-20260713` and **Auto-assign Custom
> Production Domains is ENABLED**. A push to the sync branch creates a production deployment AND
> moves `os.valadrien.dev` to it. Both live at **Settings → Environments → Production → Branch
> Tracking** (not Settings → Git on the current dashboard).
>
> **The "pinned alias" in the old notes was a MISDIAGNOSIS.** `os.valadrien.dev` was never pinned
> by a rollback — auto-assign was simply switched off, which makes every production deployment
> require manual promotion. That is why `vercel --prod` kept building production and leaving the
> live domain behind. The `vercel alias set … --scope valdola-stacks-projects` workaround is no
> longer needed.
>
> Also worth remembering: the 402 `DEPLOYMENT_DISABLED` payment block (2026-08-26 → 08-31) stopped
> deployment **creation**, not just serving. Pushes made during it produced no builds and were
> never queued. After an outage like that, check `list_deployments` rather than assuming pushes
> landed.

The original problem statement and evidence are kept below for context.

---

## 1. The problem

Production lineage moved to **`sync/upstream-20260713`** (see the memory note: `master` is stale
and deploying it rolls prod back). Vercel's Production Branch was never moved with it and still
tracks **`rebrand/valadrien-os`**.

Consequence: **a push to `sync/upstream-20260713` builds a preview (`target: null`) and never
reaches `os.valadrien.dev`.** Production only moves when someone runs `vercel --prod` by hand.

## 2. Evidence (from `list_deployments`, 2026-08-26)

| Deployment | Commit | Ref | Trigger | target |
|---|---|---|---|---|
| `dpl_8XZHibpFc5SdTHcYu2vFF2vUdget` | `cb050b6f0` | `sync/upstream-20260713` | github push | **`null`** ← preview |
| `dpl_HwfRVh6TZgmQvQFyQJqZ3Md2x7Hz` | `9716fe530` | `sync/upstream-20260713` | github push | **`null`** ← preview |
| `dpl_CewNSgNhX2jQ7doyfe5BBw8XMmRn` | `cb050b6f0` | `sync-cutover` | CLI (`actor: claude-code_…_agent`) | `production` |
| `dpl_3ryj7hp88xU92aKkLzpvL7gLC4xH` | `3e3f01d01` | `rebrand/valadrien-os` | github push | `production` ← the setting, still working on the OLD branch |

The last row is the tell: a *push* to `rebrand/valadrien-os` still auto-targets production, which
is only possible if that branch is still the configured Production Branch.

**Note:** the current value was INFERRED from these deployment targets, not read from the setting.
Step 0 below is to confirm it directly.

## 3. Blocked on (clear both first)

1. **Vercel team is payment-blocked.** `os.valadrien.dev` and `valadrien.dev` both return
   `402` + `x-vercel-error: DEPLOYMENT_DISABLED`; project shows `"live": false` with a READY
   deployment behind it. This is team-wide on `ValDola-stack`, not a per-project pause.
   Lovable-hosted apps are unaffected. Fix is billing (spend limit or failed payment) in the
   Vercel dashboard.
2. **Local Vercel CLI token is expired** — the API returns
   `{"code":"forbidden","invalidToken":true}`. Re-auth with `vercel login` before any CLI step.
   (CLI is also outdated, 56.4.1 → 59.7.0.)

## 4. The fix

Project `valadrien-os-server` · `prj_GQOzJ3SG1yje5ze67ILqM35qHpdx` · team `team_HxifZfm9qyYJXqg21ZR8V4yo`

0. **Confirm the current value** — Settings → Git → Production Branch (on newer dashboards:
   Settings → Environments → Production → Branch Tracking). Expect `rebrand/valadrien-os`.
   If it already reads `sync/upstream-20260713`, stop: the diagnosis above is wrong, re-triage.
1. **Set Production Branch = `sync/upstream-20260713`** and save. Use the dashboard — this is the
   path that demonstrably worked in June. The REST API has no documented production-branch field
   on `PATCH /v9/projects/{id}`; don't improvise one.
2. **Adopt the setting once** — push a trivial commit to the branch, or Redeploy the latest commit
   with the Production target. Existing previews do NOT retroactively become production.
3. **⚠️ Re-point the pinned alias.** `os.valadrien.dev` is a **manually PINNED alias** (pinned by an
   earlier rollback). Neither `vercel --prod` nor `vercel promote` moves it, and a
   production-target build from push-to-deploy may not either. If step 5.2 shows the domain missing
   from the new deployment's alias array, run:
   `vercel alias set <new-deployment-url> os.valadrien.dev --scope valdola-stacks-projects`
   Until the alias follows, a correct production deploy is invisible on the live domain.

## 5. Verification

1. The new deployment for that push shows **`target: "production"`** (not `null`), and its
   `meta.githubCommitSha` equals the pushed HEAD.
2. Its alias array includes **`os.valadrien.dev`**.
3. `curl -s https://os.valadrien.dev/ | grep -oE 'assets/index-[^"]+\.js'` → hash changes.
4. `curl -so /dev/null -w '%{http_code}' https://os.valadrien.dev/` → **200**, not 402.
5. From then on: `git push` is the deploy. Stop hand-running `vercel --prod`.

## 6. Open question for the owner

`sync/upstream-20260713` is a **dated** branch name doing permanent duty as the production
lineage. Pointing Vercel at it is correct *today* and is the zero-risk move — do that first.
But consider separately whether that lineage should be promoted to a stable name (or `master`
fast-forwarded onto it and made production again), so the next upstream sync doesn't recreate
this exact drift. Don't block step 4 on deciding this.

## 7. Related, not fixed here

Railway (`valadrien_staff`, project `management-os`) has **no git auto-deploy at all** —
`source: null` + Dockerfile, shipped via `railway up`. It is currently healthy
(`/api/health` → 403 unauth = up; active deployment RUNNING). Wiring Railway to push-to-deploy
is a separate piece of work.

---

## Appendix — original handoff (resolved 2026-06-07, now superseded)

The team switched to a push-to-deploy policy but never applied the Vercel setting, so pushes to
`rebrand/valadrien-os` built previews (`target: null`) while production only moved via
`vercel promote` — which policy had just banned, freezing production entirely. Fixed by setting
Production Branch = `rebrand/valadrien-os` in Settings → Environments → Production → Branch
Tracking; `vercel promote` was retired at that point.

That fix was correct and worked. It went stale only because the production lineage later moved
to `sync/upstream-20260713` and the setting didn't follow.
