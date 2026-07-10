import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@valadrien-os/db";
import { badRequest } from "../errors.js";
import { agentService, companyService, costService, issueService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

// Interactive CEO/Assistant chat — a direct-Anthropic streaming surface, advisory only.
// The API key is read from the environment (ANTHROPIC_API_KEY); the runtime session
// wires it into the Vercel env. CHAT_MODEL overrides the default model.
const CHAT_MODEL = process.env.CHAT_MODEL ?? "claude-opus-4-8";
const CHAT_MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS ?? "4096");

type ChatRole = "user" | "assistant";
interface ChatMessage {
  role: ChatRole;
  content: string;
}

function getApiKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY;
  return key && key.trim().length > 0 ? key : null;
}

function centsToUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// Builds the system prompt from live Supabase rows via the services layer.
// Uses the ACTUAL schema — cost_events (cents), issues (not tasks), agents.status,
// budget_monthly_cents, reports_to hierarchy. No cost_logs / blockers / scope / slug.
async function buildCompanyContext(db: Db, companyId: string): Promise<string> {
  const companies = companyService(db);
  const agents = agentService(db);
  const costs = costService(db);
  const issues = issueService(db);

  const company = await companies.getById(companyId);
  if (!company) throw badRequest("Company not found");

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [roster, spend, totalIssues, blockedIssues, activeIssues] = await Promise.all([
    agents.list(companyId),
    costs.summary(companyId, { from: monthStart }),
    issues.count(companyId),
    issues.count(companyId, { status: "blocked" }),
    issues.count(companyId, { status: "in_progress,running" }),
  ]);

  const rosterLines = roster.length
    ? roster
        .map((a) => `  - ${a.name}${a.title ? ` (${a.title})` : ""} — role: ${a.role}, status: ${a.status}`)
        .join("\n")
    : "  (no agents)";

  const budgetLine =
    company.budgetMonthlyCents > 0
      ? `${centsToUsd(spend.spendCents)} of ${centsToUsd(company.budgetMonthlyCents)} monthly budget (${spend.utilizationPercent}% utilized)`
      : `${centsToUsd(spend.spendCents)} this month (no budget cap set)`;

  return [
    `You are the CEO assistant for the company "${company.name}" running on ValAdrien OS, a control plane for autonomous AI companies.`,
    company.description ? `Company description: ${company.description}.` : "",
    `You are advisory only: you can analyze, summarize, and recommend, but you cannot execute actions or create work.`,
    `Answer concisely and lead with the outcome. Ground every claim in the live context below; if something isn't in it, say so rather than guessing.`,
    ``,
    `## Live context (as of now)`,
    `- Status: ${company.status}`,
    `- Month-to-date spend: ${budgetLine}`,
    `- Agents (${roster.length}):`,
    rosterLines,
    `- Issues: ${totalIssues} total, ${activeIssues} active (in progress or running), ${blockedIssues} blocked`,
  ]
    .filter(Boolean)
    .join("\n");
}

function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) throw badRequest("messages must be an array");
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      out.push({ role, content });
    }
  }
  if (out.length === 0) throw badRequest("messages must contain at least one user/assistant message");
  if (out[0]!.role !== "user") throw badRequest("the first message must be from the user");
  return out;
}

export function assistantRoutes(db: Db) {
  const router = Router();

  // POST /companies/:companyId/assistant/chat — SSE stream of the assistant reply.
  router.post("/companies/:companyId/assistant/chat", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const apiKey = getApiKey();
    if (!apiKey) {
      res.status(501).json({ error: "Assistant is not configured (ANTHROPIC_API_KEY is not set on the server)." });
      return;
    }

    const messages = sanitizeMessages((req.body as { messages?: unknown })?.messages);
    const system = await buildCompanyContext(db, companyId);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream({
      model: CHAT_MODEL,
      max_tokens: CHAT_MAX_TOKENS,
      system,
      messages,
    });

    // Abort the upstream request if the client disconnects.
    req.on("close", () => stream.abort());

    stream.on("text", (delta: string) => {
      res.write(`data: ${JSON.stringify({ type: "delta", text: delta })}\n\n`);
    });

    try {
      await stream.finalMessage();
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "assistant stream failed";
      res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
    } finally {
      res.end();
    }
  });

  // POST /companies/:companyId/assistant/digest — one-shot markdown daily digest.
  router.post("/companies/:companyId/assistant/digest", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const apiKey = getApiKey();
    if (!apiKey) {
      res.status(501).json({ error: "Assistant is not configured (ANTHROPIC_API_KEY is not set on the server)." });
      return;
    }

    const system = await buildCompanyContext(db, companyId);
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream({
      model: CHAT_MODEL,
      max_tokens: CHAT_MAX_TOKENS,
      system,
      messages: [
        {
          role: "user",
          content:
            "Write today's operating digest for this company as clean Markdown. Use `##` section headings, `-` bullets, and `**bold**` for emphasis. Cover: spend vs budget, agent roster health, and issue flow (active vs blocked). Call out anything that needs a human decision. Keep it tight — no preamble, start with the first heading.",
        },
      ],
    });

    try {
      const final = await stream.finalMessage();
      const markdown = final.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      res.json({ markdown, generatedAt: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : "digest generation failed";
      res.status(502).json({ error: message });
    }
  });

  return router;
}
