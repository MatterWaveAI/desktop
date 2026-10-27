import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { AuthConfig, Principal } from "../types";
import { ApiError, apiFetch } from "../lib/api";
import { formatDate } from "../i18n/format";
import { PRIVACY_PATH, TERMS_PATH } from "./frontDoor";
import { CHECKBOX_CLASS, CHECKBOX_LABEL_CLASS } from "./frontDoorLinks";
import { shellSignOut } from "./signOut";
import { termsChangesSince } from "./termsChanges";
import { PRIMARY_BUTTON_CLASS } from "./authForms";
import { WaveMark, Wordmark } from "../components/brand";

/**
 * The whole page for an account whose accepted terms are not the version
 * in force. Mounted by Boot in place of the shell, the same way the
 * verification notice is: nothing behind the shell renders until the
 * person has agreed, because the agreement is the condition of use, and a
 * banner over a working product is not a condition.
 *
 * It says what changed -- the version, and the plain-language summary of
 * each revision since the one accepted (`termsChanges.ts`; "Updated
 * wording" when the list has nothing for it) -- links to the text, and takes
 * one explicit action. The version posted is the one `/api/auth-config`
 * advertises, never a copy held here: the API refuses any other, so a
 * stale build cannot record acceptance of the wrong one.
 */
export function AcceptTermsNotice(props: {
  config: AuthConfig;
  principal: Principal;
  onAccepted: (principal: Principal) => void;
}) {
  const { t } = useLingui();
  const version = props.config.terms_version;
  const accepted = props.principal.terms_version;
  const changes = termsChangesSince(accepted);
  const [agreed, setAgreed] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (!agreed || !version) return;
    setState("saving");
    setError(null);
    try {
      const body = await apiFetch<{ terms_version: string; terms_current: boolean }>(
        "/api/me/accept-terms",
        { method: "POST", json: { version } },
      );
      props.onAccepted({
        ...props.principal,
        terms_version: body.terms_version,
        terms_current: body.terms_current,
      });
    } catch (err) {
      setState("failed");
      setError(err instanceof ApiError ? err.message : t`Could not record your acceptance.`);
    }
  }

  // The current version, in its own span, or nothing: the sentence closes
  // either way.
  const current = version ? (
    <>
      {" "}
      (<span className="font-medium text-mw-text">{version}</span>)
    </>
  ) : null;

  return (
    <main className="h-full overflow-y-auto bg-mw-surface text-mw-text">
      <div className="mx-auto flex w-full max-w-lg flex-col items-center gap-6 px-4 py-12 sm:py-20">
        <div className="flex flex-col items-center gap-4 text-center">
          <Wordmark size="md" />
          <WaveMark width={160} />
          <h1 className="font-display text-display-md sm:text-display-lg">
            <Trans>
              The terms have <em>changed</em>
            </Trans>
          </h1>
          <p className="max-w-md text-sm text-mw-text-subtle">
            {accepted ? (
              <Trans>
                You accepted version <span className="font-medium text-mw-text">{accepted}</span>. To
                keep using MatterWave, read and accept the current version{current}.
              </Trans>
            ) : (
              <Trans>
                To keep using MatterWave, read and accept the current Terms of Service{current}.
              </Trans>
            )}
          </p>
        </div>

        <section
          aria-labelledby="terms-what-changed"
          className="flex w-full flex-col gap-2 rounded-2xl border border-mw-border bg-mw-surface-raised p-5 text-sm sm:p-6"
        >
          <h2 id="terms-what-changed" className="font-display text-display-sm">
            <Trans>What changed</Trans>
          </h2>
          {changes.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {changes.map((change) => {
                const version = change.version;
                return (
                  <li key={version} data-terms-change={version}>
                    <span className="font-medium">
                      <Trans>Version {version}</Trans>
                    </span>
                    <span className="text-mw-text-muted"> ({formatChangeDate(change.date)})</span>
                    <p className="text-mw-text-muted">{change.summary}</p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-mw-text-muted">
              <Trans>Updated wording.</Trans>
            </p>
          )}
        </section>

        <form
          className="flex w-full flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void accept();
          }}
        >
          <label className={CHECKBOX_LABEL_CLASS}>
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
              className={CHECKBOX_CLASS}
            />
            <span>
              {/* A new tab: reading the terms must not lose this page. */}
              <Trans>
                I have read and accept the{" "}
                <a href={TERMS_PATH} target="_blank" rel="noopener noreferrer" className="text-mw-link underline underline-offset-2 hover:text-mw-link-hover">
                  Terms of Service
                </a>{" "}
                and{" "}
                <a href={PRIVACY_PATH} target="_blank" rel="noopener noreferrer" className="text-mw-link underline underline-offset-2 hover:text-mw-link-hover">
                  Privacy Policy
                </a>
              </Trans>
            </span>
          </label>
          <button
            type="submit"
            disabled={!agreed || !version || state === "saving"}
            className={PRIMARY_BUTTON_CLASS}
          >
            {state === "saving" ? <Trans>Saving…</Trans> : <Trans>Accept and continue</Trans>}
          </button>
          {/* aria-live, so a refusal is announced rather than only appearing. */}
          <p aria-live="polite" role={error ? "alert" : undefined} className="min-h-5 text-xs text-mw-danger">
            {error}
          </p>
        </form>

        <button
          type="button"
          className="inline-flex min-h-6 items-center text-xs text-mw-text-muted underline hover:text-mw-text pointer-coarse:min-h-11"
          onClick={() => void shellSignOut(props.config)}
        >
          <Trans>Sign out instead</Trans>
        </button>
      </div>
    </main>
  );
}

/**
 * A revision is dated by day, not by instant, so it reads the same in every
 * timezone: midnight UTC, formatted as a UTC date in the reader's language.
 */
function formatChangeDate(iso: string): string {
  return formatDate(`${iso}T00:00:00Z`, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
