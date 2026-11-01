import { useEffect, useState } from "react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "../../components/ui/button";
import { ApiError } from "../../lib/api";
import { PaneSection } from "../settings/PaneSection";
import { describeExpiry, formatDate, listMyShares, revokeShare, type ShareRecord } from "./share";

/**
 * Settings -> Data: every share link this person has made, with revoke.
 *
 * Here rather than only in the chat dialog because a link outlives the
 * conversation being open: a person who shared something a month ago and
 * wants it gone needs one place that lists all of them, and "the data I
 * have let out" belongs beside export and delete. Revoked and expired
 * links stay listed, marked, so the list is a record and not just the
 * live set.
 */
export function MySharesSection() {
  const { t } = useLingui();
  const [shares, setShares] = useState<ShareRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listMyShares()
      .then((rows) => {
        if (!alive) return;
        setShares(rows);
        setError(null);
      })
      .catch((err: unknown) => {
        if (alive) {
          setError(err instanceof ApiError ? err.message : t`Could not load your shared links.`);
        }
      });
    return () => {
      alive = false;
    };
  }, [t]);

  async function revoke(share: ShareRecord) {
    setRevoking(share.id);
    setError(null);
    try {
      await revokeShare(share.id);
      setShares((current) =>
        (current ?? []).map((row) =>
          row.id === share.id
            ? { ...row, status: "revoked", revoked_at: new Date().toISOString() }
            : row,
        ),
      );
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? t`That link was already revoked.`
          : t`Could not revoke the link.`,
      );
    } finally {
      setRevoking(null);
    }
  }

  return (
    <PaneSection
      title={t`Shared links`}
      description={t`Each link is a snapshot of the conversation when you shared it; revoking stops it opening for everyone.`}
    >
      {error && (
        <p role="alert" className="mb-2 text-sm text-mw-danger">
          {error}
        </p>
      )}
      {shares === null && !error && (
        <p className="text-sm text-mw-text-muted">
          <Trans>Loading…</Trans>
        </p>
      )}
      {shares !== null && shares.length === 0 && (
        <p className="text-sm text-mw-text-muted">
          <Trans>You have not shared any conversations. Share one from the menu beside the model picker.</Trans>
        </p>
      )}
      {shares !== null && shares.length > 0 && (
        <ul className="-mx-5 -my-4 divide-y divide-border" aria-label={t`Shared links`}>
          {shares.map((share) => {
            const sharedOn = formatDate(share.created_at);
            const messageCount = share.message_count;
            const viewCount = share.view_count;
            const messages = plural(messageCount, { one: "# message", other: "# messages" });
            const views = plural(viewCount, { one: "# view", other: "# views" });
            const expiry = describeExpiry(share);
            return (
              <li
                key={share.id}
                data-mw-share-status={share.status}
                className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{share.title || t`Untitled`}</span>
                  <span className="block text-mw-text-muted">
                    {t`Shared ${sharedOn} · ${messages} · ${views} · ${expiry}`}
                  </span>
                </span>
                {share.status === "active" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revoking === share.id}
                    onClick={() => void revoke(share)}
                  >
                    {revoking === share.id ? t`Revoking…` : t`Revoke`}
                  </Button>
                ) : (
                  <span className="text-xs text-mw-text-muted">
                    {share.status === "revoked" ? t`Revoked` : t`Expired`}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </PaneSection>
  );
}
