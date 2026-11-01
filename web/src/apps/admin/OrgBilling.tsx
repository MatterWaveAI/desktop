import { useId, useState, type FormEvent } from "react";
import { i18n } from "@lingui/core";
import { msg, plural, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../components/ui/table";
import { Input } from "../../components/ui/input";
import { SimpleSelect } from "../../components/ui/select";
import { DestructiveConfirm, ErrorState, LoadingSkeleton } from "../../patterns";
import { MICROS_PER_USD, formatMicros, type BillingInvoice } from "../../lib/billing";
import { failureMessage } from "../../shell/authForms";
import {
  STAGE_LABEL,
  extendGrace,
  fetchOrgBilling,
  formatDate,
  markInvoicePaid,
  resendInvoice,
  saveDunningPolicy,
  switchToCard,
  switchToInvoicing,
  type DunningOverride,
  type DunningPolicy,
  type OrgBilling,
} from "./adminApi";
import { PlanSelect } from "./OrgPlan";
import { useLoad, usePlanCatalog } from "./useLoad";

/**
 * One organisation's money as the operator manages it: where its late
 * payment stands, its own late-payment policy, how Stripe collects from it,
 * and its invoices -- with the actions that go with each.
 *
 * Every action answers with the org's billing as it now stands, so the
 * panel replaces what it shows with the server's word rather than guessing.
 * The policy form refuses nothing itself beyond the obvious: the ceilings
 * are the server's, and a value past one comes back as its 422, said here.
 */
export function OrgBillingPanel({ orgId, orgName, onChanged }: { orgId: string; orgName: string; onChanged?: () => void }) {
  const [state, reload] = useLoad(() => fetchOrgBilling(orgId), orgId);
  const [latest, setLatest] = useState<OrgBilling | null>(null);
  const billing = latest ?? (state.phase === "ready" ? state.data : null);
  const { t } = useLingui();

  function applied(next: OrgBilling) {
    setLatest(next);
    onChanged?.();
  }

  if (state.phase === "loading" && !billing) return <LoadingSkeleton rows={3} />;
  if (state.phase === "error" && !billing) {
    return <ErrorState title={t`Could not load billing`} message={state.message} onRetry={reload} />;
  }
  if (!billing) return null;
  return (
    <div className="space-y-6" aria-label={t`${orgName} billing`}>
      <LateSummary billing={billing} orgId={orgId} orgName={orgName} onApplied={applied} />
      <PolicyEditor billing={billing} orgId={orgId} orgName={orgName} onApplied={applied} />
      <InvoicingEditor billing={billing} orgId={orgId} orgName={orgName} onApplied={applied} />
      <InvoiceList billing={billing} orgId={orgId} orgName={orgName} onApplied={applied} />
    </div>
  );
}

type SectionProps = { billing: OrgBilling; orgId: string; orgName: string; onApplied: (next: OrgBilling) => void };

function Message({ error, saved }: { error: string | null; saved: string | null }) {
  return (
    <>
      {saved && (
        <p role="status" className="mt-1 text-sm text-mw-text-muted">
          {saved}
        </p>
      )}
      {error && (
        <Alert role="alert" variant="danger" className="mt-1">
          {error}
        </Alert>
      )}
    </>
  );
}

/** Where the late payment stands, and extra grace for it. */
function LateSummary({ billing, orgId, orgName, onApplied }: SectionProps) {
  const id = useId();
  const [days, setDays] = useState("7");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const late = billing.dunning;
  const parsed = /^\d+$/.test(days.trim()) ? Number(days.trim()) : 0;
  const { t } = useLingui();

  async function extend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (parsed < 1) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await extendGrace(orgId, parsed, reason);
      const total = next.grace_days;
      setSaved(
        plural(parsed, {
          one: `Grace extended by # day; ${total} in all.`,
          other: `Grace extended by # days; ${total} in all.`,
        }),
      );
      setReason("");
      onApplied(next);
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`} className="text-sm font-medium text-mw-text">
        <Trans>Late payment</Trans>
      </h4>
      {!late ? (
        <p className="mt-1 text-sm text-mw-text-muted">
          <Trans>In good standing: nothing is overdue.</Trans>
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm" data-dunning-stage={late.stage}>
            <Badge variant={late.stage === "warn" || late.stage === "pending" ? "warning" : "destructive"}>
              {i18n._(STAGE_LABEL[late.stage])}
            </Badge>{" "}
            {lateSentence(late, billing.grace_days)}
          </p>
          <p className="mt-1 text-xs text-mw-text-muted">
            <SafetyLimit days={billing.policy.max_days_overdue} at={formatDate(late.schedule.days_limit_at)} />
          </p>
          <form onSubmit={extend} className="mt-2 flex flex-wrap items-end gap-2">
            <label htmlFor={`${id}-days`} className="sr-only">
              <Trans>Days of grace for {orgName}</Trans>
            </label>
            <Input
              id={`${id}-days`}
              inputMode="numeric"
              value={days}
              disabled={busy}
              onChange={(event) => setDays(event.target.value)}
              className="max-w-20"
            />
            <Input
              aria-label={t`Reason for the extension`}
              placeholder={t`Reason (kept in the audit log)`}
              value={reason}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              className="max-w-sm"
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy || parsed < 1}>
              <Trans>Extend grace for {orgName}</Trans>
            </Button>
          </form>
        </>
      )}
      <Message error={error} saved={saved} />
    </section>
  );
}

/** "Grace moves the stage dates back; it never moves the safety limit of 60 days overdue (…)." */
function SafetyLimit({ days, at }: { days: number; at: string }) {
  return (
    <>
      {plural(days, {
        one: `Grace moves the stage dates back; it never moves the safety limit of # day overdue (${at}).`,
        other: `Grace moves the stage dates back; it never moves the safety limit of # days overdue (${at}).`,
      })}
    </>
  );
}

/** Where a late payment stands, as one line beside its stage badge. */
function lateSentence(late: NonNullable<OrgBilling["dunning"]>, graceDays: number): string {
  const outstanding = formatMicros(late.outstanding_micros);
  const since = formatDate(late.first_overdue_at);
  const daysOverdue = late.days_overdue;
  const parts = [
    late.source === "card"
      ? plural(daysOverdue, {
          one: `${outstanding} outstanding, # day overdue (card failed ${since}).`,
          other: `${outstanding} outstanding, # days overdue (card failed ${since}).`,
        })
      : plural(daysOverdue, {
          one: `${outstanding} outstanding, # day overdue (invoice past due ${since}).`,
          other: `${outstanding} outstanding, # days overdue (invoice past due ${since}).`,
        }),
  ];
  if (late.next_step) {
    const nextStage = i18n._(STAGE_LABEL[late.next_step.stage]).toLowerCase();
    const nextOn = formatDate(late.next_step.at);
    parts.push(t`Next: ${nextStage} on ${nextOn}.`);
  } else {
    parts.push(t`No further step.`);
  }
  if (graceDays > 0) {
    parts.push(plural(graceDays, { one: "# day of grace given.", other: "# days of grace given." }));
  }
  if (late.overage_stopped) parts.push(t`Overage stopped by the amount limit.`);
  return parts.join(" ");
}

const DAY_FIELDS = [
  ["warn_day", msg`Warn on day`],
  ["warn_final_day", msg`Final warning on day`],
  ["limited_day", msg`Limited on day`],
  ["suspended_day", msg`On Free on day`],
  ["max_days_overdue", msg`Limited regardless after (days)`],
] as const;

const SWITCH_FIELDS = [
  ["auto_suspend", msg`Moves to Free at the suspend day`],
  ["limited_stops_overage", msg`Limited stops overage`],
  ["limited_blocks_new_keys", msg`Limited pauses new API keys and rotation`],
  ["limited_blocks_upgrades", msg`Limited holds plan upgrades`],
] as const;

type Draft = Record<string, string>;

/** The switch's "use the platform's value" choice; the draft keeps it as "". */
const DEFAULT_CHOICE = "default";

function draftOf(override: DunningOverride): Draft {
  const draft: Draft = {};
  for (const [name] of DAY_FIELDS) draft[name] = override[name] === undefined ? "" : String(override[name]);
  for (const [name] of SWITCH_FIELDS) draft[name] = override[name] === undefined ? "" : String(override[name]);
  draft.max_outstanding =
    override.max_outstanding_micros === undefined ? "" : String(override.max_outstanding_micros / MICROS_PER_USD);
  draft.note = override.note ?? "";
  return draft;
}

/** The draft as the body the API takes, or a message saying which field is not a number. */
function overrideOf(draft: Draft): DunningOverride | string {
  const out: Record<string, unknown> = {};
  for (const [name, label] of DAY_FIELDS) {
    const value = draft[name].trim();
    if (value === "") continue;
    const field = i18n._(label);
    if (!/^\d+$/.test(value)) return t`${field}: a whole number of days, or blank for the default.`;
    out[name] = Number(value);
  }
  for (const [name] of SWITCH_FIELDS) {
    if (draft[name] !== "") out[name] = draft[name] === "true";
  }
  const amount = draft.max_outstanding.trim();
  if (amount !== "") {
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars < 0) return t`Outstanding limit: dollars, or blank for the default.`;
    out.max_outstanding_micros = Math.round(dollars * 100) * (MICROS_PER_USD / 100);
  }
  if (draft.note.trim()) out.note = draft.note.trim();
  return out as DunningOverride;
}

function platformValue(policy: DunningPolicy, name: string): string {
  const value = policy[name as keyof DunningPolicy];
  if (typeof value === "boolean") return value ? t`on` : t`off`;
  return String(value);
}

/** The org's own late-payment policy: blank inherits the platform default shown beside it. */
function PolicyEditor({ billing, orgId, orgName, onApplied }: SectionProps) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(billing.override));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const platform = billing.platform_policy;
  const { t, i18n } = useLingui();
  const maxDays = billing.limits.max_days_overdue_ceiling;
  const maxOutstanding = formatMicros(billing.limits.max_outstanding_ceiling_micros);
  const defaultLabel = (platformSays: string) => t`Default (${platformSays})`;

  async function save(override: DunningOverride) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await saveDunningPolicy(orgId, override);
      setDraft(draftOf(next.override));
      setSaved(next.policy.overridden ? t`Policy saved.` : t`Policy cleared: the platform default applies.`);
      onApplied(next);
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = overrideOf(draft);
    if (typeof body === "string") {
      setError(body);
      return;
    }
    void save(body);
  }

  const set = (name: string) => (value: string) => setDraft((d) => ({ ...d, [name]: value }));

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`} className="text-sm font-medium text-mw-text">
        <Trans>Late-payment policy</Trans>{" "}
        {billing.policy.overridden ? (
          <Badge variant="secondary">
            <Trans>own</Trans>
          </Badge>
        ) : (
          <Badge variant="outline">
            <Trans>default</Trans>
          </Badge>
        )}
      </h4>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>
          Blank uses the platform default, shown as the placeholder. No value may pass {maxDays} days overdue or{" "}
          {maxOutstanding} outstanding.
        </Trans>
      </p>
      <form onSubmit={submit} className="mt-2 grid gap-2 sm:grid-cols-2">
        {DAY_FIELDS.map(([name, label]) => (
          <label key={name} className="flex flex-col gap-1 text-xs text-mw-text-muted">
            {i18n._(label)}
            <Input
              inputMode="numeric"
              placeholder={platformValue(platform, name)}
              value={draft[name]}
              disabled={busy}
              onChange={(event) => set(name)(event.target.value)}
            />
          </label>
        ))}
        <label className="flex flex-col gap-1 text-xs text-mw-text-muted">
          <Trans>Outstanding limit (US dollars)</Trans>
          <Input
            inputMode="decimal"
            placeholder={String(platform.max_outstanding_micros / MICROS_PER_USD)}
            value={draft.max_outstanding}
            disabled={busy}
            onChange={(event) => set("max_outstanding")(event.target.value)}
          />
        </label>
        {SWITCH_FIELDS.map(([name, label]) => (
          <div key={name} className="flex flex-col gap-1 text-xs text-mw-text-muted">
            <label htmlFor={`${id}-${name}`}>{i18n._(label)}</label>
            <SimpleSelect
              id={`${id}-${name}`}
              value={draft[name] || DEFAULT_CHOICE}
              disabled={busy}
              onValueChange={(choice) => set(name)(choice === DEFAULT_CHOICE ? "" : choice)}
              options={[
                { value: DEFAULT_CHOICE, label: defaultLabel(platformValue(platform, name)) },
                { value: "true", label: t`On` },
                { value: "false", label: t`Off` },
              ]}
              className="w-full"
            />
          </div>
        ))}
        <label className="flex flex-col gap-1 text-xs text-mw-text-muted sm:col-span-2">
          <Trans>Why (shown in the Overdue list)</Trans>
          <Input value={draft.note} maxLength={500} disabled={busy} onChange={(event) => set("note")(event.target.value)} />
        </label>
        <span className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" size="sm" variant="outline" disabled={busy}>
            <Trans>Save policy for {orgName}</Trans>
          </Button>
          {billing.policy.overridden && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save({})}>
              <Trans>Use the platform default</Trans>
            </Button>
          )}
        </span>
      </form>
      <Message error={error} saved={saved} />
    </section>
  );
}

/** Card or invoices: the switch both ways, with net terms, the billing address and the PO number. */
function InvoicingEditor({ billing, orgId, orgName, onApplied }: SectionProps) {
  const id = useId();
  const byInvoice = billing.collection_method === "send_invoice";
  const [terms, setTerms] = useState<"15" | "30" | "60">(
    billing.days_until_due === 15 || billing.days_until_due === 60 ? (String(billing.days_until_due) as "15" | "60") : "30",
  );
  const [email, setEmail] = useState(billing.invoicing?.billing_email ?? "");
  const [po, setPo] = useState(billing.invoicing?.po_number ?? "");
  const [plan, setPlan] = useState("");
  const catalog = usePlanCatalog();
  const [annual, setAnnual] = useState(false);
  const [confirmCard, setConfirmCard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const { t } = useLingui();

  async function run(action: () => Promise<OrgBilling>, done: string) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await action();
      setSaved(done);
      setConfirmCard(false);
      onApplied(next);
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(
      () =>
        switchToInvoicing(orgId, {
          terms: Number(terms) as 15 | 30 | 60,
          billing_email: email.trim(),
          po_number: po.trim() || null,
          plan: plan.trim() || null,
          annual,
        }),
      t`Billed by invoice, net ${terms}.`,
    );
  }

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`} className="text-sm font-medium text-mw-text">
        <Trans>How {orgName} pays</Trans>
      </h4>
      <p className="mt-1 text-sm text-mw-text-muted">
        {byInvoice ? invoicingSummary(billing) : <Trans>By card, through Checkout and the customer portal.</Trans>}
      </p>
      <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1 text-xs text-mw-text-muted">
          <label htmlFor={`${id}-terms`}>
            <Trans>Net terms</Trans>
          </label>
          <SimpleSelect<"15" | "30" | "60">
            id={`${id}-terms`}
            value={terms}
            disabled={busy}
            onValueChange={setTerms}
            options={[
              { value: "15", label: t`15 days` },
              { value: "30", label: t`30 days` },
              { value: "60", label: t`60 days` },
            ]}
          />
        </div>
        <label className="flex flex-col gap-1 text-xs text-mw-text-muted">
          <Trans>Billing email</Trans>
          <Input type="email" value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-mw-text-muted">
          <Trans>PO number</Trans>
          <Input value={po} maxLength={140} disabled={busy} onChange={(event) => setPo(event.target.value)} />
        </label>
        {!byInvoice && (
          <>
            <div className="flex flex-col gap-1 text-xs text-mw-text-muted">
              <label htmlFor={`${id}-plan`}>
                <Trans>Plan, if it has no subscription yet</Trans>
              </label>
              <PlanSelect
                id={`${id}-plan`}
                plans={catalog}
                value={plan}
                blank={t`Keep its plan`}
                disabled={busy}
                onChange={setPlan}
              />
            </div>
            <label className="flex items-center gap-1 text-xs text-mw-text-muted">
              <input type="checkbox" checked={annual} disabled={busy} onChange={(event) => setAnnual(event.target.checked)} />
              <Trans>Annual</Trans>
            </label>
          </>
        )}
        <Button type="submit" size="sm" variant="outline" disabled={busy || !email.trim()}>
          {byInvoice ? <Trans>Update invoicing for {orgName}</Trans> : <Trans>Bill {orgName} by invoice</Trans>}
        </Button>
        {byInvoice && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmCard(true)}>
            <Trans>Switch {orgName} back to card</Trans>
          </Button>
        )}
      </form>
      <Message error={error} saved={saved} />
      <DestructiveConfirm
        open={confirmCard}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmCard(false);
        }}
        title={t`Bill ${orgName} by card?`}
        description={t`The next invoice is charged to the card on file. If there is none, it fails into the late-payment schedule, so ask the owner to add one in Settings > Billing first.`}
        confirmLabel={t`Switch to card`}
        inFlight={busy}
        onConfirm={() => void run(() => switchToCard(orgId), t`Billed by card again.`)}
      />
    </section>
  );
}

/** "Billed by invoice, net 30, to ap@acme.test, PO PO-7781. Stripe emails …" */
function invoicingSummary(billing: OrgBilling): string {
  const terms = billing.days_until_due === null ? "?" : String(billing.days_until_due);
  const email = billing.invoicing?.billing_email;
  const po = billing.invoicing?.po_number;
  const reminders = t`Stripe emails each invoice and its reminders.`;
  if (email && po) return `${t`Billed by invoice, net ${terms}, to ${email}, PO ${po}.`} ${reminders}`;
  if (email) return `${t`Billed by invoice, net ${terms}, to ${email}.`} ${reminders}`;
  return `${t`Billed by invoice, net ${terms}.`} ${reminders}`;
}

/** An invoice's status as Stripe names it, in the reader's language where it is one we know. */
function invoiceStatus(status: BillingInvoice["status"]): string {
  switch (status) {
    case "draft":
      return t`draft`;
    case "open":
      return t`open`;
    case "paid":
      return t`paid`;
    case "uncollectible":
      return t`uncollectible`;
    case "void":
      return t`void`;
    default:
      return status;
  }
}

const UNPAID = new Set<BillingInvoice["status"]>(["open", "uncollectible"]);

/** The org's invoices, with mark-paid and resend on the unpaid ones. */
function InvoiceList({ billing, orgId, orgName, onApplied }: SectionProps) {
  const id = useId();
  const [pending, setPending] = useState<BillingInvoice | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const { t } = useLingui();
  const pendingNumber = pending ? (pending.number ?? pending.id) : "";

  async function markPaid() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await markInvoicePaid(orgId, pending.id, reason);
      setSaved(t`${pendingNumber} marked paid.`);
      setPending(null);
      setReason("");
      onApplied(next);
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend(invoice: BillingInvoice) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await resendInvoice(orgId, invoice.id);
      const invoiceNumber = invoice.number ?? invoice.id;
      setSaved(t`${invoiceNumber} sent again.`);
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`} className="mb-2 text-sm font-medium text-mw-text">
        <Trans>Invoices</Trans>
      </h4>
      {billing.invoices.length === 0 ? (
        <p className="text-sm text-mw-text-muted">
          <Trans>No invoices recorded.</Trans>
        </p>
      ) : (
        <Table className="bg-card" aria-label={t`${orgName} invoices`}>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>Invoice</Trans>
              </TableHead>
              <TableHead>
                <Trans>Amount</Trans>
              </TableHead>
              <TableHead>
                <Trans>Status</Trans>
              </TableHead>
              <TableHead>
                <Trans>Due</Trans>
              </TableHead>
              <TableHead>
                <span className="sr-only">
                  <Trans>Actions</Trans>
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {billing.invoices.map((invoice) => {
              const invoiceNumber = invoice.number ?? invoice.id;
              const remaining = formatMicros(invoice.amount_remaining_micros);
              return (
              <TableRow key={invoice.id} className="border-b border-mw-border">
                <TableCell>
                  {invoice.hosted_invoice_url ? (
                    <a href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer" className="underline">
                      {invoice.number ?? invoice.id}
                    </a>
                  ) : (
                    (invoice.number ?? invoice.id)
                  )}
                  <div className="text-xs text-mw-text-muted">{formatDate(invoice.issued_at)}</div>
                </TableCell>
                <TableCell>
                  {formatMicros(invoice.amount_due_micros)}
                  {UNPAID.has(invoice.status) && invoice.amount_remaining_micros !== invoice.amount_due_micros && (
                    <div className="text-xs text-mw-text-muted">
                      <Trans>{remaining} left</Trans>
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={UNPAID.has(invoice.status) ? "destructive" : "secondary"}>
                    {invoiceStatus(invoice.status)}
                  </Badge>
                  {invoice.dispute_status && (
                    <div className="mt-1 text-xs text-mw-danger">
                      {invoice.dispute_status === "lost" ? <Trans>chargeback lost</Trans> : <Trans>disputed</Trans>}
                    </div>
                  )}
                </TableCell>
                <TableCell>{invoice.due_at ? formatDate(invoice.due_at) : <Trans>On issue</Trans>}</TableCell>
                <TableCell className="text-right">
                  {UNPAID.has(invoice.status) && (
                    <span className="inline-flex flex-wrap justify-end gap-1">
                      {invoice.collection_method === "send_invoice" && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void resend(invoice)}>
                          <Trans>Resend {invoiceNumber}</Trans>
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setError(null);
                          setPending(invoice);
                        }}
                      >
                        <Trans>Mark {invoiceNumber} paid</Trans>
                      </Button>
                    </span>
                  )}
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <Message error={error} saved={saved} />
      <DestructiveConfirm
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
        title={pending ? t`Mark ${pendingNumber} paid outside Stripe?` : t`Mark paid?`}
        description={
          <span className="flex flex-col gap-2">
            <span>
              <Trans>
                Stripe records it as paid out of band and stops collecting it. Use this only for money that arrived
                another way; it is recorded in the audit log under your name.
              </Trans>
            </span>
            <Input
              aria-label={t`How it was paid`}
              placeholder={t`How it was paid (wire reference, cheque number)`}
              value={reason}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </span>
        }
        confirmLabel={t`Mark paid`}
        inFlight={busy}
        onConfirm={() => void markPaid()}
      />
    </section>
  );
}
