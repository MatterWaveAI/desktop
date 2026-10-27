import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Alert, Meter } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { ApiError, apiFetch } from "../../../lib/api";
import { managesOrg } from "../../../lib/auth";
import { MICROS_PER_USD, formatMicros } from "../../../lib/billing";
import { ErrorState, LoadingSkeleton } from "../../../patterns";
import { useShell } from "../../../shell/shellContext";
import { LearnMore, PaneSection } from "../PaneSection";
import { capFieldText, formatMonth, parseCapMicros, parseDollars } from "./budgetMoney";

const LABEL_CLASS = "text-sm text-mw-text-subtle";
const LINK_CLASS = "text-sm text-mw-link underline underline-offset-2 hover:text-mw-link-hover";
/** The overage cap field, which the stop notice's "Raise the cap" focuses. */
const CAP_FIELD_ID = "budget-overage-cap";

/**
 * The org's budget: the plan's included tokens this month and, on a plan
 * with overage, the cap on what usage past them may cost.
 *
 * Every member can read it -- the first a user should learn of a budget is
 * this page, not a refused message. Only an owner or admin by membership
 * (`org_role`, never the platform `roles` claim) can change the overage
 * cap, because the cap is the org's exposure; the API enforces that too,
 * this pane just does not offer a control that would 403. A plan without
 * overage has nothing to change, and the pane says so instead.
 */

export interface BudgetView {
  /** ISO date, the first of the month the running totals belong to. */
  period_start: string;
  included_tokens: number;
  /** Weighted tokens this period. */
  tokens_used: number;
  remaining_tokens: number;
  overage_enabled: boolean;
  /** The cap in force: the org's own, or the plan's default when it has none. */
  overage_cap_micros: number;
  overage_micros: number;
  /** The cap on each member's monthly spend at list price, in micro-dollars; null is unlimited. */
  member_default_cap_micros?: number | null;
  /** The caller's own cap in force (their row, else the default); null is unlimited. */
  member_cap?: number | null;
  /** What the caller has spent against it this period, in micro-dollars at list price. */
  member_spent?: number;
  member_exhausted?: boolean;
}

/** One row of `/api/budget/members`: a member, the cap in force and the month's spend. */
export interface MemberBudgetRow {
  subject: string;
  email: string;
  name: string | null;
  role: string;
  state: string;
  cap_micros: number | null;
  /** True when the cap is the member's own row rather than the org's default. */
  own: boolean;
  spent_micros: number;
  exhausted: boolean;
}

export interface MemberBudgets {
  period_start: string;
  member_default_cap_micros: number | null;
  data: MemberBudgetRow[];
}

/**
 * A spend-cap field as micro-dollars: whole cents typed in dollars, an
 * empty field as null ("no cap" for the default, "the default" for a
 * member's own). `invalid` while the text is not an amount -- distinct
 * from null, which is a value the API accepts.
 */
function parseMemberCap(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  const cents = parseDollars(text);
  return cents === null ? "invalid" : cents * (MICROS_PER_USD / 100);
}

function capText(micros: number | null): string {
  return micros === null ? "" : capFieldText(micros);
}

function Field(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
      <dt className="text-sm text-mw-text-subtle">{props.label}</dt>
      <dd className="text-sm">
        <span>{props.value}</span>
        {props.hint && <span className="ml-2 text-xs text-mw-text-subtle">{props.hint}</span>}
      </dd>
    </div>
  );
}

/**
 * Where the month stands against the budget. How much of the allowance is
 * used is Usage's to say, with its meter; this names only what the budget
 * changes: whether anything is billed past it, and whether the cap stops it.
 */
function summary(budget: BudgetView): { text: string; stopped: boolean } {
  const pastAllowance = budget.tokens_used >= budget.included_tokens;
  // The Overage section below says this plan has none; here only where the month stands.
  if (!budget.overage_enabled) {
    return pastAllowance
      ? { text: "The included tokens are used up. Messages are refused until the month rolls over.", stopped: true }
      : { text: "Within the included tokens. The totals reset on the first of each month.", stopped: false };
  }
  if (pastAllowance && budget.overage_micros >= budget.overage_cap_micros) {
    return {
      text: "The overage cap is reached. Messages are refused until the month rolls over or the cap is raised.",
      stopped: true,
    };
  }
  if (pastAllowance) {
    return {
      text: "Past the included tokens: usage is billed at each model's list price until the overage cap.",
      stopped: false,
    };
  }
  return {
    text: "Within the included tokens: nothing is billed on top of the plan yet. The totals reset on the first of each month.",
    stopped: false,
  };
}

/** What the pane reads from `/api/entitlements`: the plan's default cap and how it is counted. */
interface CapTerms {
  /** The cap an org gets when nobody has set one; per seat times the seats on a plan sold per seat. */
  default_overage_cap_micros: number;
  per_seat: boolean;
  billed_seats: number;
}

function capTermsOf(body: Partial<CapTerms>): CapTerms | null {
  if (typeof body.default_overage_cap_micros !== "number") return null;
  return {
    default_overage_cap_micros: body.default_overage_cap_micros,
    per_seat: body.per_seat === true,
    billed_seats: typeof body.billed_seats === "number" ? body.billed_seats : 1,
  };
}

/**
 * On a plan sold per seat the default cap grows with the seats and an
 * owner's own cap does not, so once someone has set one the pane says what
 * the default would be now. `/api/budget` reports only the cap in force; a
 * cap that differs from the default is one somebody set (0 reads back as
 * the default itself).
 */
function fixedCapNote(budget: BudgetView, terms: CapTerms | null): string | null {
  if (terms === null || !terms.per_seat || !budget.overage_enabled) return null;
  if (budget.overage_cap_micros === terms.default_overage_cap_micros) return null;
  const seats = `${terms.billed_seats} seat${terms.billed_seats === 1 ? "" : "s"}`;
  return `Your limit is fixed at ${formatMicros(budget.overage_cap_micros)}. The default for ${seats} would be ${formatMicros(terms.default_overage_cap_micros)}.`;
}

export function BudgetPane() {
  const shell = useShell();
  const isAdmin = managesOrg(shell.principal);
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The plan's default cap, so the editor can say what "0" will mean in
  // dollars. `/api/budget` reports the cap in force, not where it came from.
  const [capTerms, setCapTerms] = useState<CapTerms | null>(null);

  // Bumped by the retry button; the effect owns the fetch (the ModelPicker
  // shape, with a cancelled flag) so an unmounted pane never sets state.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<BudgetView>("/api/budget")
      .then((body) => {
        if (cancelled) return;
        setBudget(body);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBudget(null);
        setLoadError(err instanceof ApiError ? err.message : "Could not load the budget.");
      });
    // Best effort: without it the editor still explains the default in words.
    apiFetch<Partial<CapTerms>>("/api/entitlements")
      .then((body) => {
        if (!cancelled) setCapTerms(capTermsOf(body));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (loadError) {
    return <ErrorState title="Could not load the budget" message={loadError} onRetry={reload} />;
  }
  if (budget === null) return <LoadingSkeleton rows={4} />;
  const fixedCap = fixedCapNote(budget, capTerms);
  const month = summary(budget);
  // Only an admin on a plan with overage has a cap to raise; everyone else
  // waits for the month to roll over, so the notice offers nothing to press.
  const canRaise = month.stopped && budget.overage_enabled && isAdmin;

  return (
    <div className="flex flex-col gap-7">
      {/* Refused requests are the one hard stop here, so the red notice; the
          card below keeps the numbers. */}
      {month.stopped && (
        <Alert
          variant="danger"
          data-budget-stopped
          title={budget.overage_enabled ? "Overage cap reached" : "Included tokens used up"}
          action={
            canRaise ? (
              <Button
                type="button"
                onClick={() => {
                  const field = document.getElementById(CAP_FIELD_ID);
                  field?.scrollIntoView({ block: "center", behavior: "smooth" });
                  field?.focus({ preventScroll: true });
                }}
              >
                Raise the cap
              </Button>
            ) : undefined
          }
        >
          <p>{month.text}</p>
        </Alert>
      )}
      <PaneSection
        title="This month"
        description={month.stopped ? `Overage and its cap for ${formatMonth(budget.period_start)}.` : month.text}
      >
        <dl className="divide-y divide-border">
          {budget.overage_enabled && (
            <>
              <Field label="Overage billed" value={formatMicros(budget.overage_micros)} />
              <Field label="Overage cap" value={formatMicros(budget.overage_cap_micros)} />
            </>
          )}
          <Field label="Period" value={formatMonth(budget.period_start)} />
        </dl>
        {budget.overage_enabled && (
          <Meter
            tone={budget.overage_micros >= budget.overage_cap_micros ? "danger" : "brand"}
            value={budget.overage_cap_micros > 0 ? (budget.overage_micros / budget.overage_cap_micros) * 100 : 0}
            className="mt-2"
          />
        )}
        {fixedCap && <p className="mt-3 text-sm text-mw-text-subtle">{fixedCap}</p>}
        {/* The allowance is shown once, on Usage, with its meter. */}
        <p className="mt-3 border-t border-border pt-3 text-sm text-mw-text-subtle">
          The included tokens and how many are used are on Usage.{" "}
          <Link to="/settings/$paneId" params={{ paneId: "usage" }} className={LINK_CLASS}>
            See usage
          </Link>
        </p>
      </PaneSection>

      {!budget.overage_enabled ? (
        <PaneSection
          title="Overage"
          description="This plan has no overage: past the included tokens, requests are refused rather than billed."
        >
          <p className="text-sm text-mw-text-subtle">Paid plans keep going at each model&apos;s list price, up to a cap.</p>
          <Link to="/pricing" className={`${LINK_CLASS} mt-1 inline-block`}>
            See plans
          </Link>
        </PaneSection>
      ) : isAdmin ? (
        <CapEditor
          current={budget.overage_cap_micros}
          planDefault={capTerms?.default_overage_cap_micros ?? null}
          onSaved={setBudget}
        />
      ) : (
        <PaneSection
          title="Changing the overage cap"
          description="Only an organisation administrator can change the overage cap. Ask one if you are running out."
        />
      )}

      {isAdmin ? <MemberCapsEditor /> : <OwnCap budget={budget} />}
    </div>
  );
}

/** A member's own cap and what they have spent against it. */
function OwnCap(props: { budget: BudgetView }) {
  const cap = props.budget.member_cap ?? null;
  if (cap === null) {
    return (
      <PaneSection
        title="Your spend cap"
        description="No cap applies to your own usage this month: only the organisation's budget above."
      />
    );
  }
  const spent = props.budget.member_spent ?? 0;
  const description = props.budget.member_exhausted
    ? "Your monthly spend cap is reached. Messages are refused until an organisation administrator raises it or the month rolls over."
    : "The most your own usage may cost this month at each model's list price; an organisation administrator sets it.";
  return (
    <PaneSection title="Your spend cap" description={description}>
      <dl className="divide-y divide-border">
        <Field label="Spent this month" value={formatMicros(spent)} hint="at list price" />
        <Field label="Your cap" value={formatMicros(cap)} />
      </dl>
      <Meter
        tone={props.budget.member_exhausted ? "danger" : "positive"}
        value={cap > 0 ? (spent / cap) * 100 : 100}
        className="mt-2"
      />
    </PaneSection>
  );
}

const TH_CLASS = "py-1.5 pr-3 font-normal";
const NUM_CLASS = "py-2 pr-3 tabular-nums";

/**
 * The owner's view: the default every member is held to, and a table of
 * members with the month's spend beside each and a cap of their own that
 * beats the default. Re-read from the API after every save, so what the
 * table shows is what the API holds.
 */
function MemberCapsEditor() {
  const [state, setState] = useState<
    { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; report: MemberBudgets }
  >({ phase: "loading" });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<MemberBudgets>("/api/budget/members")
      .then((report) => {
        if (!cancelled) setState({ phase: "ready", report });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          phase: "error",
          message: err instanceof ApiError ? err.message : "Could not load the member caps.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (state.phase === "error") {
    return <ErrorState title="Could not load the member caps" message={state.message} onRetry={reload} />;
  }
  if (state.phase === "loading") return <LoadingSkeleton rows={3} />;
  const { report } = state;
  const saved = (next: MemberBudgets) => setState({ phase: "ready", report: next });

  return (
    <PaneSection
      title="Spend caps per member"
      description="The most one member's usage may cost this month, in US dollars at list price."
    >
      <LearnMore className="mb-4">
        <p>
          Checked after the organisation&apos;s budget. Members at their cap are refused, and they and the owners
          are mailed at 80% and 100%.
        </p>
        <p>Leave the default empty for no cap; a member&apos;s own cap beats the default, up or down.</p>
      </LearnMore>
      <DefaultCapForm current={report.member_default_cap_micros} onSaved={saved} />
      {/* Four columns do not fit a phone; the table scrolls sideways rather than losing Save off the edge. */}
      <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm" aria-label="Spend caps by member">
        <thead>
          <tr className="text-left text-mw-text-subtle">
            <th scope="col" className={TH_CLASS}>Member</th>
            <th scope="col" className={TH_CLASS}>Spent this month</th>
            <th scope="col" className={TH_CLASS}>Cap (USD)</th>
            <th scope="col" className={TH_CLASS}>
              <span className="sr-only">Save</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {report.data.length === 0 ? (
            <tr className="border-t border-border">
              <td colSpan={4} className="py-3 text-mw-text-subtle">
                No members to show yet. Everyone who joins is held to the default above.
              </td>
            </tr>
          ) : (
            report.data.map((row) => <MemberCapRow key={row.subject} row={row} onSaved={reload} />)
          )}
        </tbody>
      </table>
      </div>
    </PaneSection>
  );
}

function DefaultCapForm(props: { current: number | null; onSaved: (report: MemberBudgets) => void }) {
  const [text, setText] = useState(() => capText(props.current));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const micros = parseMemberCap(text);
  const dirty = micros !== "invalid" && micros !== props.current;

  const save = async () => {
    if (micros === "invalid") return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const report = await apiFetch<MemberBudgets>("/api/budget/members", {
        method: "PUT",
        json: { member_default_cap_micros: micros },
      });
      props.onSaved(report);
      setText(capText(report.member_default_cap_micros));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the default cap.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !saving) void save();
      }}
    >
      <label className="flex flex-col gap-1">
        <span className={LABEL_CLASS}>Default cap per member (USD)</span>
        <Input
          aria-label="Default spend cap per member in US dollars"
          inputMode="decimal"
          className="w-40"
          value={text}
          placeholder="No cap"
          aria-invalid={micros === "invalid" || undefined}
          onChange={(event) => {
            setSaved(false);
            setText(event.target.value);
          }}
        />
      </label>
      <Button type="submit" disabled={!dirty || saving}>
        {saving ? "Saving…" : "Save default"}
      </Button>
      {micros === "invalid" && (
        <span role="alert" className="text-sm text-mw-danger">
          Enter a dollar amount, like 25 or 12.50, or leave it empty for no cap.
        </span>
      )}
      {error && (
        <span role="alert" className="text-sm text-mw-danger">
          {error}
        </span>
      )}
      {saved && !error && (
        <span role="status" aria-live="polite" className="text-sm text-mw-positive">
          Saved.
        </span>
      )}
    </form>
  );
}

function MemberCapRow(props: { row: MemberBudgetRow; onSaved: () => void }) {
  const { row } = props;
  const [text, setText] = useState(() => (row.own ? capText(row.cap_micros) : ""));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const micros = parseMemberCap(text);
  const current = row.own ? row.cap_micros : null;
  const dirty = micros !== "invalid" && micros !== current;
  const who = row.name ? `${row.name} (${row.email})` : row.email;

  const save = async () => {
    if (micros === "invalid") return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/budget/members/${encodeURIComponent(row.subject)}`, {
        method: "PUT",
        json: { cap_micros: micros },
      });
      props.onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the cap.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr data-subject={row.subject} className="border-t border-border align-baseline">
      <td className="min-w-40 py-2 pr-3">
        <span className="break-all">{who}</span>
        {/* Refused until the cap moves: a warning on the row, not an error. */}
        {row.exhausted && <span className="ml-2 text-xs font-medium text-mw-warning-foreground">at cap</span>}
      </td>
      <td className={NUM_CLASS}>{formatMicros(row.spent_micros)}</td>
      <td className={NUM_CLASS}>
        <Input
          aria-label={`Spend cap for ${row.email} in US dollars`}
          inputMode="decimal"
          className="w-28"
          value={text}
          placeholder={row.cap_micros === null ? "No cap" : `${capFieldText(row.cap_micros)} (default)`}
          aria-invalid={micros === "invalid" || undefined}
          onChange={(event) => setText(event.target.value)}
        />
      </td>
      <td className="py-2 whitespace-nowrap">
        <Button
          type="button"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        {error && (
          <span role="alert" className="ml-2 text-sm text-mw-danger">
            {error}
          </span>
        )}
      </td>
    </tr>
  );
}

function CapEditor(props: {
  current: number;
  planDefault: number | null;
  onSaved: (budget: BudgetView) => void;
}) {
  const [text, setText] = useState(() => capFieldText(props.current));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const micros = parseCapMicros(text);
  const dirty = micros !== null && micros !== props.current;

  const save = async () => {
    if (micros === null) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const body = await apiFetch<BudgetView>("/api/budget", {
        method: "PUT",
        json: { overage_cap_micros: micros },
      });
      props.onSaved(body);
      setText(capFieldText(body.overage_cap_micros));
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save the overage cap.");
    } finally {
      setSaving(false);
    }
  };

  const defaultText =
    props.planDefault === null
      ? "the plan's default, its monthly price"
      : `the plan's default, ${formatMicros(props.planDefault)}`;

  return (
    <PaneSection
      title="Overage cap"
      description="The most usage past the included tokens may cost this month, in US dollars."
    >
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty && !saving) void save();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className={LABEL_CLASS}>Cap (USD)</span>
          <Input
            id={CAP_FIELD_ID}
            aria-label="Overage cap in US dollars"
            inputMode="decimal"
            className="w-40"
            value={text}
            aria-invalid={micros === null || undefined}
            onChange={(event) => {
              setSaved(false);
              setText(event.target.value);
            }}
          />
        </label>
        <Button type="submit" disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save cap"}
        </Button>
        {micros === null && (
          <span role="alert" className="text-sm text-mw-danger">
            Enter a dollar amount, like 25 or 12.50.
          </span>
        )}
        {saveError && (
          <span role="alert" className="text-sm text-mw-danger">
            {saveError}
          </span>
        )}
        {saved && !saveError && (
          <span role="status" aria-live="polite" className="text-sm text-mw-positive">
            Overage cap saved.
          </span>
        )}
      </form>
      <LearnMore className="mt-4">
        <p>
          At each model&apos;s list price. Requests are refused once it is reached. Leave it empty or enter 0 to use{" "}
          {defaultText}.
        </p>
      </LearnMore>
    </PaneSection>
  );
}
