import { useId } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";

/**
 * The step before "Open as support": what the session is (thirty minutes,
 * read-only, audited at both ends) and why it is being opened. The reason
 * is required and goes onto the support.start audit row, so the trail
 * answers why an operator was inside this org, not only that they were.
 * Not the destructive dialog: nothing is lost, but it is still a look
 * inside someone else's data.
 */
export function SupportConfirm(props: {
  open: boolean;
  orgName: string;
  reason: string;
  onReasonChange: (reason: string) => void;
  inFlight: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const orgName = props.orgName;
  const ready = props.reason.trim() !== "";
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.inFlight) props.onCancel();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Open {orgName} as support?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              A thirty-minute, read-only view of {orgName} as its admin sees it. Opening and closing it are recorded
              in the audit trail with your name and this reason.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !props.inFlight) props.onConfirm();
          }}
        >
          <label htmlFor={inputId} className="text-sm">
            <Trans>Reason (required)</Trans>
          </label>
          <Input
            id={inputId}
            aria-label={t`Reason`}
            placeholder={t`Ticket number, or what the customer asked`}
            value={props.reason}
            maxLength={500}
            disabled={props.inFlight}
            autoComplete="off"
            onChange={(event) => props.onReasonChange(event.target.value)}
          />
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={props.inFlight} onClick={props.onCancel}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={props.inFlight || !ready} onClick={props.onConfirm}>
            {props.inFlight ? <Trans>Opening…</Trans> : <Trans>Open as support</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
