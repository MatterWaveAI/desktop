import { useCallback, useEffect, useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import { plural, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Alert, Meter } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { formatDate, formatDateTime, formatNumber } from "../../../i18n/format";
import { ErrorState, LoadingSkeleton } from "../../../patterns";
import { useShell } from "../../../shell/shellContext";
import { failureMessage } from "../../../shell/authForms";
import { formatMonth } from "./budgetMoney";
import { managesOrg } from "../../../lib/auth";
import {
  fetchUsage,
  formatMicros,
  formatMultiplier,
  formatResetDate,
  formatSeats,
  formatTokenAllowance,
  formatTokens,
  type UsageSummary,
} from "../../../lib/billing";
import {
  downloadCsv,
  fetchMemberUsage,
  memberUsageCsvPath,
  type ConnectionUsage,
  type MemberUsageReport,
} from "../../../lib/orgPolicy";
import { LearnMore, PaneSection } from "../PaneSection";

/**
 * Usage: the balance that will stop a request, shown before it does.
 *
 * The allowance is weighted tokens: a turn counts its prompt plus completion
 * tokens times its model's multiplier, so the pane says tokens and shows the
 * per-model breakdown that explains how the count got there. Money appears
 * only where money is owed or capped: overage, in dollars, against the cap.
 *
 * The page says which of three states the org is in rather than leaving a
 * person to work it out from a percentage: approaching the allowance
 * (warn), past it and being billed (in_overage), or refused (exhausted).
 * The API decides; this pane only shows, so the banner in the shell and
 * this pane can never disagree.
 *
 * The history is a table with a bar in each row, not a chart: a single
 * series over a few weeks needs no legend, every value is readable as a
 * number, and a table is what a screen reader gets anyway. The bar is
 * proportional to the biggest day so a quiet month still shows shape, and
 * sized as a share of its column so a phone's narrower card gets a
 * narrower bar rather than one that runs off the edge.
 *
 * On a plan sold per seat the allowance is the seats' tokens added up into
 * one pool, so the pane says so beside the number: an org that just gained
 * a member sees why its allowance moved.
 *
 * The per-member table underneath comes from `/api/org/usage`, which
 * scopes itself: an owner or admin gets every member, anyone else gets
 * their own row and nobody else's. The pane shows what it is given and
 * names the section accordingly, so a member is not shown an empty "by
 * member" table that looks like a loading failure. Beside it, the same
 * month's spend per connection -- the share a Slack workspace's mentions
 * made -- scoped the same way.
 */

const TH_CLASS = "py-1.5 pr-3 font-normal";
const NUM_CLASS = "py-1.5 pr-3 tabular-nums";

function stateOf(u: UsageSummary): { tone: "ok" | "warn" | "overage" | "stop"; title: string; detail: string } {
  const spent = formatMicros(u.overage.spent_micros);
  const cap = formatMicros(u.overage.cap_micros);
  const resetDate = formatResetDate(u.resets_at);
  const remaining = formatTokens(u.remaining);
  if (u.exhausted) {
    // Free stops at the allowance; a paid plan stops at the overage cap,
    // and only the second is something an admin can move.
    return u.overage.enabled
      ? {
          tone: "stop",
          title: t`Overage cap reached`,
          detail: t`${spent} of overage billed this period. Requests are refused until ${resetDate}. An admin can raise the overage cap in Budget.`,
        }
      : {
          tone: "stop",
          title: t`Out of tokens for this period`,
          detail: t`Requests are refused until ${resetDate}. A paid plan has a bigger allowance and keeps going past it.`,
        };
  }
  if (u.in_overage) {
    return {
      tone: "overage",
      title: t`Past your included tokens`,
      detail: t`Billed at each model's list price: ${spent} so far of a ${cap} overage cap. Requests stop at the cap.`,
    };
  }
  if (u.warn) {
    const percent = Math.round(u.percent);
    return {
      tone: "warn",
      title: t`${percent}% of your included tokens used`,
      detail: t`${remaining} left until ${resetDate}.`,
    };
  }
  return {
    tone: "ok",
    title: t`${remaining} left`,
    detail: t`Resets on ${resetDate}.`,
  };
}

// The allowance meter is emerald while there is room, amber once the API
// warns or bills overage, and red only at the hard stop.
const METER_TONE = {
  ok: "positive",
  warn: "warning",
  overage: "warning",
  stop: "danger",
} as const;

// A stop refuses requests, so it is the one red notice; approaching the
// allowance or billing past it is a warning -- nothing is broken yet.
const ALERT_VARIANT = {
  warn: "warning",
  overage: "warning",
  stop: "danger",
} as const;

const LINK_CLASS = "text-sm text-mw-link underline underline-offset-2 hover:text-mw-link-hover";

export function UsagePane() {
  const { t } = useLingui();
  const { principal } = useShell();
  const isAdmin = managesOrg(principal);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // Cleared by the retry, not by the effect (see BillingPane for why).
  const reload = useCallback(() => {
    setError(null);
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    fetchUsage()
      .then((u) => alive && setUsage(u))
      .catch((err) => alive && setError(failureMessage(err)));
    return () => {
      alive = false;
    };
  }, [version]);

  if (error) {
    return <ErrorState title={t`Could not load usage`} message={error} onRetry={reload} />;
  }
  if (!usage) return <LoadingSkeleton />;

  const state = stateOf(usage);
  // The meter shows the allowance, not the overage cap: the cap is money an
  // admin agreed to, the allowance is what the plan promised, and the two
  // are not in the same unit.
  const fill = Math.min(usage.percent, 100);
  const maxDay = Math.max(1, ...usage.history.map((d) => d.weighted_tokens));
  const overage = usage.overage.enabled;
  const planName = usage.plan.name;
  const periodMonth = formatMonth(usage.period_start);
  const remaining = formatTokens(usage.remaining);
  const resetDate = formatResetDate(usage.resets_at);
  const billedSeats = usage.seats ? formatSeats(usage.seats.billed) : "";
  const perSeat = usage.seats ? formatTokenAllowance(usage.seats.included_tokens_per_seat) : "";
  // The one way on: more tokens on a plan without overage, the cap for an
  // admin on one that has it. A notice carries it when there is one, the
  // card's footer otherwise -- never both, so it is one control by name.
  const way = !overage ? (
    <Link to="/pricing" className={LINK_CLASS}>
      <Trans>Upgrade for more tokens and overage</Trans>
    </Link>
  ) : isAdmin ? (
    <Link to="/settings/$paneId" params={{ paneId: "budget" }} className={LINK_CLASS}>
      <Trans>Change the overage cap</Trans>
    </Link>
  ) : null;

  return (
    <div className="flex flex-col gap-7">
      {state.tone !== "ok" && (
        <Alert
          variant={ALERT_VARIANT[state.tone]}
          role="status"
          data-usage-state={state.tone}
          title={state.title}
          action={way}
        >
          <p>{state.detail}</p>
        </Alert>
      )}

      <PaneSection
        title={t`This period`}
        description={t`${planName} plan · ${periodMonth}`}
      >
        {state.tone === "ok" ? (
          <div data-usage-state="ok" className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-lg font-semibold tabular-nums">{state.title}</p>
            <p className="text-sm text-mw-text-subtle">{state.detail}</p>
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-lg font-semibold tabular-nums">
              <Trans>{remaining} left</Trans>
            </p>
            <p className="text-sm text-mw-text-subtle">
              <Trans>Resets on {resetDate}.</Trans>
            </p>
          </div>
        )}

        <div
          role="meter"
          aria-label={t`Included tokens used this period`}
          aria-valuemin={0}
          aria-valuemax={usage.included}
          aria-valuenow={Math.min(usage.used, usage.included)}
          className="mt-3"
        >
          <Meter tone={METER_TONE[state.tone]} value={fill} className="h-2" />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-mw-text-subtle">
              <Trans>Used</Trans>
            </dt>
            <dd className="font-medium tabular-nums">{formatNumber(usage.used)}</dd>
          </div>
          <div>
            <dt className="text-mw-text-subtle">
              <Trans>Included</Trans>
            </dt>
            <dd className="font-medium tabular-nums">{formatNumber(usage.included)}</dd>
          </div>
          <div>
            <dt className="text-mw-text-subtle">
              <Trans>Remaining</Trans>
            </dt>
            <dd className="font-medium tabular-nums">{formatNumber(usage.remaining)}</dd>
          </div>
          <div>
            <dt className="text-mw-text-subtle">
              <Trans>Resets</Trans>
            </dt>
            <dd className="font-medium">{resetDate}</dd>
          </div>
          {overage && (
            <>
              <div>
                <dt className="text-mw-text-subtle">
                  <Trans>Overage billed</Trans>
                </dt>
                <dd className="font-medium tabular-nums">{formatMicros(usage.overage.spent_micros)}</dd>
              </div>
              <div>
                <dt className="text-mw-text-subtle">
                  <Trans>Overage cap</Trans>
                </dt>
                <dd className="font-medium tabular-nums">{formatMicros(usage.overage.cap_micros)}</dd>
              </div>
            </>
          )}
        </dl>
        {usage.seats && (
          <p data-usage-seats className="mt-3 text-sm text-mw-text-subtle">
            <Trans>Included: {billedSeats} × {perSeat}, one pool for the whole organisation.</Trans>
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
          <LearnMore>
            <p>
              <Trans>Token counts are weighted: each model&apos;s tokens count times its multiplier.</Trans>
            </p>
            {overage && (
              <p>
                <Trans>
                  Past the included tokens, usage is billed at each model&apos;s list price until the overage cap.
                </Trans>
              </p>
            )}
          </LearnMore>
          {state.tone === "ok" && way && <div className="ml-auto">{way}</div>}
        </div>
      </PaneSection>

      <PaneSection
        title={t`By model`}
        description={
          <>
            <Trans>What each model counted against the allowance.</Trans>
            <LearnMore className="mt-1">
              <p>
                <Trans>List price is what the tokens cost without a plan; only overage is billed on top of it.</Trans>
              </p>
            </LearnMore>
          </>
        }
      >
        {usage.models.length === 0 ? (
          <p className="text-sm text-mw-text-subtle">
            <Trans>No model has been used yet this period.</Trans>
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={t`Usage by model`}>
              <thead>
                <tr className="text-left text-mw-text-subtle">
                  <th scope="col" className={TH_CLASS}>
                    <Trans>Model</Trans>
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    <Trans>Tokens</Trans>
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    <Trans>Multiplier</Trans>
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    <Trans>Weighted tokens</Trans>
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    <Trans>At list price</Trans>
                  </th>
                  {overage && (
                    <th scope="col" className={TH_CLASS}>
                      <Trans>Overage billed</Trans>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {usage.models.map((row) => {
                  const summaryTokens = formatNumber(row.compaction_weighted_tokens ?? 0);
                  return (
                    <tr key={row.model} data-model={row.model} className="border-t border-border">
                      {/* The summaries are inside this row's totals; the note says how much. */}
                      <td className="py-1.5 pr-3">
                        {row.label}
                        {(row.compaction_requests ?? 0) > 0 && (
                          <span data-usage-compaction-row className="block text-xs text-mw-text-subtle">
                            <Trans>{summaryTokens} weighted on summaries</Trans>
                          </span>
                        )}
                      </td>
                      <td className={NUM_CLASS}>{formatNumber(row.tokens)}</td>
                      <td className={NUM_CLASS}>{formatMultiplier(row.multiplier)}</td>
                      <td className={NUM_CLASS}>{formatNumber(row.weighted_tokens)}</td>
                      <td className={NUM_CLASS}>{formatMicros(row.cost_micros)}</td>
                      {overage && <td className={NUM_CLASS}>{formatMicros(row.overage_micros)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {usage.compaction && usage.compaction.requests > 0 && (
          <p data-usage-compaction className="mt-2 text-xs text-mw-text-subtle">
            {compactionNote(usage.compaction.weighted_tokens, usage.compaction.requests)}
          </p>
        )}
      </PaneSection>

      <PaneSection title={t`By day`} description={t`Weighted tokens and requests this period, oldest first.`}>
        {usage.history.length === 0 ? (
          <p className="text-sm text-mw-text-subtle">
            <Trans>Nothing used yet this period.</Trans>
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={t`Usage by day`}>
              <thead>
                <tr className="text-left text-mw-text-subtle">
                  <th scope="col" className={TH_CLASS}>
                    <Trans>Day</Trans>
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    <Trans>Weighted tokens</Trans>
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    <Trans>Requests</Trans>
                  </th>
                  <th scope="col" className="w-1/3 min-w-20 py-1.5 font-normal">
                    <span className="sr-only">
                      <Trans>Share of busiest day</Trans>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.history.map((day) => (
                  <tr key={day.day} className="border-t border-border">
                    <td className={`${NUM_CLASS} whitespace-nowrap`}>
                      <time dateTime={day.day}>{formatDay(day.day)}</time>
                    </td>
                    <td className={NUM_CLASS}>{formatNumber(day.weighted_tokens)}</td>
                    <td className={NUM_CLASS}>{formatNumber(day.requests)}</td>
                    <td className="py-1.5">
                      <Meter tone="brand" value={Math.max(2, (day.weighted_tokens / maxDay) * 100)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PaneSection>

      <MembersSection period={usage.period_start.slice(0, 7)} manages={isAdmin} />
    </div>
  );
}

/**
 * "20 Oct" -- a day of the period, in the reader's locale. The API's
 * "2026-10-20" is read as a calendar date, not an instant, so no time zone
 * moves it to the day before; the year is the period's and goes unsaid.
 */
export function formatDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return formatDate(date, { day: "numeric", month: "short" });
}

/** "3 Oct 2026, 10:00" -- a member's last turn, in the reader's locale. */
function formatLastActive(iso: string | null): string {
  if (!iso) return "";
  return formatDateTime(iso, { dateStyle: "medium", timeStyle: "short" }) || iso;
}

/** The compaction note under the model table: how much of the total went to summaries. */
function compactionNote(weightedTokens: number, requests: number): string {
  const weighted = formatNumber(weightedTokens);
  return plural(requests, {
    one: `Of these, ${weighted} weighted tokens over # summary went to compaction: folding long conversations so they fit their model. Counted in the totals above, not on top of them.`,
    other: `Of these, ${weighted} weighted tokens over # summaries went to compaction: folding long conversations so they fit their model. Counted in the totals above, not on top of them.`,
  });
}

/** The member as a person: email first, then a name, then the subject the rows carry. */
function memberLabel(row: MemberUsageReport["data"][number]): string {
  return row.email ?? row.name ?? row.subject;
}

/**
 * Weighted tokens, list-price cost, turns and last activity per member for
 * one calendar month.
 * The month defaults to the current billing period and can be moved back;
 * the CSV is the same query as a file.
 */
function MembersSection(props: { period: string; manages: boolean }) {
  const { t } = useLingui();
  const [period, setPeriod] = useState(props.period);
  // The answer for a month, keyed on the month: an answer for another month
  // is stale, and stale-or-absent is what loading means, so the effect
  // never sets a loading flag of its own.
  const [loaded, setLoaded] = useState<
    | { period: string; phase: "error"; message: string }
    | { period: string; phase: "ready"; report: MemberUsageReport }
    | null
  >(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const monthId = useId();

  const state = loaded !== null && loaded.period === period ? loaded : { phase: "loading" as const };

  useEffect(() => {
    let alive = true;
    fetchMemberUsage(period)
      .then((report) => {
        if (alive) setLoaded({ period, phase: "ready", report });
      })
      .catch((err: unknown) => {
        if (alive) setLoaded({ period, phase: "error", message: failureMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [period]);

  async function exportCsv() {
    setExporting(true);
    setExportError(null);
    try {
      await downloadCsv(memberUsageCsvPath(period), `usage-${period}.csv`);
    } catch (err) {
      setExportError(failureMessage(err));
    } finally {
      setExporting(false);
    }
  }

  const own = state.phase === "ready" ? state.report.scope === "self" : !props.manages;
  const month = formatMonth(period);
  const errorMessage = state.phase === "error" ? state.message : null;
  return (
    <>
      <PaneSection
        title={own ? t`Your usage` : t`By member`}
        description={
          own
            ? t`Your own tokens and turns for ${month}.`
            : t`Weighted tokens, cost, turns and last turn per member for ${month}, biggest first.`
        }
        actions={
          <>
            <label htmlFor={monthId} className="sr-only">
              <Trans>Month</Trans>
            </label>
            <Input
              id={monthId}
              type="month"
              value={period}
              onChange={(event) => {
                if (event.target.value) setPeriod(event.target.value);
              }}
              className="w-44"
            />
            <Button
              type="button"
              variant="outline"
              disabled={exporting || state.phase !== "ready"}
              onClick={() => void exportCsv()}
            >
              {exporting ? t`Preparing…` : t`Download CSV`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {state.phase === "loading" && <LoadingSkeleton rows={2} />}
          {state.phase === "error" && errorMessage !== null && (
            <p role="alert" className="text-sm text-mw-danger">
              <Trans>Could not load usage by member: {errorMessage}</Trans>
            </p>
          )}
          {state.phase === "ready" && state.report.data.length === 0 && (
            <p className="text-sm text-mw-text-subtle">
              <Trans>Nothing used in {month}.</Trans>
            </p>
          )}
          {state.phase === "ready" && state.report.data.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label={t`Usage by member`}>
                <thead>
                  <tr className="text-left text-mw-text-subtle">
                    <th scope="col" className={TH_CLASS}>
                      <Trans>Member</Trans>
                    </th>
                    <th scope="col" className={TH_CLASS}>
                      <Trans>Weighted tokens</Trans>
                    </th>
                    <th scope="col" className={TH_CLASS}>
                      <Trans>Tokens</Trans>
                    </th>
                    <th scope="col" className={TH_CLASS}>
                      <Trans>At list price</Trans>
                    </th>
                    <th scope="col" className={TH_CLASS}>
                      <Trans>Turns</Trans>
                    </th>
                    <th scope="col" className="py-1.5 font-normal">
                      <Trans>Last active</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.report.data.map((row) => (
                    <tr key={row.subject} data-member={row.subject} className="border-t border-border">
                      <td className="py-1.5 pr-3 break-all">{memberLabel(row)}</td>
                      <td className={NUM_CLASS}>{formatNumber(row.weighted_tokens)}</td>
                      <td className={NUM_CLASS}>{formatNumber(row.tokens)}</td>
                      <td className={NUM_CLASS}>{formatMicros(row.cost_micros)}</td>
                      <td className={NUM_CLASS}>{formatNumber(row.turns)}</td>
                      <td className="py-1.5 whitespace-nowrap tabular-nums">
                        {row.last_active ? (
                          <time dateTime={row.last_active}>{formatLastActive(row.last_active)}</time>
                        ) : (
                          ""
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border font-medium">
                    <td className="py-1.5 pr-3">
                      <Trans>Total</Trans>
                    </td>
                    <td className={NUM_CLASS}>{formatNumber(state.report.totals.weighted_tokens)}</td>
                    <td className={NUM_CLASS}>{formatNumber(state.report.totals.tokens)}</td>
                    <td className={NUM_CLASS}>{formatMicros(state.report.totals.cost_micros)}</td>
                    <td className={NUM_CLASS}>{formatNumber(state.report.totals.turns)}</td>
                    <td className="py-1.5" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {exportError && (
            <p role="alert" className="text-sm text-mw-danger">
              {exportError}
            </p>
          )}
        </div>
      </PaneSection>

      {state.phase === "ready" && (
        <ConnectionsSection rows={state.report.by_connection} month={month} own={own} />
      )}
    </>
  );
}

/** The connection as a person reads it: its name while it exists, its id after. */
function connectionLabel(row: ConnectionUsage): string {
  return row.display_name ?? row.connection_id;
}

/**
 * The same month's connector spend per connection: what a workspace's
 * mentions cost, charged to their routes' paying members and so already
 * inside the per-member rows above, not on top of them.
 */
function ConnectionsSection(props: { rows: ConnectionUsage[]; month: string; own: boolean }) {
  const { t } = useLingui();
  const month = props.month;
  return (
    <PaneSection
      title={props.own ? t`Your usage by connection` : t`By connection`}
      description={
        props.own
          ? t`What connected workspaces charged to you in ${month}. Part of your usage above, not on top of it.`
          : t`What each connected workspace's mentions cost in ${month}, biggest first. Part of the rows above, not on top of them.`
      }
    >
      {props.rows.length === 0 ? (
        <p className="text-sm text-mw-text-subtle">
          <Trans>No connection was used in {month}.</Trans>
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={t`Usage by connection`}>
            <thead>
              <tr className="text-left text-mw-text-subtle">
                <th scope="col" className={TH_CLASS}>
                  <Trans>Connection</Trans>
                </th>
                <th scope="col" className={TH_CLASS}>
                  <Trans>Weighted tokens</Trans>
                </th>
                <th scope="col" className={TH_CLASS}>
                  <Trans>Tokens</Trans>
                </th>
                <th scope="col" className={TH_CLASS}>
                  <Trans>At list price</Trans>
                </th>
                <th scope="col" className={TH_CLASS}>
                  <Trans>Turns</Trans>
                </th>
                <th scope="col" className="py-1.5 font-normal">
                  <Trans>Last active</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row) => (
                <tr key={row.connection_id} data-connection={row.connection_id} className="border-t border-border">
                  <td className="py-1.5 pr-3 break-all">
                    {connectionLabel(row)}
                    {row.connector && <span className="block text-xs text-mw-text-subtle">{row.connector}</span>}
                  </td>
                  <td className={NUM_CLASS}>{formatNumber(row.weighted_tokens)}</td>
                  <td className={NUM_CLASS}>{formatNumber(row.tokens)}</td>
                  <td className={NUM_CLASS}>{formatMicros(row.cost_micros)}</td>
                  <td className={NUM_CLASS}>{formatNumber(row.turns)}</td>
                  <td className="py-1.5 whitespace-nowrap tabular-nums">
                    {row.last_active ? (
                      <time dateTime={row.last_active}>{formatLastActive(row.last_active)}</time>
                    ) : (
                      ""
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PaneSection>
  );
}
