import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  MoreHorizontal,
  Plus,
  Sun,
  Moon,
  Menu,
  ArrowUp,
  X,
  ExternalLink,
  MessageSquareText,
  UsersRound,
  History,
  Plug,
  CalendarDays,
  Bookmark,
  ChartNoAxesCombined,
  Settings2,
  CircleDashed,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Label } from "./components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./components/ui/dropdown-menu";
import { Switch } from "./components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./components/ui/table";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "./components/ai-elements/conversation";
import { Marketing } from "./Marketing";

type Page =
  | "Home"
  | "Chat"
  | "Agents"
  | "Activity"
  | "Connections"
  | "Settings"
  | "Deadlines"
  | "Saved preferences"
  | "Market watch";
type Agent = {
  id: string;
  name: string;
  role: string;
  description: string;
  status: "Ready" | "Retired";
  duties: string;
  language: string;
  access: Record<string, string>;
  schedule: boolean;
  avatar?: string;
};
const initialAgents: Agent[] = [
  {
    id: "saga",
    name: "Saga",
    role: "Chief of staff",
    description: "The working day, taken care of.",
    status: "Ready",
    duties:
      "Keep an eye on my inbox, calendar and deadlines. Bring me what needs a decision. Prepare drafts and ask before sending.",
    language: "English",
    access: {
      "Read email": "Allow",
      "Send email": "Ask first",
      "Read calendar": "Allow",
      "Change calendar": "Ask first",
    },
    schedule: true,
  },
  {
    id: "marcel",
    name: "Marcel",
    role: "Travel assistant",
    description: "Thoughtful trips, fewer loose ends.",
    status: "Ready",
    duties:
      "Help plan travel around my calendar and saved preferences. Bring options before making commitments.",
    language: "English",
    access: {
      "Read calendar": "Allow",
      "Change calendar": "Ask first",
      "Read saved places": "Allow",
    },
    schedule: false,
  },
  {
    id: "calliope",
    name: "Calliope",
    role: "Thinking partner",
    description: "A little room to think.",
    status: "Ready",
    duties: "Help explore ideas, question assumptions and keep useful notes.",
    language: "English",
    access: { "Read notes": "Allow", "Write notes": "Ask first" },
    schedule: false,
  },
];
const nav: Page[] = ["Home", "Chat", "Agents", "Activity", "Connections"];
function NavIcon({ page }: { page: Page }) {
  const icons = {
    Chat: MessageSquareText,
    Agents: UsersRound,
    Activity: History,
    Connections: Plug,
    Deadlines: CalendarDays,
    "Saved preferences": Bookmark,
    "Market watch": ChartNoAxesCombined,
    Settings: Settings2,
  };
  if (page === "Home") return <Bracket />;
  const Icon = icons[page];
  return <Icon size={17} aria-hidden="true" />;
}
export function AgentBadge({
  agent,
}: {
  agent: Pick<Agent, "name" | "role" | "avatar">;
}) {
  return (
    <span className="agent-badge" aria-hidden="true">
      {agent.avatar ? (
        <img src={agent.avatar} alt="" />
      ) : (
        <svg
          viewBox="0 0 40 40"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          {agent.role === "Travel assistant" ? (
            <>
              <circle
                cx="20"
                cy="20"
                r="12"
                strokeDasharray="60 16"
                transform="rotate(-60 20 20)"
              />
              <circle
                cx="32"
                cy="20"
                r="2.3"
                fill="currentColor"
                stroke="none"
              />
              <path d="M8 20h11" />
            </>
          ) : (
            <>
              <circle cx="20" cy="20" r="12" />
              {(agent.role === "Chief of staff"
                ? [
                    [20, 32],
                    [9.6, 14],
                    [30.4, 14],
                  ]
                : [
                    [20, 8],
                    [32, 20],
                    [20, 32],
                    [8, 20],
                  ]
              ).map(([cx, cy]) => (
                <circle
                  key={`${cx}-${cy}`}
                  cx={cx}
                  cy={cy}
                  r="2.3"
                  fill="currentColor"
                  stroke="none"
                />
              ))}
            </>
          )}
        </svg>
      )}
    </span>
  );
}
export function Mark() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="8.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeDasharray="50.5 2.9"
        transform="rotate(-93 12 12)"
      />
      <g fill="currentColor">
        <circle cx="12" cy="20.5" r="1.9" />
        <circle cx="4.64" cy="7.75" r="1.9" />
        <circle cx="19.36" cy="7.75" r="1.9" />
        <circle cx="12" cy="3.5" r="1.1" />
      </g>
    </svg>
  );
}
export function Bracket() {
  return (
    <svg
      width="12"
      height="18"
      viewBox="0 0 16 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M2 22V8L8 2l6 6v14" />
    </svg>
  );
}
function Status({ children }: { children: ReactNode }) {
  return (
    <span
      className={`status ${children === "Reconnect needed" ? "needs-attention" : ""}`}
    >
      <i />
      {children}
    </span>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="field">
      <Label>
        {label}
        {children}
      </Label>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
function Header({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <h1 tabIndex={-1} data-page-title>
          {title}
        </h1>
        <p>{description}</p>
      </div>
      {children}
    </header>
  );
}
function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-heading">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <CircleDashed size={22} aria-hidden="true" />
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function App() {
  const [surface, setSurface] = useState<"console" | "marketing">(() =>
    location.hash.includes("marketing") ? "marketing" : "console",
  );
  const [dark, setDark] = useState(false),
    [page, setPage] = useState<Page>("Home"),
    [mobile, setMobile] = useState(false);
  const [agents, setAgents] = useState(initialAgents),
    [selected, setSelected] = useState<string | null>(null),
    [tab, setTab] = useState("overview");
  const [editor, setEditor] = useState<Agent | "new" | null>(null),
    [lifecycle, setLifecycle] = useState<{
      id: string;
      action: "retire" | "delete";
    } | null>(null);
  const [notice, setNotice] = useState(""),
    [approval, setApproval] = useState<"pending" | "approved" | "dismissed">(
      "pending",
    );
  const [approvalOpen, setApprovalOpen] = useState(false),
    [search, setSearch] = useState("");
  const [activity, setActivity] = useState([
    "Saga prepared an email for your review",
    "Marcel checked your calendar",
    "Saga read the morning inbox",
    "Calliope saved a working note",
  ]);
  const [connected, setConnected] = useState(false),
    [connectionDialog, setConnectionDialog] = useState(false),
    [quiet, setQuiet] = useState(true);
  const [chatAgent, setChatAgent] = useState("saga");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  useLayoutEffect(() => {
    document.documentElement.dataset.surface = surface;
  }, [surface]);
  useLayoutEffect(() => {
    document.querySelector<HTMLElement>("[data-page-title]")?.focus();
  }, [page, selected, surface]);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  const notify = (text: string) => setNotice(text);
  const log = (text: string) => setActivity((a) => [text, ...a]);
  function go(p: Page) {
    setPage(p);
    setSelected(null);
    setMobile(false);
    setSearch("");
  }
  function openAgent(id: string) {
    setPage("Agents");
    setSelected(id);
    setTab("overview");
    setMobile(false);
  }
  function changeSurface(value: "console" | "marketing") {
    setSurface(value);
    location.hash = value;
    window.scrollTo(0, 0);
  }
  function chat(id: string) {
    setChatAgent(id);
    go("Chat");
  }
  function update(id: string, patch: Partial<Agent>) {
    setAgents((a) => a.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }
  function decide(value: "approved" | "dismissed") {
    setApproval(value);
    setApprovalOpen(false);
    log(
      `Preview: ${value === "approved" ? "you approved" : "you dismissed"} Saga’s email draft`,
    );
    notify(
      value === "approved"
        ? "Preview approval recorded. No email was sent."
        : "Preview draft dismissed.",
    );
  }
  const current = agents.find((a) => a.id === selected);
  const nextBrief = agents.find(
    (a) => a.id === "saga" && a.status === "Ready" && a.schedule,
  );
  const visibleAgents = agents.filter((a) =>
    (a.name + " " + a.role).toLowerCase().includes(search.toLowerCase()),
  );
  const agentRows = (list: Agent[]) => (
    <div className="table-frame">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Needs you</TableHead>
            <TableHead className="optional-col">Last activity</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((a) => (
            <TableRow key={a.id}>
              <TableCell>
                <button className="agent-name" onClick={() => openAgent(a.id)}>
                  <AgentBadge agent={a} />
                  {a.name}
                </button>
                <span className="agent-role">{a.role}</span>
              </TableCell>
              <TableCell>
                <Status>{a.status}</Status>
              </TableCell>
              <TableCell>
                {a.status === "Ready" &&
                a.id === "saga" &&
                approval === "pending" ? (
                  <button
                    className="text-link"
                    onClick={() => setApprovalOpen(true)}
                  >
                    1 approval
                  </button>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="optional-col muted">
                {a.status === "Retired"
                  ? "Stopped"
                  : a.id === "saga"
                    ? "Draft ready for review"
                    : a.id === "marcel"
                      ? "Calendar checked"
                      : "Notes up to date"}
              </TableCell>
              <TableCell>
                <div className="row-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={a.status === "Retired"}
                    onClick={() => chat(a.id)}
                  >
                    Chat
                  </Button>
                  <AgentMenu
                    agent={a}
                    edit={() => setEditor(a)}
                    lifecycle={(action) => setLifecycle({ id: a.id, action })}
                  />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
  const approvalCard = (
    <div className="approval-summary">
      <div>
        <span className="mono muted">saga · email draft</span>
        <h3>Send the meeting follow-up to Kari?</h3>
        <p>
          The notes are ready. Review the recipients and message before sending.
        </p>
      </div>
      <Button variant="outline" onClick={() => setApprovalOpen(true)}>
        Review draft <ArrowRight />
      </Button>
    </div>
  );
  return (
    <>
      <div className="preview-bar">
        <div>
          <span className="mono">design preview</span>
          <span className="preview-detail">
            Sample data · changes reset on reload
          </span>
        </div>
        <div className="preview-controls">
          <button
            aria-pressed={surface === "console"}
            onClick={() => changeSurface("console")}
          >
            Console
          </button>
          <button
            aria-pressed={surface === "marketing"}
            onClick={() => changeSurface("marketing")}
          >
            Marketing
          </button>
          <button
            onClick={() => setDark(!dark)}
            aria-label={dark ? "Use light theme" : "Use dark theme"}
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </div>
      {surface === "marketing" ? (
        <Marketing openConsole={() => changeSurface("console")} />
      ) : (
        <div className="app-shell">
          <div className="mobile-header">
            <span className="brand">
              <Mark />
              lares
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle navigation"
              aria-expanded={mobile}
              onClick={() => setMobile(!mobile)}
            >
              {mobile ? <X /> : <Menu />}
            </Button>
          </div>
          <aside className={`sidebar ${mobile ? "is-open" : ""}`}>
            <button className="brand" onClick={() => go("Home")}>
              <Mark />
              lares
            </button>
            <nav aria-label="Main navigation">
              {nav.map((n) => (
                <button
                  key={n}
                  className={`nav-item ${page === n ? "active" : ""}`}
                  aria-current={page === n ? "page" : undefined}
                  onClick={() => go(n)}
                >
                  <span>
                    <NavIcon page={n} />
                    {n}
                  </span>
                  {n === "Home" && approval === "pending" && (
                    <span className="nav-dot" />
                  )}
                </button>
              ))}
              <div className="nav-label">Tools</div>
              {(
                ["Deadlines", "Saved preferences", "Market watch"] as Page[]
              ).map((n) => (
                <button
                  key={n}
                  className={`nav-item ${page === n ? "active" : ""}`}
                  onClick={() => go(n)}
                >
                  <span>
                    <NavIcon page={n} />
                    {n}
                  </span>
                </button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <button
                className={`nav-item ${page === "Settings" ? "active" : ""}`}
                onClick={() => go("Settings")}
              >
                <span>
                  <NavIcon page="Settings" />
                  Settings
                </span>
              </button>
              <div className="installation mono">
                this installation
                <br />
                sample workspace
                <br />
                Europe/Oslo
              </div>
            </div>
          </aside>
          <main className="main">
            <div
              className={`page-content enter page-${page.toLowerCase().replaceAll(" ", "-")}`}
              key={page + String(selected)}
            >
              {page === "Home" && (
                <>
                  <Header
                    title="The house is in order."
                    description="A little overview of what your agents are taking care of."
                  />
                  <div className="home-summary">
                    <span className="mono">Friday, 25 September</span>
                    <span className="mono muted">
                      {agents.filter((a) => a.status === "Ready").length} agents
                      ready
                    </span>
                  </div>
                  <Section
                    title="Needs your attention"
                    action={
                      <span className="mono muted">
                        {approval === "pending" ? "1 item" : "All clear"}
                      </span>
                    }
                  >
                    {approval === "pending" ? (
                      approvalCard
                    ) : (
                      <div className="quiet-panel">
                        <Check size={16} />
                        Nothing waiting on you.
                      </div>
                    )}
                  </Section>
                  <Section
                    title="Your agents"
                    action={
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => go("Agents")}
                      >
                        Manage agents <ArrowRight />
                      </Button>
                    }
                  >
                    {agentRows(agents)}
                  </Section>
                  <div className="home-columns">
                    <Section
                      title="Recent work"
                      action={
                        <button
                          className="text-link"
                          onClick={() => go("Activity")}
                        >
                          View all
                        </button>
                      }
                    >
                      {activity.slice(0, 3).map((x, i) => (
                        <div className="feed-row" key={x + i}>
                          <span>{x}</span>
                          <span className="mono muted">{i * 8 + 2}m ago</span>
                        </div>
                      ))}
                    </Section>
                    <Section title="Coming up">
                      {nextBrief ? (
                        <div className="schedule-preview">
                          <span className="mono muted">tomorrow · 08:00</span>
                          <h3>Your morning brief</h3>
                          <p>Inbox, calendar and deadlines. From Saga.</p>
                          <button
                            className="text-link"
                            onClick={() => {
                              openAgent("saga");
                              setTab("schedules");
                            }}
                          >
                            View schedule <ArrowRight size={13} />
                          </button>
                        </div>
                      ) : (
                        <p className="muted">No upcoming sample schedules.</p>
                      )}
                    </Section>
                  </div>
                  <p className="footnote mono">
                    Sample activity shown for layout review.
                  </p>
                </>
              )}
              {page === "Agents" && !current && (
                <>
                  <Header
                    title="Agents"
                    description="Give each agent a purpose. Keep their work and access in one place."
                  >
                    <Button onClick={() => setEditor("new")}>
                      <Plus />
                      Create agent
                    </Button>
                  </Header>
                  <div className="list-toolbar">
                    <Input
                      aria-label="Find an agent"
                      placeholder="Find an agent…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <span className="mono muted">{agents.length} agents</span>
                  </div>
                  {visibleAgents.length ? (
                    agentRows(visibleAgents)
                  ) : (
                    <Empty title="No agents found">
                      <p>Try another name, or create an agent.</p>
                      <Button onClick={() => setEditor("new")}>
                        Create agent
                      </Button>
                    </Empty>
                  )}
                  <p className="hint mt-4">
                    Choose an agent to see its work, access and schedules.
                  </p>
                </>
              )}
              {page === "Agents" && current && (
                <>
                  <button
                    className="back-link"
                    onClick={() => setSelected(null)}
                  >
                    <ArrowLeft size={14} />
                    All agents
                  </button>
                  <Header
                    title={current.name}
                    description={`${current.role} · ${current.description}`}
                  >
                    <div className="row-actions">
                      <Button
                        disabled={current.status === "Retired"}
                        onClick={() => chat(current.id)}
                      >
                        Chat with {current.name}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={current.status === "Retired"}
                        onClick={() => setEditor(current)}
                      >
                        Edit agent
                      </Button>
                      <AgentMenu
                        agent={current}
                        edit={() => setEditor(current)}
                        lifecycle={(action) =>
                          setLifecycle({ id: current.id, action })
                        }
                      />
                    </div>
                  </Header>
                  <div className="agent-meta">
                    <AgentBadge agent={current} />
                    <Status>{current.status}</Status>
                    <span className="mono muted">
                      {current.id} · {current.language}
                    </span>
                  </div>
                  {current.status === "Retired" && (
                    <div className="quiet-panel">
                      This agent is retired. Its history is preserved and its
                      settings are read-only.
                    </div>
                  )}
                  <Tabs value={tab} onValueChange={setTab}>
                    <TabsList className="agent-tabs">
                      <TabsTrigger value="overview">Overview</TabsTrigger>
                      <TabsTrigger value="access">Access</TabsTrigger>
                      <TabsTrigger value="schedules">Schedules</TabsTrigger>
                      <TabsTrigger value="activity">Activity</TabsTrigger>
                    </TabsList>
                    <TabsContent value="overview" className="enter">
                      <Section title="What this agent does">
                        <p className="reading-copy">{current.duties}</p>
                      </Section>
                      {current.id === "saga" &&
                        approval === "pending" &&
                        current.status === "Ready" && (
                          <Section title="Needs your attention">
                            {approvalCard}
                          </Section>
                        )}
                      <div className="home-columns">
                        <Section title="Access">
                          <p className="muted">
                            {Object.keys(current.access).length} permissions
                            configured.
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setTab("access")}
                          >
                            Review access
                          </Button>
                        </Section>
                        <Section title="Scheduled work">
                          <p className="muted">
                            {current.schedule
                              ? "Morning brief · every day at 08:00"
                              : "No recurring work scheduled."}
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setTab("schedules")}
                          >
                            View schedules
                          </Button>
                        </Section>
                      </div>
                    </TabsContent>
                    <TabsContent value="access" className="enter">
                      <Section title="What it can do">
                        <p className="section-intro">
                          Choose when {current.name} can act. Changes below
                          apply immediately in this preview.
                        </p>
                        <div className="permission-list">
                          {Object.entries(current.access).map(
                            ([name, value]) => (
                              <div className="permission-row" key={name}>
                                <div>
                                  <h3>{name}</h3>
                                  <p>
                                    {name.includes("email")
                                      ? "Connected work mailbox"
                                      : name.includes("calendar")
                                        ? "Your work calendar"
                                        : "Shared workspace"}
                                  </p>
                                </div>
                                <Select
                                  value={value}
                                  disabled={current.status === "Retired"}
                                  onValueChange={(v) => {
                                    update(current.id, {
                                      access: { ...current.access, [name]: v },
                                    });
                                    notify("Preview permission saved.");
                                    log(
                                      `Preview: changed ${current.name}’s ${name.toLowerCase()} permission`,
                                    );
                                  }}
                                >
                                  <SelectTrigger
                                    aria-label={name + " permission"}
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="Allow">Allow</SelectItem>
                                    <SelectItem value="Ask first">
                                      Ask first
                                    </SelectItem>
                                    <SelectItem value="Never">Never</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            ),
                          )}
                        </div>
                        <p className="hint mt-4">
                          Some actions always require approval. The live
                          implementation will show the engine’s effective rules.
                        </p>
                      </Section>
                    </TabsContent>
                    <TabsContent value="schedules" className="enter">
                      <Section title="Recurring work">
                        <div className="permission-row">
                          <div>
                            <h3>Morning brief</h3>
                            <p>Every day at 08:00 · Europe/Oslo</p>
                          </div>
                          <Switch
                            aria-label="Morning brief"
                            checked={current.schedule}
                            disabled={current.status === "Retired"}
                            onCheckedChange={(v) => {
                              update(current.id, { schedule: v });
                              notify(
                                v
                                  ? "Preview schedule enabled."
                                  : "Preview schedule disabled.",
                              );
                            }}
                          />
                        </div>
                        <p className="hint mt-4">
                          Shared quiet hours and notification limits apply.
                        </p>
                        <button
                          className="text-link"
                          onClick={() => go("Settings")}
                        >
                          Notification settings <ArrowRight size={13} />
                        </button>
                      </Section>
                    </TabsContent>
                    <TabsContent value="activity" className="enter">
                      <Section title="Recent work">
                        {activity
                          .filter((x) =>
                            x
                              .toLowerCase()
                              .includes(current.name.toLowerCase()),
                          )
                          .map((x, i) => (
                            <div className="feed-row" key={i}>
                              <span>{x}</span>
                              <span className="mono muted">today</span>
                            </div>
                          ))}
                      </Section>
                    </TabsContent>
                  </Tabs>
                </>
              )}
              {page === "Chat" && (
                <>
                  <Header
                    title="Chat"
                    description="Talk things through. Your agents are here."
                  />
                  {agents.some((a) => a.status === "Ready") ? (
                    agents
                      .filter((a) => a.status === "Ready")
                      .map((a) => (
                        <div
                          key={a.id}
                          hidden={
                            a.id !==
                            (agents.some(
                              (x) => x.id === chatAgent && x.status === "Ready",
                            )
                              ? chatAgent
                              : agents.find((x) => x.status === "Ready")!.id)
                          }
                        >
                          <ChatPreview
                            agent={a}
                            agents={agents.filter((x) => x.status === "Ready")}
                            onSelect={setChatAgent}
                          />
                        </div>
                      ))
                  ) : (
                    <Empty title="Choose an agent">
                      <p>Create an agent to start a sample conversation.</p>
                      <Button onClick={() => go("Agents")}>View agents</Button>
                    </Empty>
                  )}
                </>
              )}
              {page === "Activity" && (
                <>
                  <Header
                    title="Activity"
                    description="What happened, who did it, and what needed your decision."
                  />
                  <div className="list-toolbar">
                    <Input
                      aria-label="Search activity"
                      placeholder="Search activity…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <span className="mono muted">sample history · today</span>
                  </div>
                  <div className="table-frame">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>When</TableHead>
                          <TableHead>What happened</TableHead>
                          <TableHead>Record</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {activity
                          .filter((x) =>
                            x.toLowerCase().includes(search.toLowerCase()),
                          )
                          .map((x, i) => (
                            <TableRow key={i}>
                              <TableCell className="mono">
                                {String(10 - Math.floor(i / 3)).padStart(
                                  2,
                                  "0",
                                )}
                                :{String(42 - (i % 3) * 8).padStart(2, "0")}
                              </TableCell>
                              <TableCell>{x}</TableCell>
                              <TableCell className="mono muted">
                                sample
                              </TableCell>
                            </TableRow>
                          ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="hint mt-4">
                    The live activity and cost sources will be connected during
                    implementation.
                  </p>
                </>
              )}
              {page === "Connections" && (
                <>
                  <Header
                    title="Connections"
                    description="Your accounts, their health, and the agents that use them."
                  >
                    <Button onClick={() => setConnectionDialog(true)}>
                      <Plus />
                      Add connection
                    </Button>
                  </Header>
                  <div className="connection-grid">
                    {[
                      [
                        "Google",
                        "Mail and calendar",
                        "Connected",
                        "Saga, Marcel",
                      ],
                      [
                        "Notion",
                        "Notes and documents",
                        connected ? "Connected" : "Reconnect needed",
                        "Calliope",
                      ],
                      ["Slack", "Conversations", "Connected", "Saga, Calliope"],
                    ].map(([name, desc, state, who]) => (
                      <div className="connection" key={name}>
                        <div className="section-heading">
                          <h2>{name}</h2>
                          <Status>{state}</Status>
                        </div>
                        <p>{desc}</p>
                        <div className="mono muted">
                          used by {who.toLowerCase()}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setConnectionDialog(true)}
                        >
                          {state === "Reconnect needed"
                            ? "Reconnect"
                            : "Manage connection"}
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Section title="Email writing style">
                    <p className="reading-copy muted">
                      Writing preferences belong to each mailbox. Keep the tone
                      of your emails consistent, whichever agent prepares them.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => setConnectionDialog(true)}
                    >
                      View mailbox settings
                    </Button>
                  </Section>
                </>
              )}
              {page === "Settings" && (
                <>
                  <Header
                    title="Settings"
                    description="The shared defaults for your house."
                  />
                  <Section title="Notifications & quiet hours">
                    <div className="permission-row">
                      <div>
                        <h3>Quiet hours</h3>
                        <p>Hold non-urgent updates between 22:00 and 08:00.</p>
                      </div>
                      <Switch
                        aria-label="Quiet hours"
                        checked={quiet}
                        onCheckedChange={(v) => {
                          setQuiet(v);
                          notify("Preview notification setting saved.");
                        }}
                      />
                    </div>
                    <div className="permission-row">
                      <div>
                        <h3>Time zone</h3>
                        <p>Used for schedules and your daily brief.</p>
                      </div>
                      <span className="mono">Europe/Oslo</span>
                    </div>
                  </Section>
                  <Section title="Appearance">
                    <div className="permission-row">
                      <div>
                        <h3>Dark theme</h3>
                        <p>The same Lares palette, after hours.</p>
                      </div>
                      <Switch
                        aria-label="Dark theme"
                        checked={dark}
                        onCheckedChange={setDark}
                      />
                    </div>
                  </Section>
                  <Section title="Backup & recovery">
                    <p className="muted">
                      No live backup status is available in this standalone
                      preview.
                    </p>
                    <p className="hint">
                      The production screen will show the last verified backup
                      and recovery options.
                    </p>
                  </Section>
                </>
              )}
              {(
                ["Deadlines", "Saved preferences", "Market watch"] as Page[]
              ).includes(page) && (
                <>
                  <Header
                    title={page}
                    description={
                      page === "Deadlines"
                        ? "What is due, and what needs a little preparation."
                        : page === "Saved preferences"
                          ? "Useful context your agents can draw on."
                          : "A quieter view of what you follow."
                    }
                  />
                  {page === "Deadlines" ? (
                    <div className="table-frame">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Deadline</TableHead>
                            <TableHead>Due</TableHead>
                            <TableHead>Owner</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          <TableRow>
                            <TableCell>Review September invoices</TableCell>
                            <TableCell className="mono">30 Sep</TableCell>
                            <TableCell>Saga</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell>Confirm Copenhagen itinerary</TableCell>
                            <TableCell className="mono">02 Oct</TableCell>
                            <TableCell>Marcel</TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <Empty
                      title={
                        page === "Saved preferences"
                          ? "A place for the things you like."
                          : "Nothing on the watchlist yet."
                      }
                    >
                      <p>
                        This preview establishes where the tool lives.
                        <br />
                        Its detailed workflow will follow in a later slice.
                      </p>
                    </Empty>
                  )}
                </>
              )}
            </div>
          </main>
        </div>
      )}
      <AgentEditor
        key={editor === "new" ? "new" : (editor?.id ?? "closed")}
        agent={editor}
        close={() => setEditor(null)}
        existing={agents}
        save={(a) => {
          if (editor === "new") {
            setAgents((old) => [...old, a]);
            log(`Preview: created ${a.name}`);
          } else {
            update(a.id, a);
            log(`Preview: edited ${a.name}`);
          }
          setEditor(null);
          openAgent(a.id);
          notify("Preview agent saved. No live agent was changed.");
        }}
      />
      <Dialog open={!!lifecycle} onOpenChange={(v) => !v && setLifecycle(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {lifecycle?.action === "delete" ? "Delete" : "Retire"}{" "}
              {agents.find((a) => a.id === lifecycle?.id)?.name}?
            </DialogTitle>
            <DialogDescription>
              {lifecycle?.action === "delete"
                ? "This removes the sample agent from this preview. In the live console, permanent deletion also removes its owned data and cannot be undone."
                : "This stops the sample agent and makes its settings read-only. Its recorded history remains. Retirement is not a reversible pause."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLifecycle(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!lifecycle) return;
                const a = agents.find((x) => x.id === lifecycle.id)!;
                if (a.id === "saga") setApproval("dismissed");
                if (lifecycle.action === "delete") {
                  setAgents((old) => old.filter((x) => x.id !== a.id));
                  setSelected(null);
                } else update(a.id, { status: "Retired" });
                log(
                  `Preview: ${lifecycle.action === "delete" ? "deleted" : "retired"} ${a.name}`,
                );
                notify(
                  "Sample agent " +
                    (lifecycle.action === "delete" ? "deleted." : "retired."),
                );
                setLifecycle(null);
              }}
            >
              {lifecycle?.action === "delete"
                ? "Delete sample agent"
                : "Retire sample agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={approvalOpen} onOpenChange={setApprovalOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Review Saga’s email</DialogTitle>
            <DialogDescription>
              Sample approval · nothing will be sent.
            </DialogDescription>
          </DialogHeader>
          <div className="draft">
            <div className="draft-meta">
              <span className="mono muted">to</span>
              <span>Kari Hansen &lt;kari@example.com&gt;</span>
            </div>
            <div className="draft-meta">
              <span className="mono muted">subject</span>
              <span>Notes from our planning meeting</span>
            </div>
            <div className="draft-body">
              Hi Kari,
              <br />
              <br />
              Thanks for today. I’ve gathered the next steps we agreed on:
              <br />
              <br />• Share the revised schedule by Tuesday.
              <br />• Confirm who is joining the next session.
              <br />• Send the agenda ahead of Thursday.
              <br />
              <br />
              Let me know if I missed anything.
              <br />
              <br />
              Bendik
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => decide("dismissed")}>
              Dismiss
            </Button>
            <Button variant="outline" onClick={() => setApprovalOpen(false)}>
              Back
            </Button>
            <Button onClick={() => decide("approved")}>
              Approve sample draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={connectionDialog} onOpenChange={setConnectionDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Account connections</DialogTitle>
            <DialogDescription>
              This preview does not connect to external accounts. You can
              simulate a successful reconnection to review the resulting state.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConnectionDialog(false)}
            >
              Close
            </Button>
            <Button
              onClick={() => {
                setConnected(true);
                setConnectionDialog(false);
                notify("Preview: Notion is now shown as connected.");
              }}
            >
              Simulate reconnection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div
        role="status"
        aria-live="polite"
        className={notice ? "toast visible" : "toast"}
      >
        {notice && (
          <>
            <Check size={15} />
            {notice}
          </>
        )}
      </div>
    </>
  );
}
function AgentMenu({
  agent,
  edit,
  lifecycle,
}: {
  agent: Agent;
  edit: () => void;
  lifecycle: (a: "retire" | "delete") => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for ${agent.name}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={agent.status === "Retired"} onSelect={edit}>
          Edit agent
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={agent.status === "Retired"}
          onSelect={() => lifecycle("retire")}
        >
          Retire agent
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => lifecycle("delete")}>
          Delete agent…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function AgentEditor({
  agent,
  close,
  save,
  existing,
}: {
  agent: Agent | "new" | null;
  close: () => void;
  save: (a: Agent) => void;
  existing: Agent[];
}) {
  const isNew = agent === "new";
  const base = typeof agent === "object" && agent ? agent : initialAgents[0];
  const [step, setStep] = useState(0),
    [name, setName] = useState(isNew ? "" : base.name),
    [role, setRole] = useState(isNew ? "Chief of staff" : base.role),
    [duties, setDuties] = useState(base.duties),
    [language, setLanguage] = useState(base.language),
    [error, setError] = useState("");
  const [avatar, setAvatar] = useState<string | undefined>(
    isNew ? undefined : base.avatar,
  );
  const [avatarError, setAvatarError] = useState("");
  const id = isNew ? name.toLowerCase().trim().replace(/\s+/g, "-") : base.id;
  function valid() {
    if (!name.trim()) {
      setError("Give your agent a name.");
      return false;
    }
    if (isNew && !/^[a-z][a-z0-9-]{1,30}$/.test(id)) {
      setError("Use 2–31 letters, numbers or hyphens, starting with a letter.");
      return false;
    }
    if (isNew && existing.some((x) => x.id === id)) {
      setError("An agent already uses that name. Choose another.");
      return false;
    }
    if (!duties.trim()) {
      setError("Describe what this agent should help with.");
      return false;
    }
    setError("");
    return true;
  }
  return (
    <Dialog open={!!agent} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-xl editor-dialog">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "Create an agent" : `Edit ${base.name}`}
          </DialogTitle>
          <DialogDescription>
            {isNew
              ? "A purpose, a name, and a clear set of permissions."
              : "Update what your agent is here to do. Access and schedules have their own tabs."}
          </DialogDescription>
        </DialogHeader>
        {isNew && (
          <div className="steps mono">
            {["Purpose", "Identity", "Review"].map((s, i) => (
              <span key={s} className={step === i ? "current" : ""}>
                {i + 1} {s}
              </span>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (isNew && step < 2) {
              if (step === 0 || valid()) setStep(step + 1);
              return;
            }
            if (valid())
              save({
                ...base,
                id,
                name: name.trim(),
                avatar,
                role,
                duties,
                language,
                status: "Ready",
                description:
                  role === "Chief of staff"
                    ? "The working day, taken care of."
                    : role === "Travel assistant"
                      ? "A little less to arrange."
                      : "Space for the work that matters.",
                access: isNew
                  ? { ...initialAgents.find((a) => a.role === role)!.access }
                  : base.access,
                schedule: isNew ? role === "Chief of staff" : base.schedule,
              });
          }}
        >
          {isNew && step === 0 ? (
            <div className="template-list">
              {initialAgents.map((a) => (
                <label
                  className={`template ${role === a.role ? "selected" : ""}`}
                  key={a.role}
                >
                  <input
                    type="radio"
                    name="purpose"
                    value={a.role}
                    checked={role === a.role}
                    onChange={() => {
                      setRole(a.role);
                      setDuties(a.duties);
                    }}
                  />
                  <div>
                    <h3>{a.role}</h3>
                    <p>{a.description}</p>
                  </div>
                </label>
              ))}
            </div>
          ) : isNew && step === 2 ? (
            <div className="review">
              <h2>{name}</h2>
              <p className="muted">
                {role} · {language}
              </p>
              <p>{duties}</p>
              <h3>Starting permissions</h3>
              {Object.entries(
                initialAgents.find((a) => a.role === role)!.access,
              ).map(([k, v]) => (
                <div className="review-row" key={k}>
                  <span>{k}</span>
                  <span className="mono">{v}</span>
                </div>
              ))}
              <p className="hint">
                Preview only. Creating here will not start a live agent.
              </p>
            </div>
          ) : (
            <div className="form-fields">
              <div className="avatar-editor">
                <AgentBadge agent={{ name, role, avatar }} />
                <div>
                  <Label htmlFor="agent-image">Agent image</Label>
                  <input
                    id="agent-image"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (
                        !["image/png", "image/jpeg", "image/webp"].includes(
                          file.type,
                        ) ||
                        file.size > 2 * 1024 * 1024
                      ) {
                        setAvatarError(
                          "Choose a PNG, JPG or WebP image under 2 MB.",
                        );
                        e.target.value = "";
                        return;
                      }
                      setAvatarError("");
                      const reader = new FileReader();
                      reader.onload = () => setAvatar(String(reader.result));
                      reader.onerror = () =>
                        setAvatarError(
                          "That image could not be read. Try another file.",
                        );
                      reader.readAsDataURL(file);
                      e.target.value = "";
                    }}
                  />
                  <p className="hint">
                    Optional · PNG, JPG or WebP · up to 2 MB
                  </p>
                  {avatar && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setAvatar(undefined)}
                    >
                      Use default icon
                    </Button>
                  )}
                  {avatarError && <p role="alert">{avatarError}</p>}
                </div>
              </div>
              <Field
                label={isNew ? "Name" : "Name (permanent)"}
                hint={
                  isNew
                    ? "For example: atlas. This becomes its permanent identifier."
                    : "The current runtime uses a permanent name."
                }
              >
                <Input
                  aria-label="Agent name"
                  value={name}
                  disabled={!isNew}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="What should it help with?">
                <Textarea
                  aria-label="Agent instructions"
                  rows={5}
                  value={duties}
                  onChange={(e) => setDuties(e.target.value)}
                />
              </Field>
              <Field label="Language">
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger aria-label="Agent language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="English">English</SelectItem>
                    <SelectItem value="Norwegian">Norwegian</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <p className="hint">
                Model and advanced settings will use the installation defaults.
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <DialogFooter className="mt-6">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            {isNew && step > 0 && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep(step - 1)}
              >
                Back
              </Button>
            )}
            <Button type="submit">
              {isNew
                ? step < 2
                  ? "Continue"
                  : "Create sample agent"
                : "Save changes"}
              {isNew && step < 2 && <ArrowRight />}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function ChatPreview({
  agent,
  agents,
  onSelect,
}: {
  agent: Agent;
  agents: Agent[];
  onSelect: (id: string) => void;
}) {
  const [messages, setMessages] = useState([
    {
      id: 0,
      who: agent.name,
      text: `I’m ${agent.name}. ${agent.description} What would you like to work on?`,
    },
  ]);
  const [text, setText] = useState(""),
    [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fn = () => setReduced(m.matches);
    m.addEventListener("change", fn);
    return () => {
      m.removeEventListener("change", fn);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  function send(value: string) {
    if (!value.trim() || busy) return;
    setMessages((m) => [
      ...m,
      { id: Date.now(), who: "You", text: value.trim() },
    ]);
    setText("");
    setBusy(true);
    timer.current = setTimeout(() => {
      setMessages((m) => [
        ...m,
        {
          id: Date.now(),
          who: agent.name,
          text: "This is a sample response so you can try the conversation layout. In the connected console, Eve will deliver the agent’s actual reply here. No model was called and no action was taken.",
        },
      ]);
      setBusy(false);
    }, 650);
  }
  return (
    <div
      className={`chat-panel ${messages.length <= 1 && !messages.some((m) => m.who === "You") ? "chat-intro" : ""}`}
    >
      <div className="chat-top">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="agent-switcher"
              aria-label={`Choose agent, current agent ${agent.name}`}
            >
              <AgentBadge agent={agent} />
              <span className="chat-identity">
                <span className="hint">Chat with</span>
                <strong>{agent.name}</strong>
              </span>
              <ChevronDown size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="agent-switcher-menu">
            {agents.map((a) => (
              <DropdownMenuItem key={a.id} onSelect={() => onSelect(a.id)}>
                <AgentBadge agent={a} />
                <span className="chat-identity">
                  <strong>{a.name}</strong>
                  <span className="hint">{a.role}</span>
                </span>
                {a.id === agent.id && (
                  <Check size={16} className="agent-check" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            setBusy(false);
            setMessages([]);
          }}
        >
          New conversation
        </Button>
      </div>
      <Conversation
        initial={reduced ? "instant" : "smooth"}
        resize={reduced ? "instant" : "smooth"}
        className="conversation"
      >
        <ConversationContent className="transcript-content">
          {messages.map((m) => (
            <article
              className={`message enter ${m.who === "You" ? "user-message" : ""}`}
              key={m.id}
            >
              <span className="message-author">
                {m.who !== "You" && <AgentBadge agent={agent} />} {m.who}
              </span>
              <p>{m.text}</p>
            </article>
          ))}
          {busy && (
            <p className="mono muted" role="status">
              Preparing sample response…
            </p>
          )}
          {!messages.length && (
            <Empty title="A little room to talk.">
              <p>Start a new sample conversation with {agent.name}.</p>
            </Empty>
          )}
        </ConversationContent>
        <ConversationScrollButton aria-label="Jump to latest message" />
      </Conversation>
      <div className="composer-area">
        <div className="suggestions">
          {["What needs my attention?", "Help me plan the week"].map((s) => (
            <Button
              key={s}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => send(s)}
            >
              {s}
            </Button>
          ))}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <Textarea
            aria-label={`Message ${agent.name}`}
            placeholder={`Message ${agent.name}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send(text);
              }
            }}
          />
          <Button
            size="icon"
            type="submit"
            disabled={busy || !text.trim()}
            aria-label="Send message"
          >
            <ArrowUp />
          </Button>
        </form>
        <p className="hint">
          Sample replies · Enter to send · Shift + Enter for a new line
        </p>
      </div>
    </div>
  );
}
