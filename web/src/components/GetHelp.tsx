import { useEffect, useId, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { LifeBuoyIcon } from "lucide-react";
import { getAuthConfig } from "../lib/auth";
import {
  collectDiagnostics,
  fetchRelease,
  formatDiagnostics,
  supportRequestHref,
} from "../lib/diagnostics";
import { HELP_PATH } from "../shell/help";
import { Button, buttonVariants } from "./ui/button";
import { CopyButton } from "./ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * "Get help", beside every error's Retry: the route from a failure to a
 * person who can look it up, with the lookup keys already attached.
 *
 * The dialog shows exactly what would be sent -- account, organisation,
 * release, request and trace ids, the failing call and the page -- and
 * never conversation content. With a support address configured
 * (`support_url` on /api/auth-config) "Contact support" opens a message
 * pre-filled with that block; a web form is opened as configured, beside
 * the same block to paste. With none configured there is no dead link:
 * the block is offered to copy, and the dialog says why.
 */
export function GetHelp(props: {
  /** The id of the failure on screen; without one, the last failed call. */
  requestId?: string | null;
  traceId?: string | null;
  variant?: "outline" | "ghost" | "link";
  size?: "sm";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {props.variant === "link" ? (
        <button
          type="button"
          data-get-help=""
          onClick={() => setOpen(true)}
          className={
            props.className ??
            "text-mw-link underline underline-offset-2 hover:text-mw-link-hover"
          }
        >
          <Trans>Get help</Trans>
        </button>
      ) : (
        <Button
          type="button"
          data-get-help=""
          variant={props.variant ?? "outline"}
          size={props.size}
          className={props.className}
          onClick={() => setOpen(true)}
        >
          <LifeBuoyIcon aria-hidden />
          <Trans>Get help</Trans>
        </Button>
      )}
      {open && (
        <GetHelpDialog
          open={open}
          onOpenChange={setOpen}
          requestId={props.requestId ?? null}
          traceId={props.traceId ?? null}
        />
      )}
    </>
  );
}

function GetHelpDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string | null;
  traceId: string | null;
}) {
  const { t } = useLingui();
  const detailsId = useId();
  const [release, setRelease] = useState<string | null>(null);
  // Collected when the dialog opens, so the page and the time are the
  // failure's, and the release fills in when /healthz answers.
  const [now] = useState(() => new Date());
  useEffect(() => {
    let alive = true;
    void fetchRelease().then((value) => alive && setRelease(value));
    return () => {
      alive = false;
    };
  }, []);
  const diagnostics = collectDiagnostics({
    requestId: props.requestId,
    traceId: props.traceId,
    release,
    now,
  });
  const text = formatDiagnostics(diagnostics);
  const config = getAuthConfig();
  const subject = diagnostics.requestId
    ? t`MatterWave help: request ${diagnostics.requestId}`
    : t`MatterWave help`;
  const support = supportRequestHref(config?.support_url, diagnostics, subject);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent data-get-help-dialog="" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>Get help with this</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              These details let support find exactly what failed. They name your account and the
              request, never what you wrote.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <label htmlFor={detailsId} className="sr-only">
          <Trans>Details for support</Trans>
        </label>
        <textarea
          id={detailsId}
          data-testid="support-diagnostics"
          readOnly
          rows={9}
          value={text}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full resize-none rounded-md border border-mw-border bg-mw-surface p-2 font-mono text-xs text-mw-text"
        />
        {support === null ? (
          <p data-support-missing="" className="text-sm text-mw-text-muted">
            <Trans>
              No support address is set up for this deployment. Copy the details and send them to
              whoever runs MatterWave for you.
            </Trans>
          </p>
        ) : support.prefilled ? null : (
          <p className="text-sm text-mw-text-muted">
            <Trans>The support page opens in a new tab: paste the details into your request.</Trans>
          </p>
        )}
        <DialogFooter className="flex-wrap gap-2">
          <a href={HELP_PATH} className={buttonVariants({ variant: "ghost" })}>
            <Trans>Help page</Trans>
          </a>
          {config?.status_url && (
            <a
              href={config.status_url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "ghost" })}
            >
              <Trans>Service status</Trans>
            </a>
          )}
          <CopyButton text={text} label={t`Copy details`} copiedLabel={t`Copied`} />
          {support && (
            <a
              href={support.href}
              data-contact-support=""
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "default" })}
            >
              <Trans>Contact support</Trans>
            </a>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
