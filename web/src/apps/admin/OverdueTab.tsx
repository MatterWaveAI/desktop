import { useState } from "react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
import { formatNumber } from "../../i18n/format";
import { formatMicros } from "../../lib/billing";
import { OrgBillingPanel } from "./OrgBilling";
import { STAGE_LABEL, fetchOverdue, formatDate, type OverdueRow } from "./adminApi";
import { useLoad } from "./useLoad";

/**
 * Every organisation not in good standing, on one page: its stage, how
 * late, how much, the next step and its date, whether it runs on the
 * platform's late-payment policy or its own (and why), and which safety
 * limit has fired. Each row opens the org's billing beneath it -- extend
 * the grace, edit the policy, mark an invoice paid, resend one, switch to
 * invoice billing -- every one audited.
 */
export function OverdueTab() {
  const [state, reload] = useLoad(fetchOverdue, "overdue");
  const [open, setOpen] = useState<string | null>(null);
  const { t } = useLingui();
  if (state.phase === "loading") return <LoadingSkeleton rows={3} />;
  if (state.phase === "error") {
    return <ErrorState title={t`Could not load overdue organisations`} message={state.message} onRetry={reload} />;
  }
  const { rows, limits } = state.data;
  if (rows.length === 0) {
    return (
      <EmptyState
        title={t`Nobody is overdue`}
        description={t`Organisations with a failed card or an invoice past its due date appear here.`}
      />
    );
  }
  const maxDays = limits.max_days_overdue_ceiling;
  const lateCount = rows.length;
  const maxOutstanding = formatMicros(limits.max_outstanding_ceiling_micros);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-mw-text-muted">
        {plural(lateCount, {
          one: `# organisation late. Whatever a policy says, an org is limited past its days-overdue limit (at most ${maxDays} days) and its overage stops past its outstanding limit (at most ${maxOutstanding}).`,
          other: `# organisations late. Whatever a policy says, an org is limited past its days-overdue limit (at most ${maxDays} days) and its overage stops past its outstanding limit (at most ${maxOutstanding}).`,
        })}
      </p>
      <Table className="bg-card" aria-label={t`Overdue organisations`}>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Organisation</Trans>
            </TableHead>
            <TableHead>
              <Trans>Stage</Trans>
            </TableHead>
            <TableHead>
              <Trans>Days overdue</Trans>
            </TableHead>
            <TableHead>
              <Trans>Outstanding</Trans>
            </TableHead>
            <TableHead>
              <Trans>Next step</Trans>
            </TableHead>
            <TableHead>
              <Trans>Policy</Trans>
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
            <OverdueLine
              key={row.org_id}
              row={row}
              open={open === row.org_id}
              onToggle={() => setOpen((current) => (current === row.org_id ? null : row.org_id))}
              onChanged={reload}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function OverdueLine({
  row,
  open,
  onToggle,
  onChanged,
}: {
  row: OverdueRow;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useLingui();
  const orgName = row.org_name;
  // A plan code, as the catalog names it; no plan is the free one.
  const planCode = row.plan ?? "free";
  const terms = row.days_until_due === null ? "?" : String(row.days_until_due);
  const graceDays = row.grace_days;
  const nextStage = row.next_step ? i18n._(STAGE_LABEL[row.next_step.stage]) : "";
  const nextOn = row.next_step ? formatDate(row.next_step.at) : "";
  return (
    <>
      <TableRow data-overdue-stage={row.stage}>
        <TableCell>
          <span className="font-medium">{row.org_name}</span>
          <div className="text-xs text-mw-text-muted">
            {planCode} · {row.collection_method === "send_invoice" ? t`invoice, net ${terms}` : t`card`}
          </div>
        </TableCell>
        <TableCell>
          <Badge variant={row.stage === "warn" || row.stage === "pending" ? "warning" : "destructive"}>
            {i18n._(STAGE_LABEL[row.stage])}
          </Badge>
          {row.days_limit_hit_at && (
            <div className="mt-1 text-xs text-mw-danger">
              <Trans>days limit reached</Trans>
            </div>
          )}
          {row.amount_limit_hit_at && (
            <div className="mt-1 text-xs text-mw-danger">
              <Trans>amount limit: overage stopped</Trans>
            </div>
          )}
        </TableCell>
        <TableCell>
          {formatNumber(row.days_overdue)}
          {row.grace_days > 0 && (
            <div className="text-xs text-mw-text-muted">
              <Trans>+{graceDays} grace</Trans>
            </div>
          )}
        </TableCell>
        <TableCell>{formatMicros(row.outstanding_micros)}</TableCell>
        <TableCell>{row.next_step ? t`${nextStage}, ${nextOn}` : "—"}</TableCell>
        <TableCell>
          {row.overridden ? (
            <Badge variant="secondary">
              <Trans>own</Trans>
            </Badge>
          ) : (
            <Badge variant="outline">
              <Trans>default</Trans>
            </Badge>
          )}
          {row.note && <div className="mt-1 max-w-56 whitespace-normal text-xs text-mw-text-muted">{row.note}</div>}
        </TableCell>
        <TableCell className="text-right">
          <Button size="sm" variant="outline" aria-expanded={open} onClick={onToggle}>
            {open ? <Trans>Close {orgName}</Trans> : <Trans>Manage {orgName}</Trans>}
          </Button>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={7} className="whitespace-normal px-2 py-3">
            <div className="rounded-xl border border-border bg-card p-5">
              <OrgBillingPanel orgId={row.org_id} orgName={row.org_name} onChanged={onChanged} />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
