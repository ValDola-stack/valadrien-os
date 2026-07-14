/**
 * ValAdrien OS — Tenant Guide Popup
 * ---------------------------------
 * Self-contained modal guide for company members (tenants) on os.valadrien.dev.
 * Drop into ui/src/components/TenantGuide.tsx in the valadrien-os fork.
 *
 * Zero dependencies beyond React (icons are inline SVG so no lucide version pinning).
 * Styling is scoped via CSS custom properties — swap the --vg-* tokens for the
 * GLASSHOUSE equivalents in ONE place (see :root block in <style> below).
 *
 * Usage:
 *   const guide = useTenantGuide();                    // first-run auto-open + reopen
 *   <TenantGuide open={guide.open} onClose={guide.close} userRole="operator" />
 *   <button onClick={guide.show}>Guide</button>        // help-menu reopen
 *
 * Props:
 *   open        — controlled visibility
 *   onClose     — close handler
 *   userRole    — "owner" | "admin" | "operator" | "viewer" (badges sections; nothing is hidden)
 *   companyName — optional, personalizes the welcome section
 */

import * as React from "react";

/* ------------------------------------------------------------------ */
/* Roles                                                               */
/* ------------------------------------------------------------------ */

export type TenantRole = "owner" | "admin" | "operator" | "viewer";

const ROLE_LABELS: Record<TenantRole, string> = {
  owner: "Owner",
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

const ROLE_RANK: Record<TenantRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

/* ------------------------------------------------------------------ */
/* Inline icons (16px, stroke-based, GLASSHOUSE-friendly)               */
/* ------------------------------------------------------------------ */

/** Renders a single 15px stroke-based SVG glyph from an SVG path `d` string. */
const Icon = ({ d, ...rest }: { d: string } & React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
    <path d={d} />
  </svg>
);

const ICONS = {
  welcome: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z M12 12l8-4.5 M12 12v9 M12 12L4 7.5",
  roles: "M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8 M22 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75",
  dashboard: "M3 3h8v8H3z M13 3h8v5h-8z M13 12h8v9h-8z M3 15h8v6H3z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z",
  tasks: "M12 22a10 10 0 100-20 10 10 0 000 20z M9 12l2 2 4-4",
  decisions: "M9 12l2 2 4-4 M21 12a9 9 0 11-18 0 9 9 0 0118 0z M12 3v2 M12 19v2",
  chat: "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z",
  agents: "M12 8V4H8 M4 8h16v12H4z M2 14h2 M20 14h2 M15 13v2 M9 13v2",
  routines: "M17 2l4 4-4 4 M3 11v-1a4 4 0 014-4h14 M7 22l-4-4 4-4 M21 13v1a4 4 0 01-4 4H3",
  goals: "M12 22a10 10 0 100-20 10 10 0 000 20z M12 18a6 6 0 100-12 6 6 0 000 12z M12 14a2 2 0 100-4 2 2 0 000 4z",
  costs: "M12 1v22 M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6",
  outputs: "M16.5 9.4L7.55 4.24 M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z M3.27 6.96L12 12.01l8.73-5.05 M12 22.08V12",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16z M21 21l-4.35-4.35",
  heartbeat: "M22 12h-4l-3 9L9 3l-3 9H2 M12 2v0",
  help: "M12 22a10 10 0 100-20 10 10 0 000 20z M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3 M12 17h.01",
};

/* ------------------------------------------------------------------ */
/* Content model                                                       */
/* ------------------------------------------------------------------ */

type GuideSection = {
  id: string;
  nav: string;
  title: string;
  icon: keyof typeof ICONS;
  /** Minimum role that gets full use of this surface (badge only — never hidden). */
  minRole?: TenantRole;
  /** Shown when a surface may be disabled for a given tenant. */
  gated?: boolean;
  body: React.ReactNode;
};

/** Inline keyboard-key chip, e.g. <K>⌘K</K>. */
const K = ({ children }: { children: React.ReactNode }) => <kbd className="vg-kbd">{children}</kbd>;
/** Inline product-term chip that mirrors a real UI label, e.g. <T>Inbox</T>. */
const T = ({ children }: { children: React.ReactNode }) => <span className="vg-term">{children}</span>;
/** Callout box highlighting a practical tip within a section body. */
const Tip = ({ children }: { children: React.ReactNode }) => (
  <div className="vg-tip"><span className="vg-tip-label">Tip</span><span>{children}</span></div>
);
/** Callout box noting a surface may be disabled per tenant engagement. */
const Gate = ({ children }: { children: React.ReactNode }) => (
  <div className="vg-gate">{children}</div>
);

/**
 * Builds the ordered list of guide sections. `companyName` personalizes the
 * welcome copy. Content is static JSX by design — no CMS or i18n layer.
 */
const buildSections = (companyName?: string): GuideSection[] => [
  {
    id: "welcome",
    nav: "Welcome",
    title: `Welcome to ValAdrien OS`,
    icon: "welcome",
    body: (
      <>
        <p>
          ValAdrien OS is the control plane for {companyName ? <strong>{companyName}</strong> : "your company"}'s
          AI workforce. Your team members are AI agents — they do the work. You set direction,
          approve decisions, and watch results land.
        </p>
        <p>The mental model in one line: <em>agents execute, you govern.</em></p>
        <ul>
          <li><strong>Work</strong> lives in <T>Tasks</T> — every piece of work traces up to a company goal.</li>
          <li><strong>Anything needing you</strong> lands in your <T>Inbox</T> and <T>Decisions</T>.</li>
          <li><strong>Money</strong> is visible and capped in <T>Costs</T> — agents auto-pause before overspending.</li>
          <li><strong>Conversation</strong> with your AI team lead happens in the <T>Conference Room</T>.</li>
        </ul>
        <p className="vg-muted">
          Your instance is managed by ValAdrien.DEV — infrastructure, agent provisioning, and model
          access are handled for you. You will never be asked for an API key.
        </p>
      </>
    ),
  },
  {
    id: "roles",
    nav: "Your access",
    title: "Roles & what you can do",
    icon: "roles",
    body: (
      <>
        <p>
          Access varies per company. Your role is set by your ValAdrien.DEV engagement — if an action
          in this guide isn't visible to you, it belongs to a higher role.
        </p>
        <table className="vg-table">
          <thead><tr><th>Role</th><th>What it adds</th></tr></thead>
          <tbody>
            <tr><td><span className="vg-role">Viewer</span></td><td>View-only membership: dashboards, tasks, activity, costs, outputs.</td></tr>
            <tr><td><span className="vg-role">Operator</span></td><td>The default. Everything Viewer has, plus assigning and creating tasks, commenting, and acting on approvals routed to you.</td></tr>
            <tr><td><span className="vg-role">Admin</span></td><td>Create agents, invite users, assign tasks, approve join requests.</td></tr>
            <tr><td><span className="vg-role">Owner</span></td><td>Everything in Admin, plus managing members and budgets.</td></tr>
          </tbody>
        </table>
        <p className="vg-muted">
          Sections below carry a role badge showing the minimum role that fully uses that surface.
          Everyone can read everything — the badge is about acting, not seeing.
        </p>
      </>
    ),
  },
  {
    id: "dashboard",
    nav: "Dashboard",
    title: "Dashboard — your company at a glance",
    icon: "dashboard",
    body: (
      <>
        <p>The Dashboard answers five questions: what's running, what's stuck, what it costs, what needs your sign-off, and what just happened.</p>
        <ul>
          <li><T>Agents Enabled</T> — how many agents are running, paused, or erroring.</li>
          <li><T>Tasks In Progress</T> — open vs. blocked work.</li>
          <li><T>Month Spend</T> — percentage of your monthly budget consumed.</li>
          <li><T>Pending Approvals</T> — items awaiting board review (that's you).</li>
        </ul>
        <p>
          Charts cover the last 14 days: <T>Run Activity</T>, <T>Tasks by Priority</T>, <T>Tasks by Status</T>, and <T>Success Rate</T>.
          The <T>Live</T> view shows agent runs in real time — active runs first.
        </p>
        <p>
          A red banner reading <T>"N active budget incident(s)"</T> means an agent or project hit its
          spend limit and was auto-paused. Nothing is broken — see the <strong>Costs &amp; budgets</strong> section
          for how to resolve it.
        </p>
      </>
    ),
  },
  {
    id: "inbox",
    nav: "Inbox",
    title: "Inbox — everything that needs a human",
    icon: "inbox",
    minRole: "operator",
    body: (
      <>
        <p>
          The Inbox is your single queue. If the OS needs you, it shows up here — check it before
          anything else. Tabs: <T>mine</T>, <T>recent</T>, <T>all</T>, <T>unread</T>, and <T>blocked</T>.
        </p>
        <p>What lands here: tasks you touched, approvals, failed runs, join requests, and alerts.
          Row actions include <T>Approve</T>/<T>Reject</T>, <T>Retry</T> and <T>Dismiss</T> for failed runs,
          and <T>Mark as read</T>.</p>
        <p>The <T>blocked</T> tab explains <em>why</em> work stopped, with a reason chip on each row:</p>
        <ul className="vg-compact">
          <li><T>Needs decision</T> — an agent is waiting on a board or user decision. Highest-value place to spend your time.</li>
          <li><T>Needs attention</T> — something needs a look (e.g. an unassigned or parked blocker).</li>
          <li><T>Blocked chain stalled</T> — a dependency chain stopped moving.</li>
          <li><T>External wait</T> — waiting on something outside the OS.</li>
          <li><T>Recovery required</T> / <T>Owner paused</T> — a run needs recovery, or the owner paused work.</li>
        </ul>
        <p>Severity dots mark <T>critical</T> (red) and <T>high</T> (orange). Sort by <T>Most urgent</T> or <T>Longest stopped</T> to triage.</p>
        <Tip>A healthy company has an empty <T>blocked</T> tab. If items sit there for days, tell your ValAdrien.DEV operator — that's a process gap, not your job to absorb.</Tip>
      </>
    ),
  },
  {
    id: "tasks",
    nav: "Tasks",
    title: "Tasks — where the work lives",
    icon: "tasks",
    minRole: "operator",
    body: (
      <>
        <p>
          Every piece of work is a Task with a single assignee — an agent or a human. Tasks form a
          hierarchy: each one exists in service of a parent, all the way up to the company goal, so
          every agent can always answer "why am I doing this?".
        </p>
        <p><strong>Statuses:</strong> <T>Backlog</T> (parked — assignee won't be woken), <T>Todo</T> (executable — assignee will be woken), <T>In Progress</T>, <T>In Review</T>, <T>Blocked</T>, <T>Done</T>, <T>Cancelled</T>. <strong>Priorities:</strong> Critical / High / Medium / Low.</p>
        <p><strong>Talking to agents happens on tasks.</strong> Comment on an agent's task and the agent
          wakes to read it. Use <K>@</K> to mention a specific agent, teammate, or project. This is the
          reliable channel — a comment on the task beats a side-channel message every time.</p>
        <p><strong>Creating a task</strong> (via <T>Create</T> or <K>C</K>): title, description
          (markdown, attachments, drag-and-drop files), status, priority, assignee, optional
          reviewer/approver, and project. Submit with <K>⌘ Enter</K>. Set status <T>Todo</T> if you want
          the agent to start now; <T>Backlog</T> if you're just capturing it.</p>
        <p><strong>Outputs are attached to the task</strong> — look for work products and attachments on the
          task page. Work isn't done until you can see the result: a file, doc, link, or preview.</p>
        <Tip>Blockers ≠ sub-tasks. Sub-tasks break work down; a blocker is a dependency that stops a task until it's resolved.</Tip>
      </>
    ),
  },
  {
    id: "decisions",
    nav: "Decisions",
    title: "Decisions — your approval queue",
    icon: "decisions",
    minRole: "operator",
    body: (
      <>
        <p>
          Agents don't take consequential actions unilaterally — they file an approval and wait.
          You are the board. The <T>Pending</T> tab is the queue.
        </p>
        <p><strong>What comes up for approval:</strong> <T>Hire Agent</T> (adding a team member), <T>CEO Strategy</T> (strategic plans), <T>Board Approval</T> (anything an agent explicitly escalates), and <T>Budget Override</T> (a spend limit was hit).</p>
        <p><strong>Your options:</strong> <T>Approve</T> (the requesting agent is notified and follows up on
          linked tasks), <T>Reject</T>, or <T>Request revision</T> — the agent revises and marks it
          resubmitted. You can attach a decision note and comment on the thread before deciding.</p>
        <p className="vg-muted">One exception: <T>Budget Override</T> requests are resolved from the
          Costs page's budget controls, not from the approval itself.</p>
        <Tip>Speed matters more than perfection here. A pending approval is a paused agent. Approve-with-a-note or request a revision quickly rather than letting it sit.</Tip>
      </>
    ),
  },
  {
    id: "chat",
    nav: "Conference Room",
    title: "Conference Room — talk to your AI team lead",
    icon: "chat",
    minRole: "operator",
    body: (
      <>
        <p>
          The Conference Room is a chat with your company's CEO agent. Ask anything about your
          company — status, plans, priorities — or hand it new direction in plain language.
        </p>
        <p>
          It's not a throwaway chatbot: the conversation is persisted as comments on the company's
          board-operations task, and requests you make become real tasks with real owners. The live
          feed alongside shows what agents are doing while you talk.
        </p>
        <p>Good openers: "What's the status of everything in flight?", "What's blocked and why?",
          "Draft a plan for X and file the tasks."</p>
        <Tip>For work on a <em>specific</em> task, comment on that task instead — it wakes the actual assignee with full context.</Tip>
      </>
    ),
  },
  {
    id: "agents",
    nav: "Agents & Org",
    title: "Agents & the org chart",
    icon: "agents",
    minRole: "admin",
    body: (
      <>
        <p>
          The <T>Org</T> page shows your company as a tree — every agent with its title, role, live
          status dot, and capabilities. Roles mirror a real org: CEO, CTO, CMO, Engineer, Designer,
          PM, QA, Researcher, and so on.
        </p>
        <p><strong>Agent statuses:</strong> running, active, idle/paused, error, terminated, pending approval.</p>
        <p><strong>Actions on an agent</strong> (role-gated): <T>Assign Task</T>, <T>Run now</T>, <T>Pause</T>/<T>Resume</T>, <T>Clear error</T>, and destructive controls like <T>Terminate</T>. Each agent also carries its own monthly budget, set on its detail page.</p>
        <p className="vg-muted">
          On managed tenants, hiring, adapter configuration, and model selection are handled by
          ValAdrien.DEV. New hires proposed by your CEO agent still come to you as a <T>Hire Agent</T> approval.
        </p>
      </>
    ),
  },
  {
    id: "routines",
    nav: "Routines",
    title: "Routines — recurring work on a schedule",
    icon: "routines",
    minRole: "operator",
    body: (
      <>
        <p>
          A Routine is recurring work that materializes into a tracked task on a schedule — a daily
          digest, a weekly report, an hourly monitor. Each run creates an auditable task and wakes
          the responsible agent, so scheduled work has the same paper trail as everything else.
        </p>
        <p><strong>Schedules:</strong> every minute / hour / day, weekdays, weekly, monthly, or custom cron. <strong>Controls:</strong> <T>Run now</T> to fire immediately, a pause/enable toggle, and <T>Recent Runs</T> to audit what each firing produced.</p>
        <p className="vg-muted">Advanced delivery settings (what happens if a run is due while the previous one is still active, and whether missed runs are caught up) are usually configured by your operator.</p>
      </>
    ),
  },
  {
    id: "goals",
    nav: "Goals & Projects",
    title: "Goals & Projects — why the work exists",
    icon: "goals",
    minRole: "operator",
    body: (
      <>
        <p>
          <T>Goals</T> are the top of the hierarchy — the reason the company exists, broken into
          sub-goals. <T>Projects</T> group related tasks and link to goals. Tasks belong to projects.
          The chain is: <em>goal → project → task → sub-task</em>.
        </p>
        <p>
          This is what keeps an autonomous workforce aligned: if a task can't be traced to a goal,
          it shouldn't exist. Review the goal tree occasionally — it's the strategy document your
          agents actually execute against.
        </p>
      </>
    ),
  },
  {
    id: "costs",
    nav: "Costs & budgets",
    title: "Costs & budgets — spend, capped",
    icon: "costs",
    minRole: "operator",
    body: (
      <>
        <p>
          The <T>Costs</T> page tracks inference spend across the company, per agent, per project,
          and per provider, with date ranges and a monthly budget bar (it recolors past 70% and 90%
          utilization).
        </p>
        <p><strong>Budget policies</strong> exist at three scopes: company-wide monthly, per-agent monthly, and per-project lifetime. These are hard-stop limits, not suggestions.</p>
        <p><strong>What happens on overspend:</strong> crossing a limit opens a <T>budget incident</T> and
          auto-pauses the offending scope — the agent stops waking, or the project stops executing.
          A <T>Budget Override</T> approval is filed for the board. You resolve the incident from the
          Budgets tab: <T>Keep paused</T>, or raise the budget and resume.</p>
        <Tip>An auto-pause is the system working, not failing. It exists so you never discover a surprise bill. If pauses happen weekly, the budget is mis-sized — raise that with your operator once, rather than overriding every time.</Tip>
      </>
    ),
  },
  {
    id: "outputs",
    nav: "Outputs & Skills",
    title: "Artifacts, Skills & Pipelines",
    icon: "outputs",
    minRole: "operator",
    gated: true,
    body: (
      <>
        <p><strong><T>Artifacts</T></strong> collects every output attached to tasks — images, videos,
          documents, text, files — searchable and grouped by task. When you want to see what your
          company has actually produced, start here.</p>
        <p><strong><T>Skills</T></strong> are reusable capabilities agents load at runtime (playbooks,
          workflows, format guides). The Skills page shows what's installed for your company; on
          managed tenants, ValAdrien.DEV curates these.</p>
        <p><strong><T>Pipelines</T></strong> (where enabled) are boards of items moving through named stages
          toward finished work — batch content production, lead qualification, review flows. Cards
          flag <T>Working</T>, <T>Needs attention</T>, and <T>This changed</T>.</p>
        <Gate>Some of these surfaces are enabled per tenant. If you don't see one in your sidebar, it isn't part of your current engagement — ask ValAdrien.DEV if you want it turned on.</Gate>
      </>
    ),
  },
  {
    id: "activity",
    nav: "Activity & audit",
    title: "Activity, Timeline & the audit trail",
    icon: "activity",
    body: (
      <>
        <p>
          Everything agents do is logged. <T>Activity</T> is the reverse-chronological feed of company
          events, filterable by type. <T>Timeline</T> is the same truth as a Gantt-style view — per-actor
          rows over a date range, with run durations and cost.
        </p>
        <p>
          Every mutation is traced to an actor, every run has structured logs, and task pages keep
          the full trail of comments, status changes, and outputs. If you ever wonder "who did this
          and why" — the answer is recorded.
        </p>
      </>
    ),
  },
  {
    id: "search",
    nav: "Search & shortcuts",
    title: "Search, shortcuts & mobile",
    icon: "search",
    body: (
      <>
        <p>
          <K>⌘ K</K> (or <K>Ctrl K</K>) opens the command palette from anywhere: jump to pages, find
          tasks/agents/projects, or run quick actions — <T>Create new task</T> is <K>C</K>.
        </p>
        <p><strong>Search operators:</strong> <T>status:</T>, <T>assignee:me</T>, <T>priority:</T>, <T>project:"…"</T>, <T>label:</T>, <T>updated:&gt;7d</T>, <T>is:open</T>.</p>
        <p><strong>On your phone</strong>, the bottom nav gives you the essentials: Home, Tasks, Create,
          Agents, and Inbox (with an unread badge). Reviewing approvals from a phone is a perfectly
          good workflow.</p>
      </>
    ),
  },
  {
    id: "heartbeat",
    nav: "How agents work",
    title: "How agents actually run (why replies aren't instant)",
    icon: "heartbeat",
    body: (
      <>
        <p>
          Agents don't run continuously. The OS <em>wakes</em> an agent when there's a reason to:
          a new comment or <K>@</K>mention on its task, a resolved blocker, a scheduled routine
          firing, an approval decision, or recovery after a crash. Between wakes, an agent is idle —
          not stuck.
        </p>
        <p>
          So when an agent hasn't replied within seconds, that's normal. If a task genuinely has no
          live run, no queued wake, and nothing it's waiting on, the OS surfaces it as <T>blocked</T> in
          your Inbox instead of letting it silently rot.
        </p>
        <p>
          This design is also your cost guarantee: work is atomic (no two agents grab the same task,
          no runaway duplicate spend), and every wake passes a budget check first.
        </p>
      </>
    ),
  },
  {
    id: "help",
    nav: "Getting help",
    title: "Getting help",
    icon: "help",
    body: (
      <>
        <p>Rules of thumb for where to go:</p>
        <ul>
          <li><strong>About a specific piece of work</strong> → comment on the task.</li>
          <li><strong>About direction or status</strong> → the Conference Room.</li>
          <li><strong>Something looks stuck</strong> → Inbox, <T>blocked</T> tab, read the reason chip.</li>
          <li><strong>Spend question</strong> → Costs page before anything else.</li>
          <li><strong>Platform issue, access change, or anything this guide doesn't answer</strong> → your
            ValAdrien.DEV operator (<a href="mailto:support@valadrien.dev">support@valadrien.dev</a>).</li>
        </ul>
        <p className="vg-muted">Reopen this guide anytime from the Help menu.</p>
      </>
    ),
  },
];

/* ------------------------------------------------------------------ */
/* First-run hook                                                      */
/* ------------------------------------------------------------------ */

const SEEN_KEY = "valadrienOs.tenantGuide.seen.v1";

/**
 * First-run state for the guide. Auto-opens once per browser (tracked in
 * localStorage under {@link SEEN_KEY}); returns `open`, `close` (persists the
 * seen flag), and `show` (manual reopen from the account menu).
 */
export function useTenantGuide(autoOpenFirstRun = true) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!autoOpenFirstRun) return;
    try {
      if (!window.localStorage.getItem(SEEN_KEY)) setOpen(true);
    } catch { /* storage unavailable — skip auto-open */ }
  }, [autoOpenFirstRun]);
  const close = React.useCallback(() => {
    setOpen(false);
    try { window.localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* noop */ }
  }, []);
  const show = React.useCallback(() => setOpen(true), []);
  return { open, close, show };
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export interface TenantGuideProps {
  open: boolean;
  onClose: () => void;
  userRole?: TenantRole;
  companyName?: string;
}

/**
 * The tenant guide modal. Controlled via `open`/`onClose`. `userRole` badges
 * role-gated sections (never hides them) and `companyName` personalizes the
 * welcome section. Supports keyboard nav (Esc to close, ←/→ between sections).
 */
export function TenantGuide({ open, onClose, userRole, companyName }: TenantGuideProps) {
  const sections = React.useMemo(() => buildSections(companyName), [companyName]);
  const [activeId, setActiveId] = React.useState(sections[0].id);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const dialogRef = React.useRef<HTMLDivElement>(null);

  const idx = sections.findIndex((s) => s.id === activeId);
  const active = sections[idx] ?? sections[0];

  const go = (id: string) => {
    setActiveId(id);
    // scrollTo is optional-chained: not all environments (jsdom, older engines) implement it.
    bodyRef.current?.scrollTo?.({ top: 0 });
  };

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && idx < sections.length - 1) go(sections[idx + 1].id);
      if (e.key === "ArrowLeft" && idx > 0) go(sections[idx - 1].id);
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, idx, sections, onClose]);

  if (!open) return null;

  return (
    <div className="vg-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <style>{CSS_TEXT}</style>
      <div
        className="vg-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="ValAdrien OS guide"
        tabIndex={-1}
        ref={dialogRef}
      >
        {/* Header */}
        <div className="vg-header">
          <div className="vg-brand">
            <span className="vg-brand-mark" aria-hidden="true" />
            <div>
              <div className="vg-brand-title">ValAdrien OS — Guide</div>
              <div className="vg-brand-sub">
                How to run your AI-operated company
                {userRole ? <> · signed in as <span className="vg-role">{ROLE_LABELS[userRole]}</span></> : null}
              </div>
            </div>
          </div>
          <button className="vg-close" onClick={onClose} aria-label="Close guide">✕</button>
        </div>

        <div className="vg-main">
          {/* Section nav */}
          <nav className="vg-nav" aria-label="Guide sections">
            {sections.map((s, i) => (
              <button
                key={s.id}
                className={`vg-nav-item${s.id === activeId ? " vg-nav-active" : ""}`}
                onClick={() => go(s.id)}
                aria-current={s.id === activeId ? "true" : undefined}
              >
                <span className="vg-nav-icon"><Icon d={ICONS[s.icon]} /></span>
                <span className="vg-nav-label">{s.nav}</span>
                <span className="vg-nav-num">{String(i + 1).padStart(2, "0")}</span>
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="vg-body" ref={bodyRef}>
            <div className="vg-section-head">
              <h2>{active.title}</h2>
              <div className="vg-badges">
                {active.minRole && (
                  <span
                    className={`vg-badge${userRole && ROLE_RANK[userRole] < ROLE_RANK[active.minRole] ? " vg-badge-dim" : ""}`}
                    title={`Acting on this surface is available from the ${ROLE_LABELS[active.minRole]} role up`}
                  >
                    {ROLE_LABELS[active.minRole]}+
                  </span>
                )}
                {active.gated && <span className="vg-badge vg-badge-gate">Per-tenant</span>}
              </div>
            </div>
            <div className="vg-prose">{active.body}</div>
          </div>
        </div>

        {/* Footer */}
        <div className="vg-footer">
          <div className="vg-progress" aria-hidden="true">
            {sections.map((s) => (
              <span key={s.id} className={`vg-dot${s.id === activeId ? " vg-dot-active" : ""}`} onClick={() => go(s.id)} />
            ))}
          </div>
          <div className="vg-footer-actions">
            <button className="vg-btn" disabled={idx === 0} onClick={() => go(sections[idx - 1].id)}>← Back</button>
            {idx < sections.length - 1 ? (
              <button className="vg-btn vg-btn-primary" onClick={() => go(sections[idx + 1].id)}>Next →</button>
            ) : (
              <button className="vg-btn vg-btn-primary" onClick={onClose}>Done</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default TenantGuide;

/* ------------------------------------------------------------------ */
/* Styles — GLASSHOUSE token swap points are the --vg-* variables.     */
/* Replace the fallback values with your GLASSHOUSE design tokens.     */
/* ------------------------------------------------------------------ */

const CSS_TEXT = `
.vg-overlay {
  /* GLASSHOUSE token map — prefers the repo's shadcn theme vars (ui/src/index.css),
     falls back to the dark-theme OKLCH-equivalent hex if a var is ever unset.
     Accent = --primary (Sodium amber), NOT teal: in GLASSHOUSE teal is the
     running-state color and "color = state, never decoration". */
  --vg-bg: var(--background, #0a0b0d);          /* canvas */
  --vg-panel: var(--card, #101216);             /* surface */
  --vg-panel-strong: var(--secondary, #16191e); /* raised */
  --vg-border: var(--border, #1e2228);          /* hairline */
  --vg-text: var(--foreground, #e8e6e1);        /* warm bone */
  --vg-text-muted: var(--muted-foreground, #9a9893);
  --vg-accent: var(--primary, #f0a23c);         /* Sodium amber, rationed */
  --vg-accent-ink: var(--primary-foreground, #1a1206);
  /* GLASSHOUSE: containers square, interactive controls 2px, never bubbly. */
  --vg-radius: var(--radius, 0px);
  --vg-radius-control: 2px;
  --vg-font: var(--font-sans, "Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, sans-serif);
  --vg-font-serif: var(--font-serif, "Newsreader", ui-serif, Georgia, serif);
  --vg-font-mono: var(--font-mono, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace);

  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(4, 6, 10, 0.62);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  font-family: var(--vg-font); color: var(--vg-text);
}
.vg-dialog {
  width: min(940px, calc(100vw - 32px));
  height: min(640px, calc(100vh - 48px));
  display: flex; flex-direction: column;
  background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015)), var(--vg-bg);
  border: 1px solid var(--vg-border);
  border-radius: var(--vg-radius);
  box-shadow: 0 24px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);
  overflow: hidden; outline: none;
}
.vg-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; border-bottom: 1px solid var(--vg-border);
  background: var(--vg-panel);
}
.vg-brand { display: flex; align-items: center; gap: 12px; }
.vg-brand-mark {
  width: 30px; height: 30px; border-radius: var(--vg-radius-control); flex: none;
  background: linear-gradient(135deg, var(--vg-accent), rgba(255,255,255,0.25));
  box-shadow: 0 0 18px color-mix(in srgb, var(--vg-accent) 35%, transparent);
}
.vg-brand-title { font-family: var(--vg-font-serif); font-size: 15px; font-weight: 500; letter-spacing: 0.01em; }
.vg-brand-sub { font-size: 12px; color: var(--vg-text-muted); margin-top: 1px; }
.vg-close {
  background: transparent; color: var(--vg-text-muted); border: 1px solid var(--vg-border);
  border-radius: var(--vg-radius-control); width: 30px; height: 30px; cursor: pointer; font-size: 13px;
}
.vg-close:hover { color: var(--vg-text); background: var(--vg-panel-strong); }

.vg-main { flex: 1; display: flex; min-height: 0; }
.vg-nav {
  width: 210px; flex: none; overflow-y: auto; padding: 10px;
  border-right: 1px solid var(--vg-border); background: rgba(0,0,0,0.18);
}
.vg-nav-item {
  display: flex; align-items: center; gap: 9px; width: 100%;
  padding: 8px 10px; margin-bottom: 2px; border: 1px solid transparent; border-radius: var(--vg-radius-control);
  background: transparent; color: var(--vg-text-muted); font-size: 12.5px; font-family: inherit;
  cursor: pointer; text-align: left;
}
.vg-nav-item:hover { color: var(--vg-text); background: var(--vg-panel); }
.vg-nav-active, .vg-nav-active:hover {
  color: var(--vg-text); background: var(--vg-panel-strong); border-color: var(--vg-border);
}
.vg-nav-icon { display: inline-flex; color: var(--vg-accent); flex: none; }
.vg-nav-label { flex: 1; }
.vg-nav-num { font-size: 10px; opacity: 0.45; font-variant-numeric: tabular-nums; }

.vg-body { flex: 1; overflow-y: auto; padding: 26px 30px 34px; min-width: 0; }
.vg-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.vg-section-head h2 { font-family: var(--vg-font-serif); font-size: 20px; font-weight: 500; margin: 0; letter-spacing: -0.01em; }
.vg-badges { display: flex; gap: 6px; flex: none; padding-top: 3px; }
.vg-badge {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em;
  padding: 3px 8px; border-radius: var(--vg-radius-control);
  background: color-mix(in srgb, var(--vg-accent) 18%, transparent);
  color: var(--vg-accent); border: 1px solid color-mix(in srgb, var(--vg-accent) 35%, transparent);
  white-space: nowrap;
}
.vg-badge-dim { opacity: 0.55; }
.vg-badge-gate { background: rgba(255,255,255,0.06); color: var(--vg-text-muted); border-color: var(--vg-border); }

.vg-prose { font-size: 13.5px; line-height: 1.65; color: var(--vg-text); }
.vg-prose p { margin: 10px 0; }
.vg-prose ul { margin: 8px 0 12px; padding-left: 20px; }
.vg-prose li { margin: 5px 0; }
.vg-prose ul.vg-compact li { margin: 3px 0; }
.vg-prose a { color: var(--vg-accent); }
.vg-prose strong { font-weight: 650; }
.vg-muted { color: var(--vg-text-muted); font-size: 12.5px; }
.vg-term {
  font-weight: 600; color: var(--vg-text);
  background: var(--vg-panel-strong); border: 1px solid var(--vg-border);
  padding: 0 5px; border-radius: var(--vg-radius-control); font-size: 12.5px; white-space: nowrap;
}
.vg-kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  background: var(--vg-panel-strong); border: 1px solid var(--vg-border);
  border-bottom-width: 2px; border-radius: var(--vg-radius-control); padding: 1px 6px;
}
.vg-role {
  font-weight: 650; font-size: 12px; color: var(--vg-accent);
}
.vg-tip {
  display: flex; gap: 10px; align-items: baseline;
  margin: 14px 0 4px; padding: 10px 13px;
  background: color-mix(in srgb, var(--vg-accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--vg-accent) 22%, transparent);
  border-radius: var(--vg-radius-control); font-size: 12.5px;
}
.vg-tip-label {
  font-family: var(--vg-font-mono);
  font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--vg-accent); flex: none;
}
.vg-gate {
  margin: 14px 0 4px; padding: 10px 13px; font-size: 12.5px; color: var(--vg-text-muted);
  background: var(--vg-panel); border: 1px dashed var(--vg-border); border-radius: var(--vg-radius-control);
}
.vg-table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 12.5px; }
.vg-table th, .vg-table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--vg-border); }
.vg-table th { font-family: var(--vg-font-mono); color: var(--vg-text-muted); font-weight: 500; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; }

.vg-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px; border-top: 1px solid var(--vg-border); background: var(--vg-panel);
}
.vg-progress { display: flex; gap: 5px; }
.vg-dot {
  width: 6px; height: 6px; border-radius: 999px; background: var(--vg-border); cursor: pointer;
  transition: background 120ms;
}
.vg-dot-active { background: var(--vg-accent); }
.vg-footer-actions { display: flex; gap: 8px; }
.vg-btn {
  font-family: inherit; font-size: 12.5px; font-weight: 600;
  padding: 7px 14px; border-radius: var(--vg-radius-control); cursor: pointer;
  background: transparent; color: var(--vg-text); border: 1px solid var(--vg-border);
}
.vg-btn:hover:not(:disabled) { background: var(--vg-panel-strong); }
.vg-btn:disabled { opacity: 0.35; cursor: default; }
.vg-btn-primary {
  background: var(--vg-accent); color: var(--vg-accent-ink); border-color: transparent;
}
.vg-btn-primary:hover { filter: brightness(1.08); background: var(--vg-accent); }

@media (max-width: 720px) {
  .vg-dialog { width: calc(100vw - 16px); height: calc(100vh - 24px); }
  .vg-main { flex-direction: column; }
  .vg-nav {
    width: 100%; display: flex; overflow-x: auto; overflow-y: hidden;
    border-right: none; border-bottom: 1px solid var(--vg-border); padding: 8px;
  }
  .vg-nav-item { width: auto; flex: none; }
  .vg-nav-num { display: none; }
  .vg-body { padding: 18px 16px 26px; }
  .vg-progress { display: none; }
}
`;
