import { useId, useState, type FormEvent } from "react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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
  const { t } = useLingui();
  const [state, reload] = useLoad(fetchActiveEnforcement, `active-${version}`);
  return (
    <section aria-labelledby="enforcement-active">
      <h3 id="enforcement-active" className="text-sm font-medium text-mw-text">
        <Trans>In force now</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>
          Every account and organisation currently on the ladder, newest first. A rate limit ends on its own; a
          warning or a suspension ends when someone lifts it below.
        </Trans>
      </p>
      <div className="mt-3">
        {state.phase === "loading" ? (
          <LoadingSkeleton rows={3} />
        ) : state.phase === "error" ? (
          <ErrorState title={t`Could not load enforcement`} message={state.message} onRetry={reload} />
        ) : state.data.length === 0 ? (
          <EmptyState
            title={t`Nothing in force`}
            description={t`No account or organisation is warned, rate limited or suspended.`}
          />
        ) : (
          <Table className="bg-card" aria-label={t`Enforcement in force`}>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Trans>Since</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Target</Trans>
                </TableHead>
                <TableHead>
                  <Trans>State</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Reason</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Ends</Trans>
                </TableHead>
                <TableHead>
                  <Trans>By</Trans>
                </TableHead>
                <TableHead>
                  <span className="sr-only">
                    <Trans>Open</Trans>
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data.map((row) => {
                const rowTarget = row.target;
                return (
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
                  <TableCell>{row.expires_at ? formatDate(row.expires_at) : t`When lifted`}</TableCell>
                  <TableCell className="font-mono text-xs text-mw-text-muted">{row.actor_subject}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => onPick(row.target_kind, row.target)}>
                      <Trans>Open {rowTarget}</Trans>
                    </Button>
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

function StateBadge({ state }: { state: LadderState }) {
  const { i18n } = useLingui();
  return <Badge variant={state === "suspended" ? "destructive" : "warning"}>{i18n._(LADDER_LABEL[state])}</Badge>;
}

/** The lift button, per state: "Lift" and the state as one phrase. */
const LIFT_LABEL: Record<LadderState, MessageDescriptor> = {
  warned: msg`Lift warned`,
  rate_limited: msg`Lift rate limited`,
  suspended: msg`Lift suspended`,
};

/** The apply button for the states that are not a suspension. */
const APPLY_LABEL: Record<LadderState, MessageDescriptor> = {
  warned: msg`Apply warned`,
  rate_limited: msg`Apply rate limited`,
  suspended: msg`Suspend`,
};

const APPEAL_LABEL: Record<Exclude<EnforcementAction["appeal_state"], "none">, MessageDescriptor> = {
  received: msg`received`,
  upheld: msg`upheld`,
  overturned: msg`overturned`,
};

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
  const { t } = useLingui();
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

  const targetId = target?.id ?? "";
  return (
    <section aria-labelledby="enforcement-target">
      <h3 id="enforcement-target" className="text-sm font-medium text-mw-text">
        <Trans>One account or organisation</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>
          Look up a subject or an organisation id to see its state and history, move it up or down the ladder, or
          lift what is in force. Every step needs a reason, and the reason is what the person reads.
        </Trans>
      </p>
      <form onSubmit={lookUp} className="mt-3 flex flex-wrap items-end gap-2" role="search">
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${inputId}-kind`}>
            <Trans>Kind</Trans>
          </label>
          <SimpleSelect<TargetKind>
            id={`${inputId}-kind`}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "user", label: t`User (subject)` },
              { value: "org", label: t`Organisation (id)` },
            ]}
          />
        </div>
        <label htmlFor={inputId} className="sr-only">
          <Trans>Target</Trans>
        </label>
        <Input
          id={inputId}
          name="target"
          placeholder={kind === "user" ? t`Subject` : t`Organisation id`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="max-w-sm font-mono text-xs"
        />
        <Button type="submit" variant="outline">
          <Trans>Look up</Trans>
        </Button>
      </form>
      {target && (
        <div className="mt-4 space-y-4">
          {state.phase === "loading" ? (
            <LoadingSkeleton rows={2} />
          ) : state.phase === "error" ? (
            <ErrorState title={t`Could not look up ${targetId}`} message={state.message} onRetry={reload} />
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
  const { t, i18n } = useLingui();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetKind = target.kind;
  const targetId = target.id;

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

  const since = current ? formatDate(current.created_at) : "";
  const actor = current?.actor_subject ?? "";
  return (
    <div
      className="rounded-xl border border-border bg-card p-5"
      aria-label={t`Current state of ${targetKind} ${targetId}`}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-mw-text-muted">
          <Trans>Target</Trans>
        </dt>
        <dd className="font-mono text-xs">
          {target.kind} {target.id}
        </dd>
        <dt className="text-mw-text-muted">
          <Trans>State</Trans>
        </dt>
        <dd>
          {current ? (
            <StateBadge state={current.state} />
          ) : (
            <span>
              <Trans>None</Trans>
            </span>
          )}
        </dd>
        {current && (
          <>
            <dt className="text-mw-text-muted">
              <Trans>Reason shown</Trans>
            </dt>
            <dd className="whitespace-normal">{current.reason}</dd>
            {current.notes && (
              <>
                <dt className="text-mw-text-muted">
                  <Trans>Notes</Trans>
                </dt>
                <dd className="whitespace-normal">{current.notes}</dd>
              </>
            )}
            <dt className="text-mw-text-muted">
              <Trans>Since</Trans>
            </dt>
            <dd>
              <Trans>
                {since} by <span className="font-mono text-xs">{actor}</span>
              </Trans>
            </dd>
            <dt className="text-mw-text-muted">
              <Trans>Ends</Trans>
            </dt>
            <dd>{current.expires_at ? formatDate(current.expires_at) : t`When lifted`}</dd>
            {current.evidence.length > 0 && (
              <>
                <dt className="text-mw-text-muted">
                  <Trans>Evidence</Trans>
                </dt>
                <dd className="font-mono text-xs">{current.evidence.map(shortId).join(", ")}</dd>
              </>
            )}
          </>
        )}
      </dl>
      {current && (
        <form onSubmit={lift} className="mt-3 flex flex-wrap items-end gap-2" aria-label={t`Lift`}>
          <Input
            aria-label={t`Reason for lifting`}
            placeholder={t`Why it ends now, in your words`}
            value={reason}
            maxLength={2000}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            className="max-w-md"
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy || !reason.trim()}>
            {i18n._(LIFT_LABEL[current.state])}
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
  const { t, i18n } = useLingui();
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
      aria-label={current ? t`Change state` : t`Apply a state`}
      className="space-y-3 rounded-xl border border-border bg-card p-5"
    >
      <h4 className="text-sm font-medium text-mw-text">
        {current ? <Trans>Move on the ladder</Trans> : <Trans>Apply a state</Trans>}
      </h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${id}-state`}>
            <Trans>State</Trans>
          </label>
          <SimpleSelect<LadderState>
            id={`${id}-state`}
            value={state}
            disabled={busy}
            onValueChange={setState}
            options={LADDER.map((s) => ({ value: s, label: i18n._(LADDER_LABEL[s]) }))}
            className="w-full"
          />
        </div>
        {state !== "suspended" ? (
          <label htmlFor={`${id}-hours`} className="flex flex-col gap-1 text-sm">
            {state === "rate_limited" ? (
              <Trans>Ends in hours (empty: the configured default)</Trans>
            ) : (
              <Trans>Ends in hours (empty: when lifted)</Trans>
            )}
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
            <Trans>A suspension ends when a person lifts it. Sign-in and every request are refused meanwhile.</Trans>
          </p>
        )}
      </div>
      <label htmlFor={`${id}-reason`} className="flex flex-col gap-1 text-sm">
        <Trans>Reason, shown to the person</Trans>
        <Input
          id={`${id}-reason`}
          aria-label={t`Reason shown to the person`}
          value={reason}
          maxLength={2000}
          required
          disabled={busy}
          placeholder={t`What was seen and what to do differently`}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <label htmlFor={`${id}-notes`} className="flex flex-col gap-1 text-sm">
        <Trans>Notes, for operators only</Trans>
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
          {i18n._(APPLY_LABEL[state])}
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
  const { t, i18n } = useLingui();
  if (rows.length === 0) return null;
  return (
    <Table className="bg-card" aria-label={t`Enforcement history`}>
      <TableHeader>
        <TableRow>
          <TableHead>
            <Trans>When</Trans>
          </TableHead>
          <TableHead>
            <Trans>State</Trans>
          </TableHead>
          <TableHead>
            <Trans>Reason</Trans>
          </TableHead>
          <TableHead>
            <Trans>By</Trans>
          </TableHead>
          <TableHead>
            <Trans>Ended</Trans>
          </TableHead>
          <TableHead>
            <Trans>Appeal</Trans>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const liftedOn = row.lifted_at ? formatDate(row.lifted_at) : "";
          const liftedBy = row.lifted_by ?? "—";
          const liftReason = row.lift_reason ?? "";
          const expiresOn = row.expires_at ? formatDate(row.expires_at) : "";
          return (
          <TableRow key={row.id} className="border-b border-mw-border">
            <TableCell>{formatDate(row.created_at)}</TableCell>
            <TableCell>
              <StateBadge state={row.state} />
            </TableCell>
            <TableCell className="max-w-md whitespace-normal">{row.reason}</TableCell>
            <TableCell className="font-mono text-xs text-mw-text-muted">{row.actor_subject}</TableCell>
            <TableCell className="whitespace-normal text-mw-text-muted">
              {row.lifted_at
                ? t`${liftedOn} by ${liftedBy}: ${liftReason}`
                : row.expires_at
                  ? t`Expires ${expiresOn}`
                  : t`In force`}
            </TableCell>
            <TableCell className="text-mw-text-muted">
              {row.appeal_state === "none" ? "—" : i18n._(APPEAL_LABEL[row.appeal_state])}
            </TableCell>
          </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
