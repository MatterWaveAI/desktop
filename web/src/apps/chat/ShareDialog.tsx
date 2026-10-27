import { useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { ApiError } from "../../lib/api";
import {
  createShare,
  DEFAULT_EXPIRY_INDEX,
  describeExpiry,
  EXPIRY_PRESETS,
  listConversationShares,
  revokeShare,
  shareFailureMessage,
  shareUrl,
  type ShareRecord,
} from "../share/share";

/**
 * The share dialog: make a link, copy it, see the links already out there
 * and take one back.
 *
 * The copy says what a link IS -- a snapshot of the transcript as it is at
 * that moment, readable by anyone holding it, naming nobody -- because the
 * API's decision to snapshot is invisible unless the dialog states it, and
 * a person who expects a live view would share, keep chatting, and be
 * surprised. The token is shown once, here; the list below never carries
 * it, so a lost link is a new link.
 */
export function ShareDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
}) {
  const [preset, setPreset] = useState(DEFAULT_EXPIRY_INDEX);
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [shares, setShares] = useState<ShareRecord[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "creating" | "created" | "failed">("idle");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const baseId = useId();
  const selectId = `${baseId}-expiry`;
  const attachmentsId = `${baseId}-attachments`;
  const linkId = `${baseId}-link`;

  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    listConversationShares(props.conversationId)
      .then((rows) => {
        if (!alive) return;
        setShares(rows);
        setListError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setListError(
          err instanceof ApiError && err.status === 404
            ? "This conversation could not be found."
            : "Could not load the existing links.",
        );
      });
    return () => {
      alive = false;
    };
  }, [props.open, props.conversationId]);

  async function create() {
    setPhase("creating");
    setFailure(null);
    setCopied(false);
    try {
      const created = await createShare(
        props.conversationId,
        EXPIRY_PRESETS[preset].seconds,
        includeAttachments,
      );
      setLink(shareUrl(created.path));
      setPhase("created");
      setShares((current) => [created.share, ...(current ?? [])]);
    } catch (err) {
      setFailure(shareFailureMessage(err));
      setPhase("failed");
    }
  }

  async function copy() {
    if (link === null) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard permission (or no clipboard at all): the field below
      // is selectable, and selecting it is what the focus does.
      document.getElementById(linkId)?.focus();
      (document.getElementById(linkId) as HTMLInputElement | null)?.select();
    }
  }

  async function revoke(share: ShareRecord) {
    setRevoking(share.id);
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
      setListError(
        err instanceof ApiError && err.status === 404
          ? "That link was already revoked."
          : "Could not revoke the link.",
      );
    } finally {
      setRevoking(null);
    }
  }

  const creating = phase === "creating";

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && creating) return;
        props.onOpenChange(open);
      }}
    >
      <DialogContent data-mw-share-dialog={phase} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share this conversation</DialogTitle>
          <DialogDescription>
            A link shows the conversation as it is right now; replies and edits after this are not
            included. Anyone with the link can read it. It names nobody, and you can revoke it
            here or under Settings, Data.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={selectId} className="text-sm font-medium">
              Link expires
            </label>
            <select
              id={selectId}
              value={preset}
              disabled={creating}
              onChange={(event) => setPreset(Number(event.target.value))}
              className="rounded-lg border border-mw-border bg-mw-surface-raised px-2 py-1.5 text-sm"
            >
              {EXPIRY_PRESETS.map((option, index) => (
                <option key={option.label} value={index}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <Button disabled={creating} onClick={() => void create()}>
            {creating ? "Creating…" : "Create link"}
          </Button>
        </div>

        {/* Off by default: a reader sees each attachment's name and nothing
            else unless the person sharing chooses otherwise. */}
        <label className="flex items-start gap-2 text-sm">
          <input
            id={attachmentsId}
            type="checkbox"
            className="mt-0.5"
            checked={includeAttachments}
            disabled={creating}
            onChange={(event) => setIncludeAttachments(event.target.checked)}
          />
          <span>
            Include attachments
            <span className="block text-xs text-mw-text-muted">
              Anyone with the link can open the images and files in this conversation. Off, they
              see only the file names.
            </span>
          </span>
        </label>

        {failure && (
          <p role="alert" className="text-sm text-mw-danger">
            {failure}
          </p>
        )}

        {link !== null && (
          <div className="flex flex-col gap-1">
            <label htmlFor={linkId} className="text-sm font-medium">
              Your link
            </label>
            <div className="flex gap-2">
              <input
                id={linkId}
                readOnly
                value={link}
                onFocus={(event) => event.currentTarget.select()}
                className="min-w-0 flex-1 rounded-lg border border-mw-border bg-mw-surface px-2 py-1.5 font-mono text-xs"
              />
              <Button variant="outline" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-mw-text-muted">
              Keep a copy: the link is shown once and is not listed below.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Existing links</h3>
          {listError && (
            <p role="alert" className="text-sm text-mw-danger">
              {listError}
            </p>
          )}
          {shares === null && !listError && (
            <p className="text-sm text-mw-text-muted">Loading…</p>
          )}
          {shares !== null && shares.length === 0 && (
            <p className="text-sm text-mw-text-muted">No links yet.</p>
          )}
          {shares !== null && shares.length > 0 && (
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto" aria-label="Existing links">
              {shares.map((share) => (
                <li
                  key={share.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-mw-border px-2 py-1.5 text-xs"
                  data-mw-share-status={share.status}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block">
                      {share.message_count} {share.message_count === 1 ? "message" : "messages"}
                      {" · "}
                      {share.view_count} {share.view_count === 1 ? "view" : "views"}
                    </span>
                    <span className="block text-mw-text-muted">
                      {describeExpiry(share)}
                      {share.include_attachments && " · with attachments"}
                    </span>
                  </span>
                  {share.status === "active" && (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={revoking === share.id}
                      onClick={() => void revoke(share)}
                    >
                      {revoking === share.id ? "Revoking…" : "Revoke"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={creating} onClick={() => props.onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
