import { useEffect, useState } from "react";
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
          setError(err instanceof ApiError ? err.message : "Could not load your shared links.");
        }
      });
    return () => {
      alive = false;
    };
  }, []);

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
          ? "That link was already revoked."
          : "Could not revoke the link.",
      );
    } finally {
      setRevoking(null);
    }
  }

  return (
    <PaneSection
      title="Shared links"
      description="Each link is a snapshot of the conversation when you shared it; revoking stops it opening for everyone."
    >
      {error && (
        <p role="alert" className="mb-2 text-sm text-mw-danger">
          {error}
        </p>
      )}
      {shares === null && !error && <p className="text-sm text-mw-text-muted">Loading…</p>}
      {shares !== null && shares.length === 0 && (
        <p className="text-sm text-mw-text-muted">
          You have not shared any conversations. Share one from the menu beside the model picker.
        </p>
      )}
      {shares !== null && shares.length > 0 && (
        <ul className="-mx-5 -my-4 divide-y divide-border" aria-label="Shared links">
          {shares.map((share) => (
            <li
              key={share.id}
              data-mw-share-status={share.status}
              className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{share.title || "Untitled"}</span>
                <span className="block text-mw-text-muted">
                  Shared {formatDate(share.created_at)} · {share.message_count}{" "}
                  {share.message_count === 1 ? "message" : "messages"} · {share.view_count}{" "}
                  {share.view_count === 1 ? "view" : "views"} · {describeExpiry(share)}
                </span>
              </span>
              {share.status === "active" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={revoking === share.id}
                  onClick={() => void revoke(share)}
                >
                  {revoking === share.id ? "Revoking…" : "Revoke"}
                </Button>
              ) : (
                <span className="text-xs text-mw-text-muted">
                  {share.status === "revoked" ? "Revoked" : "Expired"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </PaneSection>
  );
}
