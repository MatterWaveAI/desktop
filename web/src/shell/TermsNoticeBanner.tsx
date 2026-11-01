import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { ApiError, apiFetch } from "../lib/api";
import { TERMS_PATH } from "./frontDoor";
import { useShell } from "./shellContext";
import { termsChangesSince } from "./termsChanges";

/**
 * A minor revision of the terms since the version this account accepted:
 * wording, not substance (the API decides, `terms_notice` on /api/me). The
 * app keeps working; the line says what changed and links the text, and
 * dismissing it records the acknowledgement through the same route the
 * accept page uses -- so the next load does not show it again, and the
 * audit trail has the row. A material revision never reaches here: Boot
 * stops at AcceptTermsNotice instead.
 *
 * A dismissal that fails keeps the line up and says so: hiding it would
 * claim an acknowledgement the API never recorded.
 */
export function TermsNoticeBanner() {
  const { t } = useLingui();
  const shell = useShell();
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!shell.principal.terms_notice) return null;
  const version = shell.authConfig.terms_version;
  const latest = termsChangesSince(shell.principal.terms_version)[0];

  async function dismiss() {
    if (!version) return;
    setState("saving");
    setError(null);
    try {
      const body = await apiFetch<{ terms_version: string; terms_current: boolean }>(
        "/api/me/accept-terms",
        { method: "POST", json: { version } },
      );
      shell.updatePrincipal?.({
        terms_version: body.terms_version,
        terms_current: body.terms_current,
        terms_notice: false,
      });
    } catch (err) {
      setState("failed");
      setError(err instanceof ApiError ? err.message : t`Could not record that you have seen this.`);
    }
  }

  return (
    <div
      role="status"
      data-terms-notice=""
      className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-mw-border bg-mw-surface-raised px-3 py-1.5 text-sm text-mw-text"
    >
      <p className="min-w-0 flex-1 break-words">
        <Trans>The Terms of Service were updated.</Trans>
        {latest && <span className="text-mw-text-muted"> {latest.summary}</span>}
        {error && (
          <span role="alert" className="block text-xs text-mw-danger">
            {error}
          </span>
        )}
      </p>
      <a
        href={TERMS_PATH}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 underline underline-offset-2"
      >
        <Trans>Read the terms</Trans>
      </a>
      <button
        type="button"
        disabled={state === "saving" || !version}
        onClick={() => void dismiss()}
        className="shrink-0 underline underline-offset-2 disabled:opacity-60"
      >
        {state === "saving" ? <Trans>Saving…</Trans> : <Trans>Got it</Trans>}
      </button>
    </div>
  );
}
