import { useId, useState, type FormEvent } from "react";
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

  function applied(next: OrgBilling) {
    setLatest(next);
    onChanged?.();
  }

  if (state.phase === "loading" && !billing) return <LoadingSkeleton rows={3} />;
  if (state.phase === "error" && !billing) {
    return <ErrorState title="Could not load billing" message={state.message} onRetry={reload} />;
  }
  if (!billing) return null;
  return (
    <div className="space-y-6" aria-label={`${orgName} billing`}>
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

  async function extend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (parsed < 1) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await extendGrace(orgId, parsed, reason);
      setSaved(`Grace extended by ${parsed} day${parsed === 1 ? "" : "s"}; ${next.grace_days} in all.`);
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
        Late payment
      </h4>
      {!late ? (
        <p className="mt-1 text-sm text-mw-text-muted">In good standing: nothing is overdue.</p>
      ) : (
        <>
          <p className="mt-1 text-sm" data-dunning-stage={late.stage}>
            <Badge variant={late.stage === "warn" || late.stage === "pending" ? "warning" : "destructive"}>
              {STAGE_LABEL[late.stage]}
            </Badge>{" "}
            {formatMicros(late.outstanding_micros)} outstanding, {late.days_overdue} day
            {late.days_overdue === 1 ? "" : "s"} overdue ({late.source === "card" ? "card failed" : "invoice past due"}{" "}
            {formatDate(late.first_overdue_at)}).
            {late.next_step
              ? ` Next: ${STAGE_LABEL[late.next_step.stage].toLowerCase()} on ${formatDate(late.next_step.at)}.`
              : " No further step."}
            {billing.grace_days > 0 && ` ${billing.grace_days} day(s) of grace given.`}
            {late.overage_stopped && " Overage stopped by the amount limit."}
          </p>
          <p className="mt-1 text-xs text-mw-text-muted">
            Grace moves the stage dates back; it never moves the safety limit of{" "}
            {billing.policy.max_days_overdue} days overdue ({formatDate(late.schedule.days_limit_at)}).
          </p>
          <form onSubmit={extend} className="mt-2 flex flex-wrap items-end gap-2">
            <label htmlFor={`${id}-days`} className="sr-only">
              Days of grace for {orgName}
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
              aria-label="Reason for the extension"
              placeholder="Reason (kept in the audit log)"
              value={reason}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              className="max-w-sm"
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy || parsed < 1}>
              Extend grace for {orgName}
            </Button>
          </form>
        </>
      )}
      <Message error={error} saved={saved} />
    </section>
  );
}

const DAY_FIELDS = [
  ["warn_day", "Warn on day"],
  ["warn_final_day", "Final warning on day"],
  ["limited_day", "Limited on day"],
  ["suspended_day", "On Free on day"],
  ["max_days_overdue", "Limited regardless after (days)"],
] as const;

const SWITCH_FIELDS = [
  ["auto_suspend", "Moves to Free at the suspend day"],
  ["limited_stops_overage", "Limited stops overage"],
  ["limited_blocks_new_keys", "Limited pauses new API keys and rotation"],
  ["limited_blocks_upgrades", "Limited holds plan upgrades"],
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
    if (!/^\d+$/.test(value)) return `${label}: a whole number of days, or blank for the default.`;
    out[name] = Number(value);
  }
  for (const [name] of SWITCH_FIELDS) {
    if (draft[name] !== "") out[name] = draft[name] === "true";
  }
  const amount = draft.max_outstanding.trim();
  if (amount !== "") {
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars < 0) return "Outstanding limit: dollars, or blank for the default.";
    out.max_outstanding_micros = Math.round(dollars * 100) * (MICROS_PER_USD / 100);
  }
  if (draft.note.trim()) out.note = draft.note.trim();
  return out as DunningOverride;
}

function platformValue(policy: DunningPolicy, name: string): string {
  const value = policy[name as keyof DunningPolicy];
  if (typeof value === "boolean") return value ? "on" : "off";
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

  async function save(override: DunningOverride) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await saveDunningPolicy(orgId, override);
      setDraft(draftOf(next.override));
      setSaved(next.policy.overridden ? "Policy saved." : "Policy cleared: the platform default applies.");
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
        Late-payment policy {billing.policy.overridden ? <Badge variant="secondary">own</Badge> : <Badge variant="outline">default</Badge>}
      </h4>
      <p className="mt-1 text-sm text-mw-text-muted">
        Blank uses the platform default, shown as the placeholder. No value may pass{" "}
        {billing.limits.max_days_overdue_ceiling} days overdue or{" "}
        {formatMicros(billing.limits.max_outstanding_ceiling_micros)} outstanding.
      </p>
      <form onSubmit={submit} className="mt-2 grid gap-2 sm:grid-cols-2">
        {DAY_FIELDS.map(([name, label]) => (
          <label key={name} className="flex flex-col gap-1 text-xs text-mw-text-muted">
            {label}
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
          Outstanding limit (US dollars)
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
            <label htmlFor={`${id}-${name}`}>{label}</label>
            <SimpleSelect
              id={`${id}-${name}`}
              value={draft[name] || DEFAULT_CHOICE}
              disabled={busy}
              onValueChange={(choice) => set(name)(choice === DEFAULT_CHOICE ? "" : choice)}
              options={[
                { value: DEFAULT_CHOICE, label: `Default (${platformValue(platform, name)})` },
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
              ]}
              className="w-full"
            />
          </div>
        ))}
        <label className="flex flex-col gap-1 text-xs text-mw-text-muted sm:col-span-2">
          Why (shown in the Overdue list)
          <Input value={draft.note} maxLength={500} disabled={busy} onChange={(event) => set("note")(event.target.value)} />
        </label>
        <span className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" size="sm" variant="outline" disabled={busy}>
            Save policy for {orgName}
          </Button>
          {billing.policy.overridden && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save({})}>
              Use the platform default
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
      `Billed by invoice, net ${terms}.`,
    );
  }

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`} className="text-sm font-medium text-mw-text">
        How {orgName} pays
      </h4>
      <p className="mt-1 text-sm text-mw-text-muted">
        {byInvoice
          ? `Billed by invoice, net ${billing.days_until_due ?? "?"}${
              billing.invoicing ? `, to ${billing.invoicing.billing_email}` : ""
            }${billing.invoicing?.po_number ? `, PO ${billing.invoicing.po_number}` : ""}. Stripe emails each invoice and its reminders.`
          : "By card, through Checkout and the customer portal."}
      </p>
      <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1 text-xs text-mw-text-muted">
          <label htmlFor={`${id}-terms`}>Net terms</label>
          <SimpleSelect<"15" | "30" | "60">
            id={`${id}-terms`}
            value={terms}
            disabled={busy}
            onValueChange={setTerms}
            options={[
              { value: "15", label: "15 days" },
              { value: "30", label: "30 days" },
              { value: "60", label: "60 days" },
            ]}
          />
        </div>
        <label className="flex flex-col gap-1 text-xs text-mw-text-muted">
          Billing email
          <Input type="email" value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-mw-text-muted">
          PO number
          <Input value={po} maxLength={140} disabled={busy} onChange={(event) => setPo(event.target.value)} />
        </label>
        {!byInvoice && (
          <>
            <div className="flex flex-col gap-1 text-xs text-mw-text-muted">
              <label htmlFor={`${id}-plan`}>Plan, if it has no subscription yet</label>
              <PlanSelect
                id={`${id}-plan`}
                plans={catalog}
                value={plan}
                blank="Keep its plan"
                disabled={busy}
                onChange={setPlan}
              />
            </div>
            <label className="flex items-center gap-1 text-xs text-mw-text-muted">
              <input type="checkbox" checked={annual} disabled={busy} onChange={(event) => setAnnual(event.target.checked)} />
              Annual
            </label>
          </>
        )}
        <Button type="submit" size="sm" variant="outline" disabled={busy || !email.trim()}>
          {byInvoice ? `Update invoicing for ${orgName}` : `Bill ${orgName} by invoice`}
        </Button>
        {byInvoice && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmCard(true)}>
            Switch {orgName} back to card
          </Button>
        )}
      </form>
      <Message error={error} saved={saved} />
      <DestructiveConfirm
        open={confirmCard}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmCard(false);
        }}
        title={`Bill ${orgName} by card?`}
        description="The next invoice is charged to the card on file. If there is none, it fails into the late-payment schedule, so ask the owner to add one in Settings > Billing first."
        confirmLabel="Switch to card"
        inFlight={busy}
        onConfirm={() => void run(() => switchToCard(orgId), "Billed by card again.")}
      />
    </section>
  );
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

  async function markPaid() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await markInvoicePaid(orgId, pending.id, reason);
      setSaved(`${pending.number ?? pending.id} marked paid.`);
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
      setSaved(`${invoice.number ?? invoice.id} sent again.`);
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`} className="mb-2 text-sm font-medium text-mw-text">
        Invoices
      </h4>
      {billing.invoices.length === 0 ? (
        <p className="text-sm text-mw-text-muted">No invoices recorded.</p>
      ) : (
        <Table className="bg-card" aria-label={`${orgName} invoices`}>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {billing.invoices.map((invoice) => (
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
                    <div className="text-xs text-mw-text-muted">{formatMicros(invoice.amount_remaining_micros)} left</div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={UNPAID.has(invoice.status) ? "destructive" : "secondary"}>{invoice.status}</Badge>
                </TableCell>
                <TableCell>{invoice.due_at ? formatDate(invoice.due_at) : "On issue"}</TableCell>
                <TableCell className="text-right">
                  {UNPAID.has(invoice.status) && (
                    <span className="inline-flex flex-wrap justify-end gap-1">
                      {invoice.collection_method === "send_invoice" && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void resend(invoice)}>
                          Resend {invoice.number ?? invoice.id}
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
                        Mark {invoice.number ?? invoice.id} paid
                      </Button>
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Message error={error} saved={saved} />
      <DestructiveConfirm
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
        title={pending ? `Mark ${pending.number ?? pending.id} paid outside Stripe?` : "Mark paid?"}
        description={
          <span className="flex flex-col gap-2">
            <span>
              Stripe records it as paid out of band and stops collecting it. Use this only for money that arrived
              another way; it is recorded in the audit log under your name.
            </span>
            <Input
              aria-label="How it was paid"
              placeholder="How it was paid (wire reference, cheque number)"
              value={reason}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </span>
        }
        confirmLabel="Mark paid"
        inFlight={busy}
        onConfirm={() => void markPaid()}
      />
    </section>
  );
}
