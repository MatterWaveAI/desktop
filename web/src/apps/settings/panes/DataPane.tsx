import { useCallback, useState } from "react";
import { Button } from "../../../components/ui/button";
import { ApiError, apiFetch } from "../../../lib/api";
import { DestructiveConfirm } from "../../../patterns";
import { useShell } from "../../../shell/shellContext";
import { LearnMore, PaneSection } from "../PaneSection";
import { PaneActions } from "../paneActions";
import { MySharesSection } from "../../share/MySharesSection";
import { ImportSection } from "./ImportSection";

/**
 * The user-facing number: soft delete to hard delete is 30
 * days. The confirm copy has to state it, because "deleted" must mean what
 * the privacy policy says it means — a confirmation that
 * says "permanently" when the rows survive for a month is a lie in the UI.
 */
const RETENTION_DAYS = 30;

/** What the account-deletion confirmation makes the user type. */
const DELETE_PHRASE = "delete my account";

/** An export the worker builds (POST /api/me/export). */
export interface ExportJob {
  id: string;
  status: "pending" | "ready" | "failed" | "expired";
  download_url?: string | null;
}

/** How often, and how many times, the pane asks whether the export is built. */
export const EXPORT_POLL_MS = 2000;
const EXPORT_POLL_TRIES = 90;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function DataPane() {
  const shell = useShell();
  const [exportState, setExportState] = useState<
    "idle" | "working" | "ready" | "mailed"
  >("idle");
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // The export is built by a background job: ask for it, then poll its
  // status. A slow build is not an error -- the link also arrives by mail
  // and in the bell -- so running out of polls just says so.
  const runExport = useCallback(async () => {
    setExportState("working");
    setExportError(null);
    setExportUrl(null);
    try {
      let job = await apiFetch<ExportJob>("/api/me/export", { method: "POST" });
      for (
        let tries = 0;
        job.status === "pending" && tries < EXPORT_POLL_TRIES;
        tries += 1
      ) {
        await wait(EXPORT_POLL_MS);
        job = await apiFetch<ExportJob>(`/api/me/export/${job.id}`);
      }
      if (job.status === "pending") {
        setExportState("mailed");
        return;
      }
      if (job.status !== "ready") throw new Error("failed");
      if (!job.download_url) {
        job = await apiFetch<ExportJob>(`/api/me/export/${job.id}`);
      }
      setExportUrl(job.download_url ?? null);
      setExportState("ready");
    } catch (err) {
      setExportError(
        err instanceof ApiError ? err.message : "Could not build the export.",
      );
      setExportState("idle");
    }
  }, []);

  const runDelete = useCallback(async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiFetch("/api/me", {
        method: "DELETE",
        json: { confirm: DELETE_PHRASE },
      });
      setConfirmOpen(false);
      // The account is gone; the session must not survive it.
      await shell.signOut();
    } catch (err) {
      setDeleteError(
        err instanceof ApiError ? err.message : "Could not delete the account.",
      );
    } finally {
      setDeleting(false);
    }
  }, [shell]);

  const phraseMatches = typed.trim().toLowerCase() === DELETE_PHRASE;

  return (
    <div className="flex flex-col gap-7">
      {/* The export is the pane's one primary action, so it sits beside the
          pane's title; its progress and download stay in the card below. */}
      <PaneActions>
        <Button onClick={() => void runExport()} disabled={exportState === "working"}>
          {exportState === "working" ? "Preparing…" : "Prepare export"}
        </Button>
      </PaneActions>

      <PaneSection
        title="Export your data"
        description="A JSON file with everything stored for this account, prepared in the background."
      >
        <div className="flex flex-col gap-3">
          <LearnMore label="What is in it">
            <p>
              Your profile and the terms you accepted, every conversation and message (archived
              ones and branches too), custom instructions, preferences, library folders and tags,
              your feedback on replies, your share links, signed-in devices, notifications, your
              monthly usage, and your attachments — each file's details and a link to download it
              while you are signed in.
            </p>
            <p>It leaves out what would let someone sign in as you, such as share-link tokens and session ids.</p>
            <p>
              You also get an email and a notification with a download link, which works for 7 days
              while you are signed in.
            </p>
          </LearnMore>
          <div className="flex flex-wrap items-center gap-3">
            {exportState === "ready" && exportUrl && (
              <a className="text-sm font-medium text-mw-link underline-offset-4 hover:underline" href={exportUrl} download>
                Download export
              </a>
            )}
            {/* One polite live region for every outcome: a link appearing
                is silent to a screen reader, a status line is not. */}
            <span role="status" aria-live="polite" className="text-sm text-mw-text-muted">
              {exportState === "working" && "Preparing your export. This can take a minute."}
              {exportState === "ready" &&
                (exportUrl
                  ? "Your export is ready."
                  : "Your export is ready. The download link is in your email and notifications.")}
              {exportState === "mailed" &&
                "Still being prepared. We will email you a download link when it is ready."}
            </span>
            {exportError && (
              <span role="alert" className="text-sm text-mw-danger">
                {exportError}
              </span>
            )}
          </div>
        </div>
      </PaneSection>

      <ImportSection />

      <MySharesSection />

      <PaneSection
        tone="danger"
        title="Delete your account"
        description={`Your conversations and messages stop being readable immediately and are erased ${RETENTION_DAYS} days later.`}
        actions={
          <Button
            variant="destructive"
            onClick={() => {
              setTyped("");
              setDeleteError(null);
              setConfirmOpen(true);
            }}
          >
            Delete account…
          </Button>
        }
      >
        <LearnMore>
          <p>
            Within those {RETENTION_DAYS} days support can restore them; after that they are gone.
            Backups may hold copies until they age out.
          </p>
        </LearnMore>
        {deleteError && (
          <p role="alert" className="mt-2 text-sm text-mw-danger">
            {deleteError}
          </p>
        )}
      </PaneSection>

      <DestructiveConfirm
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setTyped("");
          setConfirmOpen(open);
        }}
        title="Delete your account?"
        description={`This signs you out and stops every conversation and message on ${shell.principal.email ?? shell.principal.subject} being readable. They are erased permanently after ${RETENTION_DAYS} days, and until then support can restore them. Backups may hold copies until they age out.`}
        confirmLabel="Delete account"
        confirmPhrase={DELETE_PHRASE}
        typedValue={typed}
        onTypedValueChange={setTyped}
        onConfirm={() => {
          // Belt and braces: the dialog already disables the button until the
          // phrase matches, so a fired confirm without it is a bug, not a
          // user action.
          if (phraseMatches) void runDelete();
        }}
        inFlight={deleting}
      />
    </div>
  );
}
