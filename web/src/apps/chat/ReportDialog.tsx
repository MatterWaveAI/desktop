import { useId, useState } from "react";
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
import { RequestReference } from "./ChatStates";
import {
  REPORT_NOTE_MAX_LEN,
  REPORT_REASONS,
  reportFailureMessage,
  sendReport,
  type ReportKind,
} from "./report";

/**
 * The report dialog: one of the API's two reasons, an optional note, and an
 * honest answer about whether the report was stored.
 *
 * The success state shows the id the API returned rather than a bare
 * "thanks": the id is what a person quotes to support, and an
 * acknowledgement that cannot be followed up is a shrug. The failure state
 * says nothing was filed, for the same reason the API refuses outright when
 * it has nowhere to store a report.
 */
export function ReportDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  /** The reply being reported, or null for the whole conversation. */
  messageId: string | null;
}) {
  const [kind, setKind] = useState<ReportKind>("unsafe");
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; requestId: string | null } | null>(
    null,
  );
  const baseId = useId();
  const noteId = `${baseId}-note`;
  const sending = phase === "sending";
  const over = note.length > REPORT_NOTE_MAX_LEN;

  async function submit() {
    setPhase("sending");
    setFailure(null);
    try {
      const receipt = await sendReport(props.conversationId, {
        kind,
        messageId: props.messageId,
        note,
      });
      setReceiptId(receipt.id);
      setPhase("sent");
    } catch (err) {
      setFailure({
        message: reportFailureMessage(err),
        requestId: err instanceof ApiError ? err.requestId : null,
      });
      setPhase("failed");
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        // No closing by backdrop or Escape mid-request: the report is either
        // filed or it is not, and the dialog is where that answer lands.
        if (!open && sending) return;
        props.onOpenChange(open);
      }}
    >
      <DialogContent showCloseButton={false} data-mw-report-dialog={phase}>
        <DialogHeader>
          <DialogTitle>
            {props.messageId === null ? "Report this conversation" : "Report this reply"}
          </DialogTitle>
          <DialogDescription>
            Reports are stored with the conversation and read by a person. Filing one does not
            change the conversation and is not shown to the model.
          </DialogDescription>
        </DialogHeader>

        {phase === "sent" ? (
          <p role="status" className="text-sm text-mw-text">
            Your report is filed. Reference{" "}
            <code data-testid="report-id" className="select-all font-mono">
              {receiptId}
            </code>
            {" — "}quote it if you follow up with support.
          </p>
        ) : (
          <>
            <fieldset className="flex flex-col gap-2" disabled={sending}>
              <legend className="mb-1 text-sm font-medium">What is wrong with it?</legend>
              {REPORT_REASONS.map((reason) => (
                <label
                  key={reason.kind}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-mw-border p-2 has-checked:border-mw-accent"
                >
                  <input
                    type="radio"
                    name={`${baseId}-kind`}
                    value={reason.kind}
                    checked={kind === reason.kind}
                    onChange={() => setKind(reason.kind)}
                    className="mt-1"
                  />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{reason.label}</span>
                    <span className="text-xs text-mw-text-muted">{reason.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="flex flex-col gap-1">
              <label htmlFor={noteId} className="text-sm font-medium">
                Anything else? <span className="font-normal text-mw-text-muted">(optional)</span>
              </label>
              <textarea
                id={noteId}
                rows={3}
                value={note}
                disabled={sending}
                aria-invalid={over || undefined}
                aria-describedby={`${noteId}-count`}
                onChange={(event) => setNote(event.target.value)}
                placeholder="What you expected, and what you got instead."
                className="w-full rounded-lg border border-mw-border bg-mw-surface-raised p-2 text-sm outline-none focus-visible:border-mw-focus aria-invalid:border-mw-danger"
              />
              <p
                id={`${noteId}-count`}
                className={`text-right text-xs ${over ? "text-mw-danger" : "text-mw-text-muted"}`}
              >
                {note.length} / {REPORT_NOTE_MAX_LEN}
              </p>
            </div>

            {failure && (
              <div role="alert" className="text-sm text-mw-danger">
                <p>{failure.message}</p>
                <p className="mt-1 font-mono text-xs text-mw-text-muted">
                  <RequestReference requestId={failure.requestId} />
                </p>
              </div>
            )}
          </>
        )}

        <DialogFooter>
          {phase === "sent" ? (
            <Button onClick={() => props.onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={sending}
                onClick={() => props.onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button disabled={sending || over} onClick={() => void submit()}>
                {sending ? "Sending…" : phase === "failed" ? "Try again" : "Send report"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
