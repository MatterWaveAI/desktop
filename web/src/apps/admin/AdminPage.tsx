import { useCallback, useEffect, useId, useState, type FormEvent, type MouseEvent } from "react";
import { Alert } from "../../components/ui/alert";
import { Badge, StatusDot } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../components/ui/table";
import { Input } from "../../components/ui/input";
import { DestructiveConfirm, EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
import { NavItem } from "../../components/ui/nav-item";
import { formatMicros } from "../../lib/billing";
import { failureMessage } from "../../shell/authForms";
import { useShell } from "../../shell/shellContext";
import { AnnouncementsTab } from "./AnnouncementsTab";
import { BillingTab } from "./BillingTab";
import { DeletionsTab } from "./DeletionsTab";
import { EnforcementTab } from "./EnforcementTab";
import { FlagsTab } from "./FlagsTab";
import { HealthTab } from "./HealthTab";
import { IdentityId } from "./IdentityId";
import { IntegrationsTab } from "./IntegrationsTab";
import { ModerationTab } from "./ModerationTab";
import { OrgDetails } from "./OrgDetails";
import { OverdueTab } from "./OverdueTab";
import { PlansTab } from "./PlansTab";
import { RetentionTab } from "./RetentionTab";
import { SupportConfirm } from "./SupportConfirm";
import { ErrorBoundary } from "../../components/AppError";
import { TabStrip, TabStripItem } from "../../components/ui/tab-strip";
import { useLoad } from "./useLoad";
import {
  fetchOrgPage,
  fetchSpend,
  fetchUsers,
  formatDate,
  navigateTo,
  startSupport,
  suspendUser,
  unsuspendUser,
  type AdminOrg,
  type AdminUser,
  type SpendRow,
} from "./adminApi";

/**
 * The admin surface: orgs, users, spend, billing, moderation, health and
 * the deletion ledger. Deliberately small -- enough to run the service,
 * not a product surface. Tables plus the few actions that genuinely need
 * doing (suspend, revoke a key, set a budget, close a report), each
 * destructive one behind the confirmation dialog.
 *
 * Reachable only with Zitadel's `admin` role: the registry hides the nav
 * entry from everyone else and the API refuses them on every route, so a
 * deep link by a non-admin shows this notice rather than empty tables.
 */
export function AdminPage() {
  const { principal } = useShell();
  if (!principal.roles.includes("admin")) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pt-6 pb-16 md:px-12 md:pt-11">
          <AdminHeader />
          <EmptyState
            title="Admin is for platform operators"
            description="This surface needs the admin role from the identity provider. Your organisation's own settings are under Settings."
          />
        </div>
      </div>
    );
  }
  return <AdminTabs />;
}

/**
 * The sections, by what an operator is doing: looking someone up, following
 * the money, running the platform, or acting on accounts and content. The
 * side nav reads as these four headings; on a phone the strip is the same
 * list in one row.
 */
const GROUPS = ["People", "Billing", "Platform", "Operations"] as const;
type Group = (typeof GROUPS)[number];

const TABS: readonly { id: string; title: string; group: Group; failure?: string }[] = [
  { id: "orgs", title: "Organisations", group: "People" },
  { id: "users", title: "Users", group: "People" },
  { id: "spend", title: "Spend", group: "Billing" },
  // Whether billing is wired up, what Stripe has sent, and
  // whether the gateway's limits still match the plans.
  { id: "billing", title: "Billing", group: "Billing" },
  // Every org whose payment is late: stage, amount, next step, policy.
  { id: "overdue", title: "Overdue", group: "Billing" },
  // What each plan entitles: limits, name, listing. Prices stay Stripe's.
  { id: "plans", title: "Plans", group: "Billing" },
  // Feature flags: the defaults and the rows that override them, per org.
  { id: "flags", title: "Flags", group: "Platform" },
  // The banner every signed-in user sees: incidents, maintenance, news.
  { id: "announcements", title: "Announcements", group: "Platform" },
  // The CRM: connection, last sync, the outbox and its dead letters, contract events.
  {
    id: "integrations",
    title: "Integrations",
    group: "Platform",
    failure: "The Salesforce status could not be read.",
  },
  // What is deployed, the migration level, and which dependencies answer.
  { id: "health", title: "Health", group: "Platform" },
  // What tonight's retention run would delete, per organisation.
  { id: "retention", title: "Retention", group: "Operations" },
  // The review queue (with the one reported message), recent flags and one account's violation count.
  { id: "moderation", title: "Moderation", group: "Operations" },
  // The ladder: who is warned, rate limited or suspended, and the two actions on it.
  { id: "enforcement", title: "Enforcement", group: "Operations" },
  // Every account deletion and whether the login was removed with it.
  { id: "deletions", title: "Deletions", group: "Operations" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const DEFAULT_TAB: TabId = "orgs";

/** The tab the URL names (`/admin?tab=plans`), or the first one. */
function tabFromUrl(): TabId {
  const named = new URLSearchParams(window.location.search).get("tab");
  return TABS.some((t) => t.id === named) ? (named as TabId) : DEFAULT_TAB;
}

/**
 * The open tab, kept in `?tab=` so a reload or a back to this page lands
 * where the operator was. Replaced rather than pushed: switching tabs is
 * not a navigation worth a back-button step each, and a raw push would sit
 * outside the router's own history entries.
 */
function useTabInUrl(): [TabId, (tab: TabId) => void] {
  const [tab, setTabState] = useState<TabId>(tabFromUrl);
  useEffect(() => {
    const follow = () => setTabState(tabFromUrl());
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);
  const setTab = useCallback((next: TabId) => {
    setTabState(next);
    history.replaceState(history.state, "", `${tabHref(next)}${window.location.hash}`);
  }, []);
  return [tab, setTab];
}

/** This page's URL with `next` as the open tab; the first tab is the bare path. */
function tabHref(next: TabId): string {
  const params = new URLSearchParams(window.location.search);
  if (next === DEFAULT_TAB) params.delete("tab");
  else params.set("tab", next);
  const search = params.toString();
  return `${window.location.pathname}${search ? `?${search}` : ""}`;
}

function AdminTabs() {
  const [tab, setTab] = useTabInUrl();
  // Bumped by a crashed tab's retry, so the tab mounts afresh and refetches.
  const [remount, setRemount] = useState(0);
  const current = TABS.find((t) => t.id === tab)!;
  const title = current.title;
  // App copy for a tab that crashed; the boundary logs the raw error.
  const failure = `${current.failure ?? `The ${title.toLowerCase()} data could not be read.`} Retry.`;

  // Each tab is a link to its own ?tab= URL, so it opens in a new browser
  // tab too; a plain click switches in place.
  const follow = (id: TabId) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    setTab(id);
  };

  // Two layouts of one list, the shape Settings uses: on a phone one row
  // that scrolls sideways under the title; from md up a full-height side
  // column under the four headings, every section visible at once, the
  // selected one in the brand's selected style.
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav
        aria-label="Admin sections"
        data-layout="side"
        className="hidden w-56 shrink-0 overflow-y-auto border-r border-border bg-mw-surface-raised px-3.5 py-5 md:block"
      >
        <div className="flex flex-col gap-5">
          {GROUPS.map((group) => (
            <div key={group} role="group" aria-label={group} className="flex flex-col gap-0.5">
              <p aria-hidden="true" className="px-2.5 pb-1.5 text-xs font-medium text-mw-text-muted">
                {group}
              </p>
              {TABS.filter((t) => t.group === group).map((t) => (
                <NavItem key={t.id} href={tabHref(t.id)} onClick={follow(t.id)} active={tab === t.id}>
                  {t.title}
                </NavItem>
              ))}
            </div>
          ))}
        </div>
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pt-6 pb-16 md:px-12 md:pt-11">
          <AdminHeader description="Every organisation and user on this deployment, what they spend this month, and the switch that stops one." />

          <TabStrip aria-label="Admin sections" className="md:hidden">
            {TABS.map((t) => (
              <TabStripItem key={t.id} active={tab === t.id} href={tabHref(t.id)} onClick={follow(t.id)}>
                {t.title}
              </TabStripItem>
            ))}
          </TabStrip>

          <section aria-labelledby={`admin-panel-${tab}`} data-admin-panel={tab} className="flex min-w-0 flex-col gap-4">
            <h2 id={`admin-panel-${tab}`} className="font-display text-display-sm text-mw-text">
              {title}
            </h2>
            {/* One boundary per tab: a tab that cannot render a malformed
                answer shows its own error, and the nav and every other tab
                keep working. Keyed by tab so switching away clears it. */}
            <ErrorBoundary key={`${tab}-${remount}`} name={title} message={failure} onReset={() => setRemount((n) => n + 1)}>
              <TabPanel tab={tab} />
            </ErrorBoundary>
          </section>
        </div>
      </main>
    </div>
  );
}

/** The page title, in the display face at the size Settings sets its panes. */
function AdminHeader(props: { description?: string }) {
  return (
    <header className="flex flex-col gap-1.5">
      <h1 className="font-display text-display-lg text-mw-text">Admin</h1>
      {props.description && <p className="max-w-2xl text-mw-text-subtle">{props.description}</p>}
    </header>
  );
}

function TabPanel({ tab }: { tab: TabId }) {
  return (
    <>
      {tab === "orgs" && <OrgsTable />}
      {tab === "users" && <UsersTable />}
      {tab === "spend" && <SpendTable />}
      {tab === "billing" && <BillingTab />}
      {tab === "overdue" && <OverdueTab />}
      {tab === "plans" && <PlansTab />}
      {tab === "flags" && <FlagsTab />}
      {tab === "announcements" && <AnnouncementsTab />}
      {tab === "retention" && <RetentionTab />}
      {tab === "moderation" && <ModerationTab />}
      {tab === "enforcement" && <EnforcementTab />}
      {tab === "integrations" && <IntegrationsTab />}
      {tab === "health" && <HealthTab />}
      {tab === "deletions" && <DeletionsTab />}
    </>
  );
}

// --- organisations ------------------------------------------------------------------

/**
 * The org list: searched the way the users table is, and paged by cursor
 * because the list outgrows one screen. A new search replaces the rows;
 * "Load more" appends the next page under the same search. The page is
 * keyed on the search, so an answer for another search is simply not the
 * current one and loading needs no flag of its own; a reload after an
 * action (a budget saved beneath a row) keeps the rows on screen until the
 * fresh page replaces them, so the row's details stay open.
 */
function OrgsTable() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [attempt, setAttempt] = useState(0);
  const searchId = useId();
  const [loaded, setLoaded] = useState<
    | { key: string; rows: AdminOrg[]; cursor: string | null }
    | { key: string; error: string }
    | null
  >(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  // The org whose details (budget, keys, invites) are open beneath its row.
  const [open, setOpen] = useState<string | null>(null);

  const current = loaded !== null && loaded.key === submitted ? loaded : null;
  const rows = current !== null && "rows" in current ? current.rows : null;
  const cursor = current !== null && "rows" in current ? current.cursor : null;

  useEffect(() => {
    let alive = true;
    fetchOrgPage(submitted)
      .then((page) => {
        if (alive) setLoaded({ key: submitted, rows: page.data, cursor: page.next_cursor });
      })
      .catch((err: unknown) => {
        if (alive) setLoaded({ key: submitted, error: failureMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [submitted, attempt]);

  const reload = () => setAttempt((n) => n + 1);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMoreError(null);
    setSubmitted(query);
  }

  async function loadMore() {
    if (cursor === null || rows === null) return;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = await fetchOrgPage(submitted, cursor);
      setLoaded({ key: submitted, rows: [...rows, ...page.data], cursor: page.next_cursor });
    } catch (err) {
      setMoreError(failureMessage(err));
    } finally {
      setMoreBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={handleSearch} className="flex flex-wrap items-end gap-2" role="search">
        <label htmlFor={searchId} className="sr-only">
          Search organisations
        </label>
        <Input
          id={searchId}
          name="q"
          placeholder="Name, identity org, id or owner email"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="max-w-sm"
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {current === null ? (
        <LoadingSkeleton rows={4} />
      ) : "error" in current ? (
        <ErrorState title="Could not load organisations" message={current.error} onRetry={reload} />
      ) : current.rows.length === 0 ? (
        <EmptyState
          title={submitted ? `No organisations match "${submitted}"` : "No organisations yet"}
          description={
            submitted ? "Try part of the name, the id, or an owner's email." : "The first signup creates one."
          }
        />
      ) : (
        <>
          <Table className="bg-card" aria-label="Organisations">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Overage cap</TableHead>
                <TableHead>Tokens used</TableHead>
                <TableHead>Overage</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Identity org</TableHead>
                {/* Pinned to the right edge from md up, so Open and Manage stay
                    in view however far the wide table has to scroll. */}
                <TableHead className="md:sticky md:right-0 md:bg-mw-surface">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {current.rows.map((org: AdminOrg) => (
                <OrgRow
                  key={org.id}
                  org={org}
                  open={open === org.id}
                  onToggle={() => setOpen((opened) => (opened === org.id ? null : org.id))}
                  onChanged={reload}
                />
              ))}
            </TableBody>
          </Table>
          {cursor !== null && (
            <div>
              <Button variant="outline" size="sm" disabled={moreBusy} onClick={() => void loadMore()}>
                {moreBusy ? "Loading…" : "Load more organisations"}
              </Button>
            </div>
          )}
          {moreError && (
            <Alert role="alert" variant="danger">
              {moreError}
            </Alert>
          )}
        </>
      )}
    </div>
  );
}

function OrgRow({
  org,
  open,
  onToggle,
  onChanged,
}: {
  org: AdminOrg;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  // "Open as support": a thirty-minute read-only session scoped to this
  // org, audited at both ends. The whole shell reloads into it, because
  // what the API answers changes with the session (apps/admin/adminApi.ts).
  // It opens only after the dialog has a reason, which the audit row keeps.
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [opening, setOpening] = useState(false);
  const [supportError, setSupportError] = useState<string | null>(null);
  async function openAsSupport() {
    if (!reason.trim()) return;
    setOpening(true);
    setSupportError(null);
    try {
      await startSupport(org.id, reason);
      navigateTo("/apps/chat");
    } catch (err: unknown) {
      setSupportError(failureMessage(err));
      setOpening(false);
      setConfirming(false);
    }
  }
  return (
    <>
      <TableRow>
        <TableCell>
          <span className="font-medium">{org.name}</span>
          <span className="ml-2 font-mono text-xs text-mw-text-muted">{org.id.slice(0, 8)}</span>
        </TableCell>
        <TableCell>{org.members}</TableCell>
        <TableCell>
          {org.overage_cap_micros === 0 ? (
            <Badge variant="outline">plan default</Badge>
          ) : (
            formatMicros(org.overage_cap_micros)
          )}
        </TableCell>
        <TableCell>{org.tokens_used.toLocaleString()}</TableCell>
        <TableCell>{formatMicros(org.overage_micros)}</TableCell>
        <TableCell>{formatDate(org.created_at)}</TableCell>
        <TableCell>
          <IdentityId id={org.zitadel_org_id} label="Copy identity org id" />
        </TableCell>
        <TableCell data-org-actions className="text-right md:sticky md:right-0 md:bg-card">
          <span className="inline-flex flex-col items-end gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={opening}
              onClick={() => {
                setSupportError(null);
                setConfirming(true);
              }}
            >
              Open {org.name} as support
            </Button>
            <Button size="sm" variant="outline" aria-expanded={open} onClick={onToggle}>
              {open ? `Close ${org.name}` : `Manage ${org.name}`}
            </Button>
          </span>
          {supportError && (
            <p role="alert" className="mt-1 text-xs text-mw-danger">
              {supportError}
            </p>
          )}
          <SupportConfirm
            open={confirming}
            orgName={org.name}
            reason={reason}
            onReasonChange={setReason}
            inFlight={opening}
            onCancel={() => setConfirming(false)}
            onConfirm={() => void openAsSupport()}
          />
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={8} className="whitespace-normal px-2 py-3">
            <OrgDetails org={org} onBudgetSaved={onChanged} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// --- users --------------------------------------------------------------------------------

function UsersTable() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const searchId = useId();
  const [state, reload] = useLoad(() => fetchUsers(submitted), submitted);
  // The user a suspend is being confirmed for, and the reason typed so far.
  const [pending, setPending] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(query);
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      setPending(null);
      setReason("");
      reload();
    } catch (err) {
      setActionError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={handleSearch} className="flex flex-wrap items-end gap-2" role="search">
        <label htmlFor={searchId} className="sr-only">
          Search users
        </label>
        <Input
          id={searchId}
          name="q"
          placeholder="Email, name or subject"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="max-w-sm"
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {actionError && (
        <Alert role="alert" variant="danger">
          {actionError}
        </Alert>
      )}
      {state.phase === "loading" ? (
        <LoadingSkeleton rows={4} />
      ) : state.phase === "error" ? (
        <ErrorState title="Could not load users" message={state.message} onRetry={reload} />
      ) : state.data.length === 0 ? (
        <EmptyState
          title={submitted ? `No users match "${submitted}"` : "No users yet"}
          description={submitted ? "Try part of an email or a name." : "The first signup appears here."}
        />
      ) : (
        <Table className="bg-card" aria-label="Users">
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Organisation</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.map((user) => (
              <TableRow key={user.subject} className="border-b border-mw-border">
                <TableCell>
                  <span className="font-medium">{user.email}</span>
                  {user.name && <span className="ml-2 text-mw-text-muted">{user.name}</span>}
                  <div>
                    <IdentityId id={user.subject} label="Copy identity id" />
                  </div>
                </TableCell>
                <TableCell>
                  {user.org_name}
                  {user.role && <span className="ml-2 text-xs text-mw-text-muted">{user.role}</span>}
                </TableCell>
                <TableCell className="whitespace-normal">
                  <StateBadge state={user.state} />
                  {user.suspension_reason && (
                    <div className="text-xs text-mw-text-muted">{user.suspension_reason}</div>
                  )}
                </TableCell>
                <TableCell>{formatDate(user.last_seen_at)}</TableCell>
                <TableCell className="text-right">
                  {user.state === "suspended" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void run(() => unsuspendUser(user.subject))}
                    >
                      Unsuspend {user.email}
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setActionError(null);
                        setReason("");
                        setPending(user);
                      }}
                    >
                      Suspend {user.email}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <DestructiveConfirm
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
        title={pending ? `Suspend ${pending.email}?` : "Suspend this user?"}
        description={
          <span className="flex flex-col gap-2">
            <span>
              Their next request, login or verification is refused until an operator lifts it.
              The reason is kept for the audit trail and never shown to them.
            </span>
            <Input
              aria-label="Reason"
              placeholder="Reason (optional)"
              value={reason}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </span>
        }
        confirmLabel="Suspend"
        inFlight={busy}
        onConfirm={() => {
          if (pending) void run(() => suspendUser(pending.subject, reason));
        }}
      />
    </div>
  );
}

function StateBadge(props: { state: AdminUser["state"] }) {
  if (props.state === "suspended") {
    return (
      <Badge variant="destructive">
        <StatusDot tone="danger" />
        suspended
      </Badge>
    );
  }
  if (props.state === "pending_verification") return <Badge variant="warning">unverified</Badge>;
  return (
    <Badge variant="positive">
      <StatusDot tone="positive" />
      active
    </Badge>
  );
}

// --- spend ------------------------------------------------------------------------------

function SpendTable() {
  const [state, reload] = useLoad(fetchSpend, "spend");
  if (state.phase === "loading") return <LoadingSkeleton rows={4} />;
  if (state.phase === "error") {
    return <ErrorState title="Could not load spend" message={state.message} onRetry={reload} />;
  }
  const { rows, periodStart } = state.data;
  if (rows.length === 0) {
    return <EmptyState title="Nothing spent this month" description={`Usage since ${periodStart} appears here.`} />;
  }
  const total = rows.reduce((sum, row) => sum + row.cost_micros, 0);
  const overage = rows.reduce((sum, row) => sum + row.overage_micros, 0);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-mw-text-muted">
        Since {periodStart}: {formatMicros(total)} at list price, {formatMicros(overage)} of it billed as
        overage, across {rows.length} org/model pairs, from the app's own usage ledger.
      </p>
      <Table className="bg-card" aria-label="Spend">
        <TableHeader>
          <TableRow>
            <TableHead>Organisation</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Turns</TableHead>
            <TableHead>Prompt tokens</TableHead>
            <TableHead>Completion tokens</TableHead>
            <TableHead>Weighted tokens</TableHead>
            <TableHead>At list price</TableHead>
            <TableHead>Overage</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row: SpendRow) => (
            <TableRow key={`${row.org_id}:${row.model}`} className="border-b border-mw-border">
              <TableCell>{row.org_name}</TableCell>
              <TableCell className="font-mono text-xs">{row.model}</TableCell>
              <TableCell>{row.events}</TableCell>
              <TableCell>{row.prompt_tokens.toLocaleString()}</TableCell>
              <TableCell>{row.completion_tokens.toLocaleString()}</TableCell>
              <TableCell>{row.weighted_tokens.toLocaleString()}</TableCell>
              <TableCell>{formatMicros(row.cost_micros)}</TableCell>
              <TableCell>{formatMicros(row.overage_micros)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
