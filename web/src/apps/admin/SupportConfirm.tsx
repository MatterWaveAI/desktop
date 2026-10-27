import { useId } from "react";
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
  const inputId = useId();
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
          <DialogTitle>Open {props.orgName} as support?</DialogTitle>
          <DialogDescription>
            A thirty-minute, read-only view of {props.orgName} as its admin sees it. Opening and closing it are
            recorded in the audit trail with your name and this reason.
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
            Reason (required)
          </label>
          <Input
            id={inputId}
            aria-label="Reason"
            placeholder="Ticket number, or what the customer asked"
            value={props.reason}
            maxLength={500}
            disabled={props.inFlight}
            autoComplete="off"
            onChange={(event) => props.onReasonChange(event.target.value)}
          />
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={props.inFlight} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button disabled={props.inFlight || !ready} onClick={props.onConfirm}>
            {props.inFlight ? "Opening…" : "Open as support"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
