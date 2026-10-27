import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
import { fetchRetentionPreview, formatDate, type RetentionPreview } from "./adminApi";
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
  const [state, reload] = useLoad(fetchRetentionPreview, "retention");
  if (state.phase === "loading") return <LoadingSkeleton rows={4} />;
  if (state.phase === "error") {
    return <ErrorState title="Could not load the retention preview" message={state.message} onRetry={reload} />;
  }
  return <Preview preview={state.data} />;
}

function Preview({ preview }: { preview: RetentionPreview }) {
  const orgsWithWork = preview.orgs.filter((org) => org.conversations > 0).length;
  return (
    <div className="space-y-6">
      <section aria-label="Next run">
        <h3 className="text-sm font-medium text-mw-text">The next run</h3>
        <p className="mt-1 text-sm text-mw-text-muted">
          As of {new Date(preview.generated_at).toLocaleString()}: it would soft-delete{" "}
          <strong className="text-mw-text">{preview.soft_delete_count}</strong> conversation
          {preview.soft_delete_count === 1 ? "" : "s"} across {orgsWithWork} organisation
          {orgsWithWork === 1 ? "" : "s"} with a retention window, and permanently delete{" "}
          <strong className="text-mw-text">{preview.hard_delete_count}</strong> soft-deleted conversation
          {preview.hard_delete_count === 1 ? "" : "s"} older than {preview.purge_days} days (before{" "}
          {formatDate(preview.hard_delete_cutoff)}). A legal hold keeps a conversation out of both.
        </p>
      </section>
      {preview.orgs.length === 0 ? (
        <EmptyState
          title="No organisation has a retention window"
          description="Set one from an organisation's details on the Organisations tab. Without a window, conversations are kept until their owner deletes them."
        />
      ) : (
        <Table className="bg-card" aria-label="Retention by organisation">
          <TableHeader>
            <TableRow>
              <TableHead>Organisation</TableHead>
              <TableHead>Window</TableHead>
              <TableHead>Quiet since before</TableHead>
              <TableHead>Conversations tonight</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {preview.orgs.map((org) => (
              <TableRow key={org.org_id} className="border-b border-mw-border">
                <TableCell>{org.org_name}</TableCell>
                <TableCell>{org.retention_days} days</TableCell>
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
