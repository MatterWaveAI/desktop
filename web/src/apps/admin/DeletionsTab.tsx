import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Badge } from "../../components/ui/badge";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
import { fetchDeletionRequests, formatDate, type DeletionRequest } from "./adminApi";
import { shortId, useLoad } from "./useLoad";

/**
 * Every account deletion and whether the identity provider confirmed the
 * login is gone.
 *
 * The local half of a deletion is a transaction the API owns; the provider
 * half is a network call that can fail after the person has already been
 * told their account is deleted. A row marked "login remains" is exactly
 * that case: data gone, login still working, and nobody but this page
 * knows. The note beside it is what the provider said.
 */
export function DeletionsTab() {
  const { t } = useLingui();
  const [state, reload] = useLoad(fetchDeletionRequests, "deletions");
  if (state.phase === "loading") return <LoadingSkeleton rows={4} />;
  if (state.phase === "error") {
    return <ErrorState title={t`Could not load deletion requests`} message={state.message} onRetry={reload} />;
  }
  if (state.data.length === 0) {
    return <EmptyState
        title={t`No deletion requests`}
        description={t`Each account deletion is recorded here with its outcome.`}
      />;
  }
  const outstanding = state.data.filter((r) => !r.identity_removed).length;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-mw-text-muted">
        {outstanding === 0
          ? t`Every deletion's login has been removed at the identity provider.`
          : plural(outstanding, {
              one: "# deletion still has a working login at the identity provider. Deactivate it by hand.",
              other: "# deletions still have a working login at the identity provider. Deactivate those by hand.",
            })}
      </p>
      <Table className="bg-card" aria-label={t`Deletion requests`}>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Requested</Trans>
            </TableHead>
            <TableHead>
              <Trans>Account</Trans>
            </TableHead>
            <TableHead>
              <Trans>Organisation</Trans>
            </TableHead>
            <TableHead>
              <Trans>Identity</Trans>
            </TableHead>
            <TableHead>
              <Trans>Completed</Trans>
            </TableHead>
            <TableHead>
              <Trans>Notes</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.data.map((row: DeletionRequest) => (
            <TableRow key={row.id} className="border-b border-mw-border">
              <TableCell>{formatDate(row.requested_at)}</TableCell>
              <TableCell>
                <span className="font-medium">{row.email ?? row.subject}</span>
                <div className="font-mono text-xs text-mw-text-muted">{row.subject}</div>
              </TableCell>
              <TableCell>
                {row.org_name ?? <span className="font-mono text-xs text-mw-text-muted">{shortId(row.org_id)}</span>}
              </TableCell>
              <TableCell>
                {row.identity_removed ? (
                  <Badge variant="positive">
                    <Trans>removed</Trans>
                  </Badge>
                ) : (
                  <Badge variant="destructive">
                    <Trans>login remains</Trans>
                  </Badge>
                )}
              </TableCell>
              <TableCell>{row.completed_at ? formatDate(row.completed_at) : t`Not finished`}</TableCell>
              <TableCell className="whitespace-normal text-mw-text-muted">{row.notes ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
