import { useEffect, useId, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Alert, Meter } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button, buttonVariants } from "../../../components/ui/button";
import { CopyButton } from "../../../components/ui/copy-button";
import { Input } from "../../../components/ui/input";
import { SearchInput } from "../../../components/ui/search-input";
import { SimpleSelect } from "../../../components/ui/select";
import { apiFetch } from "../../../lib/api";
import { SEATS_FOLLOW_MEMBERS_NOTE, formatSeats, upgradeRequired } from "../../../lib/billing";
import { DestructiveConfirm, ErrorState, LoadingSkeleton, UpgradePrompt } from "../../../patterns";
import { failureMessage, validateEmail } from "../../../shell/authForms";
import { useShell } from "../../../shell/shellContext";
import { LearnMore, PaneSection } from "../PaneSection";
import { PaneActions } from "../paneActions";
import { Activity, Initials, Row, RowList } from "../rows";

/**
 * Members: who is in the org
 * and with which role, and the invites still out. Shown to every member;
 * the actions follow the caller's ORG role, which the API reports beside
 * the list -- the principal carries only the identity provider's roles,
 * which say nothing about the org (tenancy.md rule 1). The API enforces
 * the same rules on every route, so hiding a control here is courtesy,
 * never the gate.
 */

export type OrgRole = "owner" | "admin" | "member" | "viewer";
const ORG_ROLES: readonly OrgRole[] = ["owner", "admin", "member", "viewer"];

/** What the ownership confirmation makes an owner type. */
const TRANSFER_PHRASE = "transfer ownership";

export interface Member {
  subject: string;
  email: string;
  name: string | null;
  role: OrgRole;
  state: "pending_verification" | "active" | "suspended";
  created_at: string;
  /** When they last used the app; null for someone who never has. */
  last_seen_at: string | null;
}

export interface Invite {
  id: string;
  email: string;
  role: OrgRole;
  invited_by: string;
  created_at: string;
  expires_at: string;
  status: "pending" | "expired" | "accepted" | "revoked";
}

/** A shareable invite link as the API lists it: never its token, which is shown once. */
export interface InviteLink {
  id: string;
  role: Exclude<OrgRole, "owner">;
  max_uses: number;
  uses: number;
  created_by: string;
  created_at: string;
  expires_at: string;
  status: "active" | "expired" | "used_up" | "revoked";
}

/** What creating one returns: the row plus the token and the URL to share. */
export interface CreatedInviteLink extends InviteLink {
  token: string;
  url: string;
}

/**
 * Members plus pending invites against the plan's cap; `max` null is no cap.
 * `billed` is the seats a plan sold per seat bills -- the members alone --
 * and null on any other plan.
 */
export interface Seats {
  used: number;
  max: number | null;
  billed: number | null;
}

interface MembersState {
  members: Member[];
  invites: Invite[];
  /** The caller's own org role. */
  role: OrgRole;
  seats: Seats;
}

async function fetchMembers(): Promise<MembersState> {
  const [members, invites] = await Promise.all([
    apiFetch<{ data: Member[]; role: OrgRole; seats: Seats }>("/api/org/members"),
    apiFetch<{ data: Invite[] }>("/api/org/invites"),
  ]);
  return { members: members.data, invites: invites.data, role: members.role, seats: members.seats };
}

/** The API's rules, mirrored so the pane offers only what will succeed. */
function canManage(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}
function canGrant(actor: OrgRole, role: OrgRole): boolean {
  return canManage(actor) && (role !== "owner" || actor === "owner");
}
function canTouch(actor: OrgRole, target: OrgRole): boolean {
  return canManage(actor) && (target !== "owner" || actor === "owner");
}
const LABEL_CLASS = "text-sm font-medium";

/** A role as a person reads it: "Member", not the API's "member". */
export const ROLE_LABEL: Record<OrgRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

/** What each role can do, said once for the whole pane. */
const ROLE_SUMMARY: Record<OrgRole, string> = {
  owner: "Everything, including billing and handing over ownership.",
  admin: "Members, invites and keys.",
  member: "Uses the app.",
  viewer: "Reads shared work.",
};

/** Where the "Invite people" action at the top of the page takes focus. */
const INVITE_EMAIL_ID = "members-invite-email";

/** Who a subject is to a reader: invites and links carry only the subject. */
type NameOf = (subject: string) => string;

/**
 * The person behind a subject: their name, else their email, else the
 * subject itself for someone no longer listed (a remover who has left).
 */
function namesFrom(members: Member[]): NameOf {
  const bySubject = new Map(members.map((m) => [m.subject, m.name || m.email || m.subject]));
  return (subject) => bySubject.get(subject) ?? subject;
}

/** Only an owner hands the org over, and only to someone who can act on it. */
function canTransferTo(actor: OrgRole, target: Member, self: string): boolean {
  return (
    actor === "owner" && target.subject !== self && target.role !== "owner" && target.state === "active"
  );
}

export function MembersPane() {
  const { principal } = useShell();
  const [state, setState] = useState<
    { phase: "loading" } | { phase: "error"; message: string } | ({ phase: "ready" } & MembersState)
  >({ phase: "loading" });
  // Bumped after every action: the lists are re-read from the API rather
  // than patched locally, so what the pane shows is what the API holds.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchMembers()
      .then((loaded) => {
        if (alive) setState({ phase: "ready", ...loaded });
      })
      .catch((err: unknown) => {
        if (alive) setState({ phase: "error", message: failureMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [generation]);

  if (state.phase === "loading") return <LoadingSkeleton rows={4} />;
  if (state.phase === "error") {
    return <ErrorState title="Could not load members" message={state.message} />;
  }
  const reload = () => setGeneration((n) => n + 1);
  const nameOf = namesFrom(state.members);
  const manager = canManage(state.role);
  const blocked = inviteBlockedReason(state.seats);
  return (
    <div className="flex flex-col gap-7">
      {manager && (
        <PaneActions>
          <Button
            type="button"
            size="lg"
            disabled={blocked !== null}
            onClick={() => {
              const field = document.getElementById(INVITE_EMAIL_ID);
              field?.scrollIntoView({ block: "center", behavior: "smooth" });
              field?.focus({ preventScroll: true });
            }}
          >
            Invite people
          </Button>
        </PaneActions>
      )}
      {blocked && <OverCapacity seats={state.seats} reason={blocked} />}
      <MembersSection
        members={state.members}
        seats={state.seats}
        actor={state.role}
        self={principal.subject}
        onChanged={reload}
      />
      {manager && <InviteSection actor={state.role} seats={state.seats} onChanged={reload} />}
      {manager && <InviteLinkSection nameOf={nameOf} seats={state.seats} />}
      <InvitesSection invites={state.invites} actor={state.role} nameOf={nameOf} onChanged={reload} />
      <RolesSection actor={state.role} />
    </div>
  );
}

/**
 * Over the seat cap: the amber notice with how full the plan is and the
 * one way out, never a red box -- nothing is broken, invites are paused.
 */
function OverCapacity(props: { seats: Seats; reason: string }) {
  const max = props.seats.max ?? props.seats.used;
  return (
    <Alert
      variant="warning"
      role="alert"
      data-testid="over-capacity"
      title={`${props.seats.used} of ${formatSeats(max)} in use`}
      action={
        <Link to="/pricing" className={buttonVariants({ size: "lg" })}>
          Add seats
        </Link>
      }
    >
      <Meter tone="warning" value={max === 0 ? 100 : (props.seats.used / max) * 100} className="my-1.5" />
      <p>{props.reason}</p>
    </Alert>
  );
}

/** The four roles in one line each, in place of a paragraph per section. */
function RolesSection(props: { actor: OrgRole }) {
  return (
    <section aria-labelledby="members-roles" className="flex flex-col gap-3.5">
      <div>
        <h2 id="members-roles" className="font-display text-display-sm">
          Roles
        </h2>
        <p className="mt-1 text-sm text-mw-text-subtle">
          {props.actor === "owner"
            ? "Only an owner hands over ownership."
            : canManage(props.actor)
              ? "You can change roles below owner and remove members."
              : "Ask an owner or admin to change roles or invite people."}
        </p>
      </div>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-3">
        {ORG_ROLES.map((role) => (
          <div key={role} className="rounded-xl border border-border px-4 py-3.5">
            <dt className="font-semibold">{ROLE_LABEL[role]}</dt>
            <dd className="mt-1 text-sm text-mw-text-subtle">{ROLE_SUMMARY[role]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ActionError(props: { message: string | null }) {
  if (!props.message) return null;
  return (
    <p role="alert" className="text-sm text-mw-danger">
      {props.message}
    </p>
  );
}

function useAction(onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The raw error beside its message: a 402 carries which plan has the
  // seats in its headers, and UpgradePrompt renders that; a string cannot.
  const [refusal, setRefusal] = useState<unknown>(null);
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      await action();
      onChanged();
      return true;
    } catch (err) {
      setRefusal(err);
      setError(failureMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, refusal, run };
}

// --- members -----------------------------------------------------------------------------

function seatsLine(seats: Seats): string {
  if (seats.billed !== null) return `${formatSeats(seats.billed)}, billed per seat`;
  const noun = seats.used === 1 ? "seat" : "seats";
  return seats.max === null
    ? `${seats.used} ${noun}, unlimited`
    : `${seats.used} of ${seats.max} ${seats.max === 1 ? "seat" : "seats"}`;
}

/**
 * Why nobody can be invited right now, or null. Over the cap -- a plan
 * moved down under more members than it allows -- the API would refuse
 * every invite, so the forms are switched off and this says why, rather
 * than letting a person fill one in to be told. At the cap exactly the
 * forms stay on: the API's refusal names the plan that has the seats.
 */
export function inviteBlockedReason(seats: Seats): string | null {
  if (seats.max === null || seats.used <= seats.max) return null;
  return `Over capacity: ${seats.used} ${seats.used === 1 ? "seat" : "seats"} are taken on a plan with ${formatSeats(seats.max)}. Remove a member or upgrade before inviting anyone.`;
}

/** The sole owner cannot leave or step down; ownership has to be handed over first. */
function isSoleOwner(member: Member, members: Member[]): boolean {
  return member.role === "owner" && members.filter((m) => m.role === "owner").length === 1;
}

type MemberAction = { kind: "remove"; member: Member } | { kind: "transfer"; member: Member };

type MemberSort = "name" | "last_active";

/**
 * The list as shown: filtered on email, name or role (case-insensitive,
 * the whole list is already loaded), then sorted by name -- the email
 * standing in for a missing one -- or most recently active first, with
 * those never seen last so idle seats gather at the bottom.
 */
function visibleMembers(members: Member[], query: string, sort: MemberSort): Member[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? members.filter((m) =>
        [m.email, m.name ?? "", m.role].some((field) => field.toLowerCase().includes(needle)),
      )
    : members;
  const byName = (a: Member, b: Member) =>
    (a.name ?? a.email).localeCompare(b.name ?? b.email, undefined, { sensitivity: "base" });
  return [...matched].sort((a, b) => {
    if (sort === "last_active") {
      const at = a.last_seen_at ? Date.parse(a.last_seen_at) : -Infinity;
      const bt = b.last_seen_at ? Date.parse(b.last_seen_at) : -Infinity;
      if (at !== bt) return bt > at ? 1 : -1;
    }
    return byName(a, b);
  });
}

function MembersSection(props: {
  members: Member[];
  seats: Seats;
  actor: OrgRole;
  self: string;
  onChanged: () => void;
}) {
  const shell = useShell();
  const { busy, error, run } = useAction(props.onChanged);
  const [pending, setPending] = useState<MemberAction | null>(null);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<MemberSort>("name");
  const shown = visibleMembers(props.members, query, sort);

  function open(action: MemberAction) {
    setTyped("");
    setPending(action);
  }

  async function remove(member: Member) {
    const done = await run(() =>
      apiFetch(`/api/org/members/${encodeURIComponent(member.subject)}`, { method: "DELETE" }),
    );
    if (!done) return;
    setPending(null);
    // Leaving suspended this account (the API says why), so the next
    // request would be refused anyway; end the session cleanly instead.
    if (member.subject === props.self) await shell.signOut();
  }

  async function transfer(member: Member) {
    const done = await run(() =>
      apiFetch(`/api/org/members/${encodeURIComponent(member.subject)}/transfer-ownership`, {
        method: "POST",
      }),
    );
    if (done) setPending(null);
  }

  const leaving = pending?.kind === "remove" && pending.member.subject === props.self;

  const people = `${props.members.length} ${props.members.length === 1 ? "person" : "people"}`;
  const seatMax = props.seats.max;
  return (
    <PaneSection
      title={people}
      flush
      description={
        <span className="flex flex-col gap-1.5">
          <span data-testid="seats">
            {seatsLine(props.seats)}
            <span className="ml-1">
              {props.seats.billed !== null ? `· ${SEATS_FOLLOW_MEMBERS_NOTE}` : "· members and pending invites"}
            </span>
          </span>
          {seatMax !== null && seatMax > 0 && props.seats.used <= seatMax && (
            <Meter value={(props.seats.used / seatMax) * 100} className="max-w-60" />
          )}
        </span>
      }
      actions={
        <>
          <SearchInput
            aria-label="Filter members"
            placeholder="Filter"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            wrapperClassName="w-44"
          />
          <SimpleSelect
            aria-label="Sort members"
            value={sort}
            onValueChange={setSort}
            options={[
              { value: "name", label: "Sort by name" },
              { value: "last_active", label: "Sort by last active" },
            ]}
          />
        </>
      }
    >
      {/* An empty organisation and a filter that missed are different
          news: the second names the filter so it can be corrected. */}
      {shown.length === 0 && (
        <p className="px-5 py-4 text-sm text-mw-text-muted">
          {props.members.length === 0 ? "No members yet." : `No members match "${query.trim()}".`}
        </p>
      )}
      <RowList aria-label="Members">
        {shown.map((member) => {
          const isSelf = member.subject === props.self;
          // The only owner has nowhere to go: no Leave, no role to pick,
          // until ownership is transferred (the button on another row).
          const pinned = isSelf && isSoleOwner(member, props.members);
          const editable = canTouch(props.actor, member.role) && !pinned;
          return (
            <Row
              key={member.subject}
              leading={<Initials name={member.name || member.email} />}
              title={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {member.name ? (
                    <span>{member.name}</span>
                  ) : (
                    <span data-testid="member-email" className="break-all">
                      {member.email}
                    </span>
                  )}
                  {isSelf && <Badge variant="secondary">You</Badge>}
                  {member.state !== "active" && (
                    <Badge variant={member.state === "suspended" ? "destructive" : "outline"}>
                      {member.state === "suspended" ? "Suspended" : "Unverified"}
                    </Badge>
                  )}
                </span>
              }
              meta={
                <>
                  {member.name && (
                    <>
                      <span data-testid="member-email" className="break-all">
                        {member.email}
                      </span>
                      {" · "}
                    </>
                  )}
                  <Activity iso={member.last_seen_at} data-testid="last-active" />
                </>
              }
              extra={
                pinned && (
                  <span data-testid="sole-owner" className="text-xs text-mw-text-muted">
                    The only owner. Transfer ownership to someone before leaving or changing your role.
                  </span>
                )
              }
              trailing={
                <>
                  {editable ? (
                    <SimpleSelect
                      aria-label={`Role of ${member.email}`}
                      value={member.role}
                      disabled={busy}
                      onValueChange={(role) =>
                        void run(() =>
                          apiFetch(`/api/org/members/${encodeURIComponent(member.subject)}/role`, {
                            method: "PUT",
                            json: { role },
                          }),
                        )
                      }
                      options={ORG_ROLES.filter(
                        (role) => canGrant(props.actor, role) || role === member.role,
                      ).map((role) => ({ value: role, label: ROLE_LABEL[role] }))}
                    />
                  ) : (
                    <span className="text-sm text-mw-text-secondary">{ROLE_LABEL[member.role]}</span>
                  )}
                  {/* Short words on the button, the person in its name: the
                      email is already on the row, and repeating it wraps the
                      row on a phone. */}
                  {canTransferTo(props.actor, member, props.self) && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Transfer ownership to ${member.email}`}
                      onClick={() => open({ kind: "transfer", member })}
                    >
                      Transfer ownership
                    </Button>
                  )}
                  {(editable || isSelf) && !pinned && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      aria-label={isSelf ? undefined : `Remove ${member.email}`}
                      onClick={() => open({ kind: "remove", member })}
                    >
                      {isSelf ? "Leave" : "Remove"}
                    </Button>
                  )}
                </>
              }
            />
          );
        })}
      </RowList>
      {error && (
        <div className="px-5 pb-4">
          <ActionError message={error} />
        </div>
      )}
      <DestructiveConfirm
        open={pending?.kind === "remove"}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
        title={
          leaving
            ? "Leave this organisation?"
            : pending?.kind === "remove"
              ? `Remove ${pending.member.email}?`
              : "Remove this member?"
        }
        description={
          leaving
            ? "Leaving deactivates your account and signs you out: this email address stays attached to this organisation and cannot sign in again. To use MatterWave afterwards, sign up with a different address to start a new organisation, or ask an operator to restore this account."
            : "Their access ends on their next request: the account is suspended, not only unlisted. An operator can restore it."
        }
        confirmLabel={leaving ? "Leave and deactivate my account" : "Remove member"}
        onConfirm={() => {
          if (pending?.kind === "remove") void remove(pending.member);
        }}
        inFlight={busy}
      />
      <DestructiveConfirm
        open={pending?.kind === "transfer"}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
        title={
          pending?.kind === "transfer"
            ? `Transfer ownership to ${pending.member.email}?`
            : "Transfer ownership?"
        }
        description="They become an owner and you become an admin, in one step. Only they can hand it back."
        confirmLabel="Transfer ownership"
        confirmPhrase={TRANSFER_PHRASE}
        typedValue={typed}
        onTypedValueChange={setTyped}
        onConfirm={() => {
          // The dialog disables the button until the phrase matches, so a
          // confirm without it is a bug, not a decision.
          if (pending?.kind === "transfer" && typed.trim().toLowerCase() === TRANSFER_PHRASE) {
            void transfer(pending.member);
          }
        }}
        inFlight={busy}
      />
    </PaneSection>
  );
}

// --- invites -----------------------------------------------------------------------------

type MailResult = { mail: "sent" | "failed"; detail?: string };

function InviteSection(props: { actor: OrgRole; seats: Seats; onChanged: () => void }) {
  const { busy, error, refusal, run } = useAction(props.onChanged);
  const blocked = inviteBlockedReason(props.seats);
  const [notice, setNotice] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const emailErrorId = useId();
  const roleId = useId();
  const [role, setRole] = useState<OrgRole>("member");

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    // An empty submit used to do nothing at all; say what the field needs.
    // The address is someone else's, so not validateEmail's "your".
    const problem = email === "" ? "Enter an email address." : validateEmail(email);
    setEmailError(problem ?? null);
    if (problem) {
      (form.elements.namedItem("email") as HTMLInputElement | null)?.focus();
      return;
    }
    setNotice(null);
    const done = await run(async () => {
      const created = await apiFetch<Invite & MailResult>("/api/org/invites", {
        method: "POST",
        json: { email, role },
      });
      setNotice(
        created.mail === "sent"
          ? `Invitation sent to ${created.email}.`
          : (created.detail ?? "The invite was created but the mail could not be sent."),
      );
    });
    if (done) {
      form.reset();
      setRole("member");
    }
  }

  return (
    <PaneSection
      title="Invite someone"
      description={
        <>
          A one-time link by email, valid for seven days.
          <LearnMore className="mt-1">
            <p>An address that already has an account elsewhere cannot join: one account, one organisation.</p>
          </LearnMore>
        </>
      }
    >
      {/* Why the form is off is said once, in the alert above the list. */}
      <form
        noValidate
        aria-busy={busy}
        aria-disabled={blocked ? true : undefined}
        onSubmit={(event) => void handleInvite(event)}
        className="flex flex-wrap items-end gap-2"
      >
        <fieldset disabled={blocked !== null} className="contents">
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <label htmlFor={INVITE_EMAIL_ID} className={LABEL_CLASS}>
            Email
          </label>
          <Input
            id={INVITE_EMAIL_ID}
            name="email"
            type="email"
            autoComplete="off"
            placeholder="name@example.com"
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? emailErrorId : undefined}
            onChange={() => setEmailError(null)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={roleId} className={LABEL_CLASS}>
            Role
          </label>
          <SimpleSelect
            id={roleId}
            name="role"
            value={role}
            onValueChange={setRole}
            disabled={blocked !== null}
            options={ORG_ROLES.filter((r) => canGrant(props.actor, r)).map((r) => ({
              value: r,
              label: ROLE_LABEL[r],
            }))}
          />
        </div>
        <Button type="submit" disabled={busy || blocked !== null}>
          Send invite
        </Button>
        </fieldset>
        {emailError && (
          <p id={emailErrorId} role="alert" className="basis-full text-sm text-mw-danger">
            {emailError}
          </p>
        )}
      </form>
      {notice && (
        <p role="status" className="mt-2 text-sm text-mw-text-muted">
          {notice}
        </p>
      )}
      {/* A seat refusal is an upgrade path, not an error: the prompt names
          the plan that has room, so the prose is not repeated as an alert. */}
      <UpgradePrompt error={refusal} className="mt-2" />
      <ActionError message={upgradeRequired(refusal) ? null : error} />
    </PaneSection>
  );
}

function InvitesSection(props: {
  invites: Invite[];
  actor: OrgRole;
  nameOf: NameOf;
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction(props.onChanged);
  // The last resend's outcome, by invite: the list reloads after every
  // action, so the row cannot carry it.
  const [resent, setResent] = useState<{ id: string; message: string } | null>(null);
  // The invite a revoke is waiting on: the link in their inbox stops
  // working, so it is confirmed rather than one stray click.
  const [revoking, setRevoking] = useState<Invite | null>(null);

  async function revoke(invite: Invite) {
    const done = await run(() =>
      apiFetch(`/api/org/invites/${encodeURIComponent(invite.id)}`, { method: "DELETE" }),
    );
    if (done) setRevoking(null);
  }

  async function resend(invite: Invite) {
    setResent(null);
    await run(async () => {
      const result = await apiFetch<Invite & MailResult>(
        `/api/org/invites/${encodeURIComponent(invite.id)}/resend`,
        { method: "POST" },
      );
      setResent({
        id: invite.id,
        message:
          result.mail === "sent"
            ? `Invitation re-sent to ${result.email}.`
            : (result.detail ?? "The link was renewed but the mail could not be sent."),
      });
    });
  }

  return (
    <PaneSection
      title="Pending invites"
      flush
      description="Resending renews the link for seven days; the earlier mail stops working."
    >
      {props.invites.length === 0 ? (
        <p className="px-5 py-4 text-sm text-mw-text-muted">No invites yet.</p>
      ) : (
        <RowList aria-label="Pending invites">
          {props.invites.map((invite) => (
            <Row
              key={invite.id}
              leading={<Initials name={invite.email} />}
              title={<span className="break-all font-normal">{invite.email}</span>}
              meta={
                <>
                  as {ROLE_LABEL[invite.role]} · invited by {props.nameOf(invite.invited_by)}
                  {invite.status === "expired"
                    ? " · expired"
                    : ` · expires ${new Date(invite.expires_at).toLocaleDateString()}`}
                </>
              }
              extra={
                resent?.id === invite.id && (
                  <p role="status" className="text-xs text-mw-text-muted">
                    {resent.message}
                  </p>
                )
              }
              trailing={
                canManage(props.actor) && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Resend to ${invite.email}`}
                      onClick={() => void resend(invite)}
                    >
                      Resend
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Revoke invite to ${invite.email}`}
                      onClick={() => setRevoking(invite)}
                    >
                      Revoke
                    </Button>
                  </>
                )
              }
            />
          ))}
        </RowList>
      )}
      {error && (
        <div className="px-5 pb-4">
          <ActionError message={error} />
        </div>
      )}
      <DestructiveConfirm
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRevoking(null);
        }}
        title={revoking ? `Revoke the invite to ${revoking.email}?` : "Revoke this invite?"}
        description="The link in their email stops working. You can invite them again later."
        confirmLabel="Revoke invite"
        onConfirm={() => {
          if (revoking) void revoke(revoking);
        }}
        inFlight={busy}
      />
    </PaneSection>
  );
}

// --- invite links ------------------------------------------------------------------------

/** Ownership is never handed out by link; the API refuses it. */
const LINK_ROLES: readonly InviteLink["role"][] = ["admin", "member", "viewer"];
const LINK_DAYS = ["1", "7", "14", "30"] as const;
const LINK_STATUS: Record<Exclude<InviteLink["status"], "active">, string> = {
  expired: "expired",
  used_up: "used up",
  revoked: "revoked",
};

function linkLine(link: InviteLink, nameOf: NameOf): string {
  const uses = `${link.uses} of ${link.max_uses} ${link.max_uses === 1 ? "use" : "uses"}`;
  const state =
    link.status === "active"
      ? `expires ${new Date(link.expires_at).toLocaleDateString()}`
      : LINK_STATUS[link.status];
  return `${uses} · ${state} · made by ${nameOf(link.created_by)}`;
}

/**
 * The shareable invite: one link for whoever holds it, bounded by uses and
 * days. Managers only -- the API lists links to them alone, since a link
 * admits whoever reads it. The URL is shown once, right after it is made:
 * the API keeps only its hash, so a lost link is revoked and replaced.
 * Loads on its own, so a failure here leaves the rest of the pane working.
 */
function InviteLinkSection(props: { nameOf: NameOf; seats: Seats }) {
  const blocked = inviteBlockedReason(props.seats);
  const [links, setLinks] = useState<InviteLink[] | null>(null);
  const [revoking, setRevoking] = useState<InviteLink | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [created, setCreated] = useState<CreatedInviteLink | null>(null);
  const { busy, error, refusal, run } = useAction(() => setGeneration((n) => n + 1));
  const roleId = useId();
  const usesId = useId();
  const daysId = useId();
  const urlId = useId();
  const [linkRole, setLinkRole] = useState<InviteLink["role"]>("member");
  const [linkDays, setLinkDays] = useState<(typeof LINK_DAYS)[number]>("7");

  useEffect(() => {
    let alive = true;
    apiFetch<{ data: InviteLink[] }>("/api/org/invite-links")
      .then((loaded) => {
        if (!alive) return;
        setLinks(loaded.data);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [generation]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const role = linkRole;
    const maxUses = Number(data.get("max_uses") ?? 10);
    const days = Number(linkDays);
    setCreated(null);
    await run(async () => {
      const made = await apiFetch<CreatedInviteLink>("/api/org/invite-links", {
        method: "POST",
        json: { role, max_uses: maxUses, expires_in_days: days },
      });
      setCreated(made);
    });
  }

  async function revoke(link: InviteLink) {
    const done = await run(async () => {
      await apiFetch(`/api/org/invite-links/${encodeURIComponent(link.id)}`, { method: "DELETE" });
      if (created?.id === link.id) setCreated(null);
    });
    if (done) setRevoking(null);
  }

  return (
    <PaneSection
      title="Invite link"
      description={
        <>
          One link for a whole team, until its uses run out or it expires.
          <LearnMore className="mt-1">
            <p>
              Anyone who has it can join with the role you pick. Copy it now; it is shown only once. Revoke it
              once it has done its job.
            </p>
          </LearnMore>
        </>
      }
    >
      <form
        noValidate
        aria-label="Create an invite link"
        aria-busy={busy}
        aria-disabled={blocked ? true : undefined}
        onSubmit={(event) => void handleCreate(event)}
        className="flex flex-wrap items-end gap-2"
      >
        <fieldset disabled={blocked !== null} className="contents">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={roleId} className={LABEL_CLASS}>
            Role
          </label>
          <SimpleSelect
            id={roleId}
            name="link_role"
            value={linkRole}
            onValueChange={setLinkRole}
            disabled={blocked !== null}
            options={LINK_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={usesId} className={LABEL_CLASS}>
            Max uses
          </label>
          <Input id={usesId} name="max_uses" type="number" min={1} max={500} defaultValue={10} className="w-24" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={daysId} className={LABEL_CLASS}>
            Expires after
          </label>
          <SimpleSelect
            id={daysId}
            name="expires_in_days"
            value={linkDays}
            onValueChange={setLinkDays}
            disabled={blocked !== null}
            options={LINK_DAYS.map((days) => ({ value: days, label: days === "1" ? "1 day" : `${days} days` }))}
          />
        </div>
        <Button type="submit" disabled={busy || blocked !== null}>
          Create link
        </Button>
        </fieldset>
      </form>
      {created && (
        <div data-testid="new-invite-link" className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor={urlId} className="sr-only">
            Invite link
          </label>
          <Input
            id={urlId}
            readOnly
            value={created.url}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-64 flex-1 font-mono text-xs"
          />
          <CopyButton text={created.url} label="Copy link" size="default" />
        </div>
      )}
      <UpgradePrompt error={refusal} className="mt-2" />
      <ActionError message={upgradeRequired(refusal) ? null : error} />
      {loadError ? (
        <ActionError message={loadError} />
      ) : links === null ? null : links.length === 0 ? (
        <p className="mt-3 text-sm text-mw-text-muted">No invite links out.</p>
      ) : (
        <ul className="mt-4 -mx-5 -mb-4 divide-y divide-border border-t border-border" aria-label="Invite links">
          {links.map((link) => (
            <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">as {ROLE_LABEL[link.role]}</span>
                <span className="text-sm text-mw-text-muted">{linkLine(link, props.nameOf)}</span>
              </div>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setRevoking(link)}>
                Revoke link
              </Button>
            </li>
          ))}
        </ul>
      )}
      <DestructiveConfirm
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRevoking(null);
        }}
        title="Revoke this invite link?"
        description={
          revoking
            ? `Nobody else can join with it, including anyone it was sent to who has not used it yet. ${linkLine(revoking, props.nameOf)}.`
            : undefined
        }
        confirmLabel="Revoke link"
        onConfirm={() => {
          if (revoking) void revoke(revoking);
        }}
        inFlight={busy}
      />
    </PaneSection>
  );
}
