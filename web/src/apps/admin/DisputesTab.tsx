import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "../../components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
import { formatMicros } from "../../lib/billing";
import { fetchDisputes, formatDate, type DisputeRow } from "./adminApi";
import { useLoad } from "./useLoad";

// Stripe's dispute statuses, and the two a fraud warning has here.
const STATUS_LABEL: Record<string, MessageDescriptor> = {
  needs_response: msg`Needs response`,
  warning_needs_response: msg`Inquiry: needs response`,
  under_review: msg`Under review`,
  warning_under_review: msg`Inquiry under review`,
  won: msg`Won`,
  lost: msg`Lost`,
  warning_closed: msg`Inquiry closed`,
  prevented: msg`Prevented`,
  open: msg`Fraud warning`,
  refunded: msg`Refunded`,
};

/**
 * Every chargeback and early fraud warning Stripe has reported: the open
 * ones first, soonest evidence deadline first, a deadline that has passed
 * unanswered in red; then the closed ones. Evidence is submitted in Stripe,
 * so each row links to the dispute's page there. docs/runbooks/chargeback.md
 * says what to collect.
 */
export function DisputesTab() {
  const [state, reload] = useLoad(fetchDisputes, "disputes");
  const { t } = useLingui();
  if (state.phase === "loading") return <LoadingSkeleton rows={3} />;
  if (state.phase === "error") {
    return <ErrorState title={t`Could not load disputes`} message={state.message} onRetry={reload} />;
  }
  const rows = state.data;
  if (rows.length === 0) {
    return (
      <EmptyState
        title={t`No disputes`}
        description={t`Chargebacks and Stripe's early fraud warnings appear here with their evidence deadlines.`}
      />
    );
  }
  return (
    <Table className="bg-card" aria-label={t`Disputes`}>
      <TableHeader>
        <TableRow>
          <TableHead>
            <Trans>Organisation</Trans>
          </TableHead>
          <TableHead>
            <Trans>Amount</Trans>
          </TableHead>
          <TableHead>
            <Trans>Reason</Trans>
          </TableHead>
          <TableHead>
            <Trans>Status</Trans>
          </TableHead>
          <TableHead>
            <Trans>Evidence due</Trans>
          </TableHead>
          <TableHead>
            <span className="sr-only">
              <Trans>Actions</Trans>
            </span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <DisputeLine key={row.id} row={row} />
        ))}
      </TableBody>
    </Table>
  );
}

function DisputeLine({ row }: { row: DisputeRow }) {
  const { t, i18n } = useLingui();
  const label = STATUS_LABEL[row.status];
  const orgName = row.org_name ?? t`Unknown organisation`;
  const invoice = row.invoice_number ?? row.invoice_id;
  const closed = row.closed_at !== null;
  return (
    <TableRow data-dispute-id={row.id} data-overdue={row.overdue || undefined}>
      <TableCell>
        <span className="font-medium">{orgName}</span>
        <div className="text-xs text-mw-text-muted">
          {row.kind === "fraud_warning" ? <Trans>Early fraud warning</Trans> : <Trans>Chargeback</Trans>}
          {invoice ? ` · ${invoice}` : ""}
        </div>
      </TableCell>
      <TableCell>
        {formatMicros(row.amount_micros)}
        {row.currency !== "usd" && <span className="ml-1 text-xs text-mw-text-muted">{row.currency.toUpperCase()}</span>}
      </TableCell>
      <TableCell className="text-sm">{row.reason ? row.reason.replaceAll("_", " ") : "—"}</TableCell>
      <TableCell>
        <Badge variant={closed ? (row.outcome === "lost" ? "destructive" : "secondary") : "warning"}>
          {label ? i18n._(label) : row.status}
        </Badge>
        {row.refund_id && (
          <div className="mt-1 text-xs text-mw-text-muted">
            <Trans>refunded, subscription cancelled</Trans>
          </div>
        )}
      </TableCell>
      <TableCell>
        {row.evidence_due_by && !closed ? (
          <span className={row.overdue ? "font-medium text-mw-danger" : undefined}>
            {formatDate(row.evidence_due_by, { dateStyle: "medium", timeStyle: "short" })}
            {row.overdue && (
              <span className="block text-xs">
                <Trans>past due</Trans>
              </span>
            )}
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="text-right">
        <a href={row.dashboard_url} target="_blank" rel="noreferrer" className="text-sm underline">
          <Trans>Open in Stripe</Trans>
        </a>
      </TableCell>
    </TableRow>
  );
}
