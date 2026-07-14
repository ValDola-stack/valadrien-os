import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ArrowUp, Building2, Sparkles, Square, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";

export type ChatMode = "assistant" | "ceo";

type Msg = { id: string; role: "user" | "assistant"; content: string };

export interface ChatPanelProps {
  mode: ChatMode;
  title: string;
  subtitle?: string;
  companySlug?: string;
  companyName?: string;
  suggestions?: string[];
  /** Fill the parent's height (flex column). Use for a full-page or sheet host. */
  fillHeight?: boolean;
  /** When provided, renders a close (X) button in the header. */
  onClose?: () => void;
  className?: string;
}

let idSeq = 0;
const newId = () => `m${idSeq++}-${performance.now().toString(36)}`;

/**
 * Advisory chat surface, ported from the management-os dashboard. Streams from
 * a `POST /api/chat` endpoint (server-side; see HANDOFF-ceo-chat-port.md) that
 * grounds the model in live portfolio/company data. Read-only / advisory — it
 * never executes changes. Renders assistant output through the repo's
 * `MarkdownBody` (not a bespoke renderer).
 */
export function ChatPanel({
  mode,
  title,
  subtitle,
  companySlug,
  companyName,
  suggestions = [],
  fillHeight,
  onClose,
  className,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy) return;

      const userMsg: Msg = { id: newId(), role: "user", content };
      const assistantMsg: Msg = { id: newId(), role: "assistant", content: "" };
      const history = [...messages, userMsg];
      setMessages([...history, assistantMsg]);
      setInput("");
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            mode,
            companySlug,
            messages: history.map((m) => ({ role: m.role, content: m.content })),
          }),
        });

        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => "");
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, content: errText || `Request failed (${res.status}).` }
                : m,
            ),
          );
          return;
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let acc = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += dec.decode(value, { stream: true });
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: acc } : m)),
          );
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, content: m.content || `Error: ${(err as Error).message}` }
                : m,
            ),
          );
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
        taRef.current?.focus();
      }
    },
    [busy, messages, mode, companySlug],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setBusy(false);
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const ModeIcon = mode === "ceo" ? Building2 : Sparkles;

  return (
    <div
      className={cn(
        "flex flex-col bg-background",
        fillHeight ? "h-full min-h-0" : "h-[460px]",
        className,
      )}
    >
      {/* header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span
          className={cn(
            "grid h-6 w-6 place-items-center rounded-md text-white",
            mode === "ceo" ? "bg-violet-600" : "bg-orange-500",
          )}
        >
          <ModeIcon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold tracking-tight">{title}</div>
          {subtitle && <div className="truncate text-[11px] text-muted-foreground">{subtitle}</div>}
        </div>
        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            aria-label="Clear conversation"
            title="Clear conversation"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <span
              className={cn(
                "grid h-10 w-10 place-items-center rounded-lg text-white",
                mode === "ceo" ? "bg-violet-600" : "bg-orange-500",
              )}
            >
              <ModeIcon className="h-5 w-5" />
            </span>
            <div className="max-w-xs text-[12px] text-muted-foreground">
              {mode === "ceo"
                ? `Ask ${companyName ?? "this company"}'s CEO about strategy, priorities, blockers, or spend. Grounded in live data.`
                : "Ask about anything across your portfolio — triage work, summarize activity, draft an issue, reason about spend."}
            </div>
            {suggestions.length > 0 && (
              <div className="flex w-full max-w-sm flex-col gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-md border border-border bg-card px-3 py-2 text-left text-[12px] text-foreground/80 transition-colors hover:bg-accent/40 hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-[13px] leading-relaxed text-primary-foreground">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex justify-start">
                  <div className="max-w-[92%] rounded-lg border border-border bg-card px-3 py-2">
                    {m.content ? (
                      <MarkdownBody
                        className="text-[13px] leading-relaxed"
                        softBreaks
                        linkIssueReferences={false}
                      >
                        {m.content}
                      </MarkdownBody>
                    ) : (
                      <span className="inline-flex gap-1 py-1" aria-label="Thinking">
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.2s]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.1s]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/50" />
                      </span>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </div>

      {/* composer */}
      <div className="border-t border-border p-2.5">
        <div className="flex items-end gap-2 rounded-lg border border-input bg-background p-1.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={mode === "ceo" ? "Message the CEO…" : "Message the assistant…"}
            className="max-h-40 flex-1 resize-none bg-transparent px-1.5 py-1 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground"
          />
          {busy ? (
            <button
              onClick={stop}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted text-foreground hover:bg-accent"
              aria-label="Stop"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              onClick={() => send(input)}
              disabled={!input.trim()}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-80 disabled:opacity-30"
              aria-label="Send"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="mt-1 px-1 text-[10px] text-muted-foreground/60">
          Enter to send · Shift+Enter for newline · advisory only
        </div>
      </div>
    </div>
  );
}
