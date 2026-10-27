import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
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
  if (state.phase === "loading") return <LoadingSkeleton rows={3} />;
  if (state.phase === "error") {
    return <ErrorState title="Could not load overdue organisations" message={state.message} onRetry={reload} />;
  }
  const { rows, limits } = state.data;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nobody is overdue"
        description="Organisations with a failed card or an invoice past its due date appear here."
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-mw-text-muted">
        {rows.length} organisation{rows.length === 1 ? "" : "s"} late. Whatever a policy says, an org is limited
        past its days-overdue limit (at most {limits.max_days_overdue_ceiling} days) and its overage stops past its
        outstanding limit (at most {formatMicros(limits.max_outstanding_ceiling_micros)}).
      </p>
      <Table className="bg-card" aria-label="Overdue organisations">
        <TableHeader>
          <TableRow>
            <TableHead>Organisation</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead>Days overdue</TableHead>
            <TableHead>Outstanding</TableHead>
            <TableHead>Next step</TableHead>
            <TableHead>Policy</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
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
  return (
    <>
      <TableRow data-overdue-stage={row.stage}>
        <TableCell>
          <span className="font-medium">{row.org_name}</span>
          <div className="text-xs text-mw-text-muted">
            {row.plan ?? "free"} ·{" "}
            {row.collection_method === "send_invoice" ? `invoice, net ${row.days_until_due ?? "?"}` : "card"}
          </div>
        </TableCell>
        <TableCell>
          <Badge variant={row.stage === "warn" || row.stage === "pending" ? "warning" : "destructive"}>
            {STAGE_LABEL[row.stage]}
          </Badge>
          {row.days_limit_hit_at && <div className="mt-1 text-xs text-mw-danger">days limit reached</div>}
          {row.amount_limit_hit_at && <div className="mt-1 text-xs text-mw-danger">amount limit: overage stopped</div>}
        </TableCell>
        <TableCell>
          {row.days_overdue}
          {row.grace_days > 0 && <div className="text-xs text-mw-text-muted">+{row.grace_days} grace</div>}
        </TableCell>
        <TableCell>{formatMicros(row.outstanding_micros)}</TableCell>
        <TableCell>
          {row.next_step ? `${STAGE_LABEL[row.next_step.stage]}, ${formatDate(row.next_step.at)}` : "—"}
        </TableCell>
        <TableCell>
          {row.overridden ? <Badge variant="secondary">own</Badge> : <Badge variant="outline">default</Badge>}
          {row.note && <div className="mt-1 max-w-56 whitespace-normal text-xs text-mw-text-muted">{row.note}</div>}
        </TableCell>
        <TableCell className="text-right">
          <Button size="sm" variant="outline" aria-expanded={open} onClick={onToggle}>
            {open ? `Close ${row.org_name}` : `Manage ${row.org_name}`}
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
