import { ChatPanel } from "@/components/chat/ChatPanel";

const SUGGESTIONS = [
  "What needs my attention across the portfolio right now?",
  "Summarize the last 24h of agent activity.",
  "Which company is closest to its budget, and why?",
  "Draft a goal for this week.",
];

/**
 * Portfolio-wide advisory assistant. UI only — the streaming responses come
 * from `POST /api/chat` (assistant mode), which the server session still needs
 * to implement. Until then the panel renders and shows the endpoint's
 * not-configured message. See HANDOFF-ceo-chat-port.md.
 */
export function Assistant() {
  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col sm:h-[calc(100vh-3.5rem)]">
      <ChatPanel
        mode="assistant"
        title="Assistant"
        subtitle="Portfolio-wide · grounded in live data"
        suggestions={SUGGESTIONS}
        fillHeight
      />
    </div>
  );
}
