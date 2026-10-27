import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { HELP_PATH } from "./help";
import { chordKeys, isMacPlatform, SHORTCUTS, type Chord } from "./shortcuts";

/** A chord drawn as keycaps, spelt for the platform. */
export function ChordKeys(props: { chord: Chord; mac: boolean }) {
  const keys = chordKeys(props.chord, props.mac);
  return (
    <kbd className="inline-flex items-center gap-0.5 font-mono text-xs">
      {keys.map((key, index) => (
        <span key={index} className="contents">
          {index > 0 && !props.mac && <span aria-hidden>+</span>}
          <span className="rounded border border-mw-border bg-mw-surface px-1.5 py-0.5">{key}</span>
        </span>
      ))}
    </kbd>
  );
}

/**
 * The shortcuts overlay: every entry of `SHORTCUTS`, nothing else.
 *
 * Opened by `?` or the platform's Mod+/ and by the header's help button.
 * It is a list, not the help page: the page explains reporting, exporting
 * and the AI disclosure, and is one link away for anyone who wants that.
 */
export function ShortcutsHelp(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Overrides platform detection; tests pass it, the shell does not. */
  mac?: boolean;
}) {
  const mac = props.mac ?? isMacPlatform();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent showCloseButton={false} data-mw-shortcuts-help="">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts with a modifier, and the Esc ones, work while you are typing; the others wait
            until you are not.
          </DialogDescription>
        </DialogHeader>
        <dl className="flex flex-col gap-2">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.id} className="flex items-start justify-between gap-4">
              <dt className="text-sm">
                {shortcut.label}
                {shortcut.hint && (
                  <span className="block text-xs text-mw-text-muted">{shortcut.hint}</span>
                )}
              </dt>
              <dd className="flex shrink-0 items-center gap-1.5">
                {shortcut.chords.map((chord, index) => (
                  <span key={index} className="contents">
                    {index > 0 && <span className="text-xs text-mw-text-muted">or</span>}
                    <ChordKeys chord={chord} mac={mac} />
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <DialogFooter className="items-center sm:justify-between">
          {/* A plain anchor: this dialog renders in unit tests without a
              RouterProvider, where <Link> throws. */}
          <a href={HELP_PATH} className="text-sm text-mw-text-muted underline hover:text-mw-text">
            Help: reporting, exporting, usage
          </a>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
