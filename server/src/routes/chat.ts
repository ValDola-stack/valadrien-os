import { Router } from "express";
import type { Db } from "@valadrien-os/db";
import { companyService, agentService } from "../services/index.js";
import { dashboardService } from "../services/dashboard.js";
import { assertBoard } from "./authz.js";
import { badRequest } from "../errors.js";

/**
 * Advisory chat endpoint — grounds a Claude model in live portfolio / company
 * data and streams the reply back as plain text. Board (operator) only,
 * read-only/advisory. Consumed by the UI `ChatPanel` (ui/src/components/chat).
 *
 * Ported from the archived management-os dashboard (commit 69533a0). The data
 * grounding was remapped from that repo's Supabase tables to valadrien-os's own
 * services (companies / agents / dashboard summary). See HANDOFF-ceo-chat-port.md.
 *
 * Uses a raw HTTPS call to the Anthropic Messages API (Node's global fetch)
 * rather than the SDK, to avoid adding @anthropic-ai/sdk to the shared server
 * lockfile for a single v1 endpoint. Swap to the SDK if the surface grows.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Default per the claude-api guidance; operator can override via env.
const DEFAULT_MODEL = process.env.CHAT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS || 1500);

type Role = "user" | "assistant";
type ChatMessage = { role: Role; content: string };
type ChatMode = "assistant" | "ceo";

function usd(cents: unknown): string {
  const v = typeof cents === "number" && Number.isFinite(cents) ? cents : Number(cents) || 0;
  return `$${(v / 100).toFixed(2)}`;
}

const BASE_SYSTEM =
  "You are part of ValAdrien OS, the control plane the operator uses to run a portfolio of agent-operated companies. " +
  "Be direct and evidence-first. No fluff, no validation-seeking. Lead with the answer, then the reasoning. " +
  "When you reference numbers, use the live context provided below — do not invent figures. " +
  "Format with short markdown: headings, bold, and tight bullet lists. Keep responses scannable. " +
  "You advise; you do not execute changes.";

/** Resolve a company by id, or fall back to a name/id match over the list. */
async function resolveCompany(db: Db, key: string) {
  const companies = companyService(db);
  try {
    const byId = await companies.getById(key);
    if (byId) return byId;
  } catch {
    // key wasn't a valid id — fall through to a name scan
  }
  const all = await companies.list();
  const needle = key.trim().toLowerCase();
  return (
    all.find(
      (c: { id: string; name?: string | null }) =>
        c.id === key || (c.name ?? "").toLowerCase() === needle,
    ) ?? null
  );
}

/** Build a compact, grounded system prompt for the requested mode. */
async function buildSystem(db: Db, mode: ChatMode, companyKey?: string): Promise<string> {
  if (mode === "ceo" && companyKey) {
    const company = await resolveCompany(db, companyKey);
    if (!company) {
      return (
        BASE_SYSTEM +
        `\n\nYou are acting as the CEO of company "${companyKey}", but no matching record was found. ` +
        "Answer cautiously and flag the missing data."
      );
    }

    const [summary, agents] = await Promise.all([
      dashboardService(db)
        .summary(company.id)
        .catch(() => null),
      agentService(db)
        .list(company.id)
        .catch(() => [] as Array<{ name: string; role?: string | null; status?: string | null }>),
    ]);

    const agentLines =
      agents.length > 0
        ? agents
            .map((a) => `  - ${a.name}${a.role ? ` (${a.role})` : ""}${a.status ? ` — ${a.status}` : ""}`)
            .join("\n")
        : "  (none)";

    let live = "";
    if (summary) {
      const { costs, tasks, agents: agentCounts, pendingApprovals } = summary;
      const budget = costs.monthBudgetCents;
      live =
        `\n\nLIVE CONTEXT for ${company.name ?? company.id}:\n` +
        `- Month spend: ${usd(costs.monthSpendCents)}` +
        (budget > 0
          ? ` of ${usd(budget)} budget (${costs.monthUtilizationPercent}%)`
          : " (no budget set)") +
        "\n" +
        `- Agents: ${agentCounts.active} active, ${agentCounts.running} running, ${agentCounts.paused} paused, ${agentCounts.error} error\n` +
        `- Tasks: ${tasks.open} open, ${tasks.inProgress} in progress, ${tasks.blocked} blocked, ${tasks.done} done\n` +
        `- Pending approvals awaiting the board: ${pendingApprovals}\n` +
        `- Team (${agents.length}):\n${agentLines}`;
    } else {
      live = `\n\nLIVE CONTEXT for ${company.name ?? company.id}:\n- Team (${agents.length}):\n${agentLines}`;
    }

    return (
      BASE_SYSTEM +
      `\n\nYOUR ROLE: You are the accountable CEO of "${company.name ?? company.id}". ` +
      "Speak as the leader responsible for this company's outcomes, budget, and agent team. " +
      "You can reason about strategy, prioritize work, explain blockers, and recommend next actions." +
      live
    );
  }

  // assistant (portfolio-wide)
  const companies = await companyService(db)
    .list()
    .catch(() => [] as Array<{ id: string; name?: string | null; budgetMonthlyCents?: number; spentMonthlyCents?: number }>);

  const spend = companies.reduce((a, c) => a + Number(c.spentMonthlyCents ?? 0), 0);
  const budget = companies.reduce((a, c) => a + Number(c.budgetMonthlyCents ?? 0), 0);
  const companyLines =
    companies.length > 0
      ? companies
          .map(
            (c) =>
              `  - ${c.name ?? c.id}: ${usd(c.spentMonthlyCents)}` +
              (Number(c.budgetMonthlyCents ?? 0) > 0 ? ` / ${usd(c.budgetMonthlyCents)}` : ""),
          )
          .join("\n")
      : "  (none)";

  return (
    BASE_SYSTEM +
    "\n\nYOUR ROLE: You are the operator's portfolio assistant. Help triage work, summarize agent " +
    "activity, reason about spend and blockers, and surface what needs attention.\n\n" +
    "LIVE PORTFOLIO CONTEXT:\n" +
    `- Companies (${companies.length}) — month spend / budget:\n${companyLines}\n` +
    `- Portfolio month-to-date spend: ${usd(spend)}` +
    (budget > 0 ? ` of ${usd(budget)} total budget` : "")
  );
}

export function chatRoutes(db: Db) {
  const router = Router();

  router.post("/chat", async (req, res) => {
    assertBoard(req); // operator-only; throws 403 before any streaming headers

    const body = req.body as { mode?: ChatMode; companySlug?: string; messages?: ChatMessage[] };
    const mode: ChatMode = body?.mode === "ceo" ? "ceo" : "assistant";
    const incoming = (body?.messages ?? [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

    if (incoming.length === 0) throw badRequest("No messages");

    // Plain-text stream: the UI reads res.body as a text reader, not SSE.
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.end(
        "**Chat is not configured yet.**\n\nSet `ANTHROPIC_API_KEY` in the server environment " +
          "(and optionally `CHAT_MODEL` / `CHAT_MAX_TOKENS`), then redeploy. The UI is wired and ready.",
      );
      return;
    }

    const system = await buildSystem(db, mode, body?.companySlug);

    let upstream: Response;
    try {
      upstream = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: incoming,
          stream: true,
        }),
      });
    } catch (err) {
      res.end(`**Connection error.** Could not reach the model API: ${(err as Error).message}`);
      return;
    }

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      res.end(
        `**Model API error (${upstream.status}).** ${detail.slice(0, 400) || "No detail returned."}`,
      );
      return;
    }

    res.flushHeaders();

    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload) as {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            if (
              evt.type === "content_block_delta" &&
              evt.delta?.type === "text_delta" &&
              evt.delta.text
            ) {
              res.write(evt.delta.text);
            }
          } catch {
            // ignore keep-alive / non-JSON lines
          }
        }
      }
    } catch (err) {
      res.write(`\n\n_(stream interrupted: ${(err as Error).message})_`);
    } finally {
      res.end();
    }
  });

  return router;
}
