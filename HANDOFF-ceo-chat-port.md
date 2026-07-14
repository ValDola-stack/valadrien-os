# HANDOFF — Advisory Chat (CEO / Portfolio Assistant) port

**Status:** UI landed (this branch, local only — not pushed). Server endpoint NOT built — needs the server/runtime session.
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

## What landed (UI only — in-lane)

- `ui/src/components/chat/ChatPanel.tsx` — the chat surface. Streams from
  `POST /api/chat`, renders assistant output via the repo's `MarkdownBody`.
  Supports both `mode="assistant"` and `mode="ceo"`. Advisory only.
- `ui/src/pages/Assistant.tsx` — portfolio-wide assistant page (`mode="assistant"`).
- `ui/src/App.tsx` — added `<Route path="assistant" element={<Assistant />} />`.

`pnpm -C ui typecheck` passes. No dev-server run (repo rule: Vite dev crashes this laptop).

---

## What the SERVER session must build (out of my UI lane)

### 1. `POST /api/chat` on the Express server (`server/src`)
valadrien-os has **no per-route file model** — `/api/*` is the Express app booted by
`api/index.mjs → server/dist/index.js`. Add the route there, not as a standalone file.

**Request contract the UI already sends:**
```jsonc
{ "mode": "assistant" | "ceo",
  "companySlug": "optional-string",   // present in ceo mode
  "messages": [ { "role": "user" | "assistant", "content": "…" } ] }
```
**Response contract the UI expects:** a streamed **`text/plain`** body of raw text
chunks (NOT SSE) — `ChatPanel` reads `res.body.getReader()` and appends decoded text
verbatim. Non-2xx: return a short text error (rendered as the assistant reply).

**Model call:** Anthropic Messages API, `stream: true`, forward `content_block_delta`
text deltas to the response stream. Reference implementation to translate:
`git show 69533a0:dashboard/src/app/api/chat/route.ts` (from the bundle above).

**Env:** `ANTHROPIC_API_KEY` (required), `CHAT_MODEL` (default in source was
`claude-sonnet-4-6`), `CHAT_MAX_TOKENS` (default 1500). Confirm current model id.

### 2. Data grounding must be REMAPPED — do not copy the source queries
The source built its system prompt from Supabase tables queried directly:
`companies`, `agents`, `tasks`, `cost_logs`, `blockers`. **Those are the management-os
schema, not valadrien-os.** Here that data lives behind the server/db layer
(`packages/db`, surfaced by the `Costs`, `Approvals`, `Issues`, `Goals`, `Agents`
pages). Re-derive the grounded context (month spend, open blockers/approvals, agents,
recent tasks/issues) from valadrien-os's own services/schema. `cost_logs`/`blockers`
only appear here in onboarding docs + tests — treat the source query names as intent,
not literal.

### 3. Auth
Source gated on an allowlisted `user.email`. Reuse valadrien-os's existing request
auth / access gate for `/api/chat`.

---

## Follow-ups (optional, not blocking)

- **CEO-mode wiring:** `ChatPanel` already supports `mode="ceo"` + `companySlug`.
  Add a collapsible CEO-chat entry to a company detail page when desired.
- **DESIGN.md conformance:** the ported panel uses decorative `violet-600` (CEO) /
  `orange-500` (assistant) accents for mode distinction. DESIGN.md is dark-first,
  "color means a state, never decoration," Sodium-amber accent. **This is a known
  deviation** — needs a design pass (route through `/design-review`) before it's
  considered final.
