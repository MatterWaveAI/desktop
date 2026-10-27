import { useId } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

/**
 * The one way to confirm a destructive action: a modal that names the
 * action, requires an explicit choice (no close button), and disables both
 * buttons while the action is in flight. Closing is the caller's decision —
 * call `onOpenChange(false)` when the action settles.
 *
 * For the irreversible tier — deleting an account rather than one row — pass
 * `confirmPhrase`. The confirm button then stays disabled
 * until the user has typed that phrase, so the action cannot be reached by a
 * misplaced click or a stray Enter. The value is the caller's state: the
 * caller clears it when the dialog closes, and can read it to decide.
 */
export function DestructiveConfirm(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** True while the destructive action runs: buttons lock, nothing closes. */
  inFlight?: boolean;
  /** Typed-confirmation gate: the exact phrase the user must enter. */
  confirmPhrase?: string;
  typedValue?: string;
  onTypedValueChange?: (value: string) => void;
}) {
  const inputId = useId();
  const phrase = props.confirmPhrase;
  // Case- and whitespace-insensitive: the gate is deliberateness, not typing
  // accuracy, and a rejected "Delete My Account" only teaches users to paste.
  const phraseMatches =
    phrase === undefined || (props.typedValue ?? "").trim().toLowerCase() === phrase.toLowerCase();

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description && <DialogDescription>{props.description}</DialogDescription>}
        </DialogHeader>
        {phrase !== undefined && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={inputId} className="text-sm">
              Type <span className="font-medium">{phrase}</span> to confirm
            </label>
            <Input
              id={inputId}
              value={props.typedValue ?? ""}
              disabled={props.inFlight}
              autoComplete="off"
              onChange={(event) => props.onTypedValueChange?.(event.target.value)}
            />
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={props.inFlight}
            onClick={() => props.onOpenChange(false)}
          >
            {props.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant="default"
            className="bg-mw-danger-strong text-mw-danger-foreground hover:bg-mw-danger-strong/85"
            disabled={props.inFlight || !phraseMatches}
            onClick={props.onConfirm}
          >
            {props.confirmLabel ?? "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
