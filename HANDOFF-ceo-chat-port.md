# HANDOFF — Advisory Chat (CEO / Portfolio Assistant) port

**Status:** UI **and** server endpoint landed on this branch. Remaining: set `ANTHROPIC_API_KEY` on the deployment and do a live streaming smoke (needs a running server + key).
**Branch:** `feat/ceo-chat-port` (cut from `origin/master`).
**Provenance:** ported from the archived `management-os` dashboard, commit `69533a0`
("feat(dashboard): CEO Chat, portfolio Assistant, and per-project Org Chart").
That repo is archived/read-only; the source commit is preserved as a git bundle at
`…/ValAdrien.DEV/management-os-runtime/backups/session-a-runtime-69533a0.bundle`.

---

## Why this is a partial port (read first)

The source commit added 22 files. Most of it is **already present, and better, in
valadrien-os**, so it was deliberately NOT ported:

| Source file (management-os) | Dropped because valadrien-os already has |
|---|---|
| `components/org/org-chart.tsx` | `ui/src/pages/OrgChart.tsx` (mature, 24 KB) + `/org` route |
| `lib/markdown.tsx` (bespoke, dependency-free) | `ui/src/components/MarkdownBody.tsx` + `@tailwindcss/typography` |
| `components/chat/assistant-dock.tsx` (⌘K sheet) | `ui/src/components/CommandPalette.tsx` (cmdk), wired in `Layout.tsx` |
| `components/ui/button-link.tsx`, sidebar/layout edits | Next.js-specific (`next/link`); different shell |

**The one genuinely new capability** — an Anthropic-grounded *advisory* chat (CEO +
portfolio-assistant modes) — has no equivalent here (valadrien-os has agent
issue-chat and Claude *billing* panels, but no advisory chat). That is what was ported.

---

## What landed — UI (`ui/`)

- `ui/src/components/chat/ChatPanel.tsx` — the chat surface. Streams from
  `POST /api/chat`, renders assistant output via the repo's `MarkdownBody`.
  Supports both `mode="assistant"` and `mode="ceo"`. Advisory only.
- `ui/src/pages/Assistant.tsx` — portfolio-wide assistant page (`mode="assistant"`).
- `ui/src/App.tsx` — added `<Route path="assistant" element={<Assistant />} />`.

`pnpm -C ui typecheck` passes. No dev-server run (repo rule: Vite dev crashes this laptop).

---

## What landed — server (`server/src/routes/chat.ts`)

`POST /api/chat` is implemented and registered (`api.use(chatRoutes(db))` in
`server/src/app.ts`, before the `/api` 404 fallthrough). Server typechecks and builds
to `dist` clean.

- **Auth:** `assertBoard(req)` — operator/board only, throws 403 before any stream headers.
- **Request contract** (what the UI sends): `{ mode: "assistant"|"ceo", companySlug?, messages: [{role,content}] }`.
- **Response contract:** streamed `text/plain` (NOT SSE) — the raw Anthropic
  `content_block_delta` text deltas are written straight to the Express response;
  `ChatPanel` reads them via `res.body.getReader()`. Errors are written as a short
  text reply, never thrown after headers.
- **Model call:** raw HTTPS to the Anthropic Messages API via Node's global `fetch`
  (`stream: true`) — deliberately **no `@anthropic-ai/sdk` dependency added** to the
  shared server lockfile for a single v1 endpoint. Swap to the SDK if the surface grows.
- **Data grounding — remapped to valadrien-os's own services** (not the source's
  management-os Supabase tables): assistant mode uses `companyService.list()` (names +
  `spentMonthlyCents` / `budgetMonthlyCents`); CEO mode resolves the company
  (`getById`, name fallback) then `dashboardService.summary()` (agents / tasks / costs /
  pendingApprovals) + `agentService.list()`. Money is in **cents** → formatted to USD.
- **Model default:** `claude-opus-4-8` (per claude-api guidance), override via
  `CHAT_MODEL`; `CHAT_MAX_TOKENS` default 1500. No thinking config — keeps first-token
  latency low for a chat surface.

### Remaining for the deployment owner
1. **Set `ANTHROPIC_API_KEY`** in the server env (Railway / Vercel). Without it the
   endpoint streams a "not configured yet" message — the UI still renders.
2. **Live smoke:** with the key set and a booted server, hit `/api/chat` as a board
   user and confirm tokens stream. (Not runnable from a bare checkout — needs the built
   workspace + DB + key; that's why it wasn't done here.)

---

## Follow-ups (optional, not blocking)

- **CEO-mode wiring:** `ChatPanel` already supports `mode="ceo"` + `companySlug`, and
  the server resolves a company by id or name. Add a collapsible CEO-chat entry to a
  company detail page when desired (pass the company id as `companySlug`).
- **DESIGN.md conformance:** the ported panel uses decorative `violet-600` (CEO) /
  `orange-500` (assistant) accents for mode distinction. DESIGN.md is dark-first,
  "color means a state, never decoration," Sodium-amber accent. **This is a known
  deviation** — needs a design pass (route through `/design-review`) before it's
  considered final.
