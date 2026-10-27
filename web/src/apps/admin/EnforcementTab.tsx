import { useId, useState, type FormEvent } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SimpleSelect } from "../../components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
import { failureMessage } from "../../shell/authForms";
import { formatDate } from "./adminApi";
import {
  applyEnforcement,
  fetchActiveEnforcement,
  fetchEnforcement,
  LADDER,
  LADDER_LABEL,
  liftEnforcement,
  type EnforcementAction,
  type LadderState,
  type TargetKind,
} from "./enforcementApi";
import { shortId, useLoad } from "./useLoad";

/**
 * The enforcement ladder as the operator works it: everything in force,
 * one target's state and history, and the two actions -- apply a state,
 * lift it -- each with a reason written first.
 *
 * The reason field is the text the person will read in their banner, and
 * the form says so above it; the notes field is the operator's own. Nothing
 * on this tab shows message text, because nothing in the ladder's table has
 * any: evidence is report and flag ids.
 *
 * Suspension stays a deliberate step: the state picker lists it last, and
 * the API refuses an expiry on it, so the form hides that field.
 */
export function EnforcementTab() {
  const [target, setTarget] = useState<{ kind: TargetKind; id: string } | null>(null);
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((n) => n + 1);
  return (
    <div className="space-y-8">
      <ActiveList version={version} onPick={(kind, id) => setTarget({ kind, id })} />
      <TargetPanel target={target} onTargetChange={setTarget} version={version} onChanged={changed} />
    </div>
  );
}

function ActiveList({ version, onPick }: { version: number; onPick: (kind: TargetKind, id: string) => void }) {
  const [state, reload] = useLoad(fetchActiveEnforcement, `active-${version}`);
  return (
    <section aria-labelledby="enforcement-active">
      <h3 id="enforcement-active" className="text-sm font-medium text-mw-text">
        In force now
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        Every account and organisation currently on the ladder, newest first. A rate limit ends on
        its own; a warning or a suspension ends when someone lifts it below.
      </p>
      <div className="mt-3">
        {state.phase === "loading" ? (
          <LoadingSkeleton rows={3} />
        ) : state.phase === "error" ? (
          <ErrorState title="Could not load enforcement" message={state.message} onRetry={reload} />
        ) : state.data.length === 0 ? (
          <EmptyState title="Nothing in force" description="No account or organisation is warned, rate limited or suspended." />
        ) : (
          <Table className="bg-card" aria-label="Enforcement in force">
            <TableHeader>
              <TableRow>
                <TableHead>Since</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Ends</TableHead>
                <TableHead>By</TableHead>
                <TableHead>
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data.map((row) => (
                <TableRow key={row.id} className="border-b border-mw-border">
                  <TableCell>{formatDate(row.created_at)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    <span className="text-mw-text-muted">{row.target_kind} </span>
                    {row.target}
                  </TableCell>
                  <TableCell>
                    <StateBadge state={row.state} />
                  </TableCell>
                  <TableCell className="max-w-md whitespace-normal">{row.reason}</TableCell>
                  <TableCell>{row.expires_at ? formatDate(row.expires_at) : "When lifted"}</TableCell>
                  <TableCell className="font-mono text-xs text-mw-text-muted">{row.actor_subject}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => onPick(row.target_kind, row.target)}>
                      Open {row.target}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

function StateBadge({ state }: { state: LadderState }) {
  return <Badge variant={state === "suspended" ? "destructive" : "warning"}>{LADDER_LABEL[state]}</Badge>;
}

function TargetPanel({
  target,
  onTargetChange,
  version,
  onChanged,
}: {
  target: { kind: TargetKind; id: string } | null;
  onTargetChange: (target: { kind: TargetKind; id: string }) => void;
  version: number;
  onChanged: () => void;
}) {
  const inputId = useId();
  const [kind, setKind] = useState<TargetKind>("user");
  const [draft, setDraft] = useState("");
  const [state, reload] = useLoad(
    () => (target ? fetchEnforcement(target.kind, target.id) : Promise.resolve(null)),
    target ? `${target.kind}:${target.id}:${version}` : null,
  );

  function lookUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.trim()) onTargetChange({ kind, id: draft.trim() });
  }

  return (
    <section aria-labelledby="enforcement-target">
      <h3 id="enforcement-target" className="text-sm font-medium text-mw-text">
        One account or organisation
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        Look up a subject or an organisation id to see its state and history, move it up or down
        the ladder, or lift what is in force. Every step needs a reason, and the reason is what the
        person reads.
      </p>
      <form onSubmit={lookUp} className="mt-3 flex flex-wrap items-end gap-2" role="search">
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${inputId}-kind`}>Kind</label>
          <SimpleSelect<TargetKind>
            id={`${inputId}-kind`}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "user", label: "User (subject)" },
              { value: "org", label: "Organisation (id)" },
            ]}
          />
        </div>
        <label htmlFor={inputId} className="sr-only">
          Target
        </label>
        <Input
          id={inputId}
          name="target"
          placeholder={kind === "user" ? "Subject" : "Organisation id"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="max-w-sm font-mono text-xs"
        />
        <Button type="submit" variant="outline">
          Look up
        </Button>
      </form>
      {target && (
        <div className="mt-4 space-y-4">
          {state.phase === "loading" ? (
            <LoadingSkeleton rows={2} />
          ) : state.phase === "error" ? (
            <ErrorState title={`Could not look up ${target.id}`} message={state.message} onRetry={reload} />
          ) : state.data ? (
            <>
              <CurrentState target={target} current={state.data.current} onChanged={onChanged} />
              <ApplyForm target={target} current={state.data.current} onChanged={onChanged} />
              <History rows={state.data.history} />
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

function CurrentState({
  target,
  current,
  onChanged,
}: {
  target: { kind: TargetKind; id: string };
  current: EnforcementAction | null;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await liftEnforcement(target.kind, target.id, reason.trim());
      setReason("");
      onChanged();
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded-xl border border-border bg-card p-5"
      aria-label={`Current state of ${target.kind} ${target.id}`}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-mw-text-muted">Target</dt>
        <dd className="font-mono text-xs">
          {target.kind} {target.id}
        </dd>
        <dt className="text-mw-text-muted">State</dt>
        <dd>{current ? <StateBadge state={current.state} /> : <span>None</span>}</dd>
        {current && (
          <>
            <dt className="text-mw-text-muted">Reason shown</dt>
            <dd className="whitespace-normal">{current.reason}</dd>
            {current.notes && (
              <>
                <dt className="text-mw-text-muted">Notes</dt>
                <dd className="whitespace-normal">{current.notes}</dd>
              </>
            )}
            <dt className="text-mw-text-muted">Since</dt>
            <dd>
              {formatDate(current.created_at)} by <span className="font-mono text-xs">{current.actor_subject}</span>
            </dd>
            <dt className="text-mw-text-muted">Ends</dt>
            <dd>{current.expires_at ? formatDate(current.expires_at) : "When lifted"}</dd>
            {current.evidence.length > 0 && (
              <>
                <dt className="text-mw-text-muted">Evidence</dt>
                <dd className="font-mono text-xs">{current.evidence.map(shortId).join(", ")}</dd>
              </>
            )}
          </>
        )}
      </dl>
      {current && (
        <form onSubmit={lift} className="mt-3 flex flex-wrap items-end gap-2" aria-label="Lift">
          <Input
            aria-label="Reason for lifting"
            placeholder="Why it ends now, in your words"
            value={reason}
            maxLength={2000}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            className="max-w-md"
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy || !reason.trim()}>
            Lift {LADDER_LABEL[current.state].toLowerCase()}
          </Button>
          {error && (
            <p role="alert" className="w-full text-xs text-mw-danger">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

function ApplyForm({
  target,
  current,
  onChanged,
}: {
  target: { kind: TargetKind; id: string };
  current: EnforcementAction | null;
  onChanged: () => void;
}) {
  const id = useId();
  const [state, setState] = useState<LadderState>("warned");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [hours, setHours] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = Number(hours);
      await applyEnforcement(target.kind, target.id, {
        state,
        reason: reason.trim(),
        notes: notes.trim() || null,
        expires_in_hours: state !== "suspended" && hours.trim() && parsed > 0 ? parsed : null,
      });
      setReason("");
      setNotes("");
      setHours("");
      onChanged();
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={apply}
      aria-label={current ? "Change state" : "Apply a state"}
      className="space-y-3 rounded-xl border border-border bg-card p-5"
    >
      <h4 className="text-sm font-medium text-mw-text">{current ? "Move on the ladder" : "Apply a state"}</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${id}-state`}>State</label>
          <SimpleSelect<LadderState>
            id={`${id}-state`}
            value={state}
            disabled={busy}
            onValueChange={setState}
            options={LADDER.map((s) => ({ value: s, label: LADDER_LABEL[s] }))}
            className="w-full"
          />
        </div>
        {state !== "suspended" ? (
          <label htmlFor={`${id}-hours`} className="flex flex-col gap-1 text-sm">
            Ends in hours{state === "rate_limited" ? " (empty: the configured default)" : " (empty: when lifted)"}
            <Input
              id={`${id}-hours`}
              type="number"
              min={1}
              step={1}
              value={hours}
              disabled={busy}
              onChange={(event) => setHours(event.target.value)}
            />
          </label>
        ) : (
          <p className="self-end text-xs text-mw-text-muted">
            A suspension ends when a person lifts it. Sign-in and every request are refused meanwhile.
          </p>
        )}
      </div>
      <label htmlFor={`${id}-reason`} className="flex flex-col gap-1 text-sm">
        Reason, shown to the person
        <Input
          id={`${id}-reason`}
          aria-label="Reason shown to the person"
          value={reason}
          maxLength={2000}
          required
          disabled={busy}
          placeholder="What was seen and what to do differently"
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <label htmlFor={`${id}-notes`} className="flex flex-col gap-1 text-sm">
        Notes, for operators only
        <Input
          id={`${id}-notes`}
          value={notes}
          maxLength={4000}
          disabled={busy}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant={state === "suspended" ? "destructive" : "default"} disabled={busy || !reason.trim()}>
          {state === "suspended" ? "Suspend" : `Apply ${LADDER_LABEL[state].toLowerCase()}`}
        </Button>
        {error && (
          <p role="alert" className="text-xs text-mw-danger">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

function History({ rows }: { rows: EnforcementAction[] }) {
  if (rows.length === 0) return null;
  return (
    <Table className="bg-card" aria-label="Enforcement history">
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead>By</TableHead>
          <TableHead>Ended</TableHead>
          <TableHead>Appeal</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} className="border-b border-mw-border">
            <TableCell>{formatDate(row.created_at)}</TableCell>
            <TableCell>
              <StateBadge state={row.state} />
            </TableCell>
            <TableCell className="max-w-md whitespace-normal">{row.reason}</TableCell>
            <TableCell className="font-mono text-xs text-mw-text-muted">{row.actor_subject}</TableCell>
            <TableCell className="whitespace-normal text-mw-text-muted">
              {row.lifted_at
                ? `${formatDate(row.lifted_at)} by ${row.lifted_by ?? "—"}: ${row.lift_reason ?? ""}`
                : row.expires_at
                  ? `Expires ${formatDate(row.expires_at)}`
                  : "In force"}
            </TableCell>
            <TableCell className="text-mw-text-muted">{row.appeal_state === "none" ? "—" : row.appeal_state}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
