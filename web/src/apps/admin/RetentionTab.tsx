import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
import { fetchRetentionPreview, formatDate, type RetentionPreview } from "./adminApi";
import { formatDateTime } from "../../i18n/format";
import { useLoad } from "./useLoad";

/**
 * What tonight's retention run would do, counted now and deleted later.
 *
 * Two halves, both from the API's dry run: the per-org windows (an org's
 * conversations that have gone quiet for longer than it allows are
 * soft-deleted, as if their owner had deleted them) and the purge (rows
 * soft-deleted more than thirty days ago are removed for good). The
 * window itself is set per org, from the org's details on the Orgs tab.
 */
export function RetentionTab() {
  const { t } = useLingui();
  const [state, reload] = useLoad(fetchRetentionPreview, "retention");
  if (state.phase === "loading") return <LoadingSkeleton rows={4} />;
  if (state.phase === "error") {
    return <ErrorState title={t`Could not load the retention preview`} message={state.message} onRetry={reload} />;
  }
  return <Preview preview={state.data} />;
}

function windowDays(days: number): string {
  return plural(days, { one: "# day", other: "# days" });
}

function Preview({ preview }: { preview: RetentionPreview }) {
  const { t } = useLingui();
  const orgsWithWork = preview.orgs.filter((org) => org.conversations > 0).length;
  const asOf = formatDateTime(preview.generated_at);
  const softCount = preview.soft_delete_count;
  const hardCount = preview.hard_delete_count;
  const days = preview.purge_days;
  const softDeletes = plural(softCount, { one: "# conversation", other: "# conversations" });
  const orgCount = plural(orgsWithWork, { one: "# organisation", other: "# organisations" });
  const hardDeletes = plural(hardCount, {
    one: "# soft-deleted conversation",
    other: "# soft-deleted conversations",
  });
  const purgeDays = plural(days, { one: "# day", other: "# days" });
  const cutoff = formatDate(preview.hard_delete_cutoff);
  return (
    <div className="space-y-6">
      <section aria-label={t`Next run`}>
        <h3 className="text-sm font-medium text-mw-text">
          <Trans>The next run</Trans>
        </h3>
        <p className="mt-1 text-sm text-mw-text-muted">
          <Trans>
            As of {asOf}: it would soft-delete <strong className="text-mw-text">{softDeletes}</strong> across{" "}
            {orgCount} with a retention window, and permanently delete{" "}
            <strong className="text-mw-text">{hardDeletes}</strong> older than {purgeDays} (before {cutoff}). A legal
            hold keeps a conversation out of both.
          </Trans>
        </p>
      </section>
      {preview.orgs.length === 0 ? (
        <EmptyState
          title={t`No organisation has a retention window`}
          description={t`Set one from an organisation's details on the Organisations tab. Without a window, conversations are kept until their owner deletes them.`}
        />
      ) : (
        <Table className="bg-card" aria-label={t`Retention by organisation`}>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>Organisation</Trans>
              </TableHead>
              <TableHead>
                <Trans>Window</Trans>
              </TableHead>
              <TableHead>
                <Trans>Quiet since before</Trans>
              </TableHead>
              <TableHead>
                <Trans>Conversations tonight</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {preview.orgs.map((org) => (
              <TableRow key={org.org_id} className="border-b border-mw-border">
                <TableCell>{org.org_name}</TableCell>
                <TableCell>{windowDays(org.retention_days)}</TableCell>
                <TableCell>{formatDate(org.cutoff)}</TableCell>
                <TableCell>{org.conversations}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
