import { useState } from "react";
import { MailIcon } from "lucide-react";
import type { AuthConfig, Principal } from "../types";
import { apiFetch } from "../lib/api";
import { EXAMPLE_PROMPTS } from "../apps/chat/examplePrompts";
import { VERIFY_PATH } from "./frontDoor";
import { shellSignOut } from "./signOut";

/**
 * The whole page for an account that exists but has not verified its email.
 *
 * **Not a 403.** Deliberately, and the reason is that this user did
 * everything right: they signed up seconds ago and the only thing standing
 * between them and the product is a click in their inbox. A refusal reads as
 * a rejection, and a user who reads a rejection at this point does not try
 * again. So this says what happened, what to do, and offers both actions —
 * enter the code, or send another one.
 *
 * The sample prompts are shown **disabled**, which is the step's own
 * instruction and is the interesting part of the design: the screen is not
 * only a gate, it is a preview. A new user learns what the product does while
 * they go and find the email, so verifying is a step towards something they
 * have already seen rather than a toll before an unknown. They are
 * `aria-disabled` and inert rather than removed, because the point is that
 * they are visible.
 *
 * Mounted by Boot instead of the shell, the same way `SuspendedNotice` is: a
 * shell here would be a sidebar whose every request is about to be refused,
 * and one sentence says more than a column of errors.
 */
export function PendingVerificationNotice(props: {
  config: AuthConfig;
  principal: Principal;
}) {
  const email = props.principal.email;
  const [resend, setResend] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  async function resendCode() {
    if (email === null) return;
    setResend("sending");
    try {
      await apiFetch("/api/signup/resend", { method: "POST", json: { email } });
      setResend("sent");
    } catch {
      // The endpoint answers 202 whether or not the address is known, so a
      // failure here is the API being unreachable or rate-limiting the
      // address — never a verdict on whether the account exists. Either way
      // the action for the user is the same: wait and try again.
      setResend("failed");
    }
  }

  return (
    <main className="h-full overflow-y-auto bg-mw-surface text-mw-text">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 px-4 py-12">
        <div className="flex flex-col items-center gap-3 text-center">
          {/* `surface-hover` rather than an accent tint: there is no
              `accent-subtle` token, and inventing one here would put a colour
              decision in a page instead of in the design system. */}
          <span className="flex size-12 items-center justify-center rounded-full bg-mw-surface-hover text-mw-link">
            <MailIcon className="size-6" aria-hidden />
          </span>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Check your email
          </h1>
          <p className="max-w-md text-sm text-mw-text-muted">
            {email === null ? (
              <>
                Your account is almost ready — it just needs its email address confirmed. Enter the
                code we sent you to finish.
              </>
            ) : (
              <>
                We sent a confirmation code to{" "}
                <span className="font-medium text-mw-text">{email}</span>. Enter it to finish
                setting up your account — everything below is waiting for you.
              </>
            )}
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
            <a
              href={
                email === null
                  ? VERIFY_PATH
                  : `${VERIFY_PATH}?email=${encodeURIComponent(email)}`
              }
              className="rounded-lg bg-mw-accent px-4 py-2 text-sm font-medium text-mw-accent-foreground hover:opacity-90"
            >
              Enter the code
            </a>
            {email !== null && (
              <button
                type="button"
                onClick={() => void resendCode()}
                disabled={resend === "sending" || resend === "sent"}
                className="rounded-lg border border-mw-border px-4 py-2 text-sm hover:bg-mw-surface-hover disabled:opacity-60"
              >
                {resend === "sending"
                  ? "Sending…"
                  : resend === "sent"
                    ? "Code sent"
                    : "Send a new code"}
              </button>
            )}
          </div>
          {/* aria-live, so the outcome of pressing resend is announced rather
              than only changing a button's label. */}
          <p aria-live="polite" className="min-h-5 text-xs text-mw-text-muted">
            {resend === "sent" && "A new code is on its way. It can take a minute to arrive."}
            {resend === "failed" &&
              "That did not go through — wait a moment and try again, or reload the page."}
          </p>
        </div>

        {/* The preview. Disabled on purpose: it shows what verifying
            unlocks, so the inbox trip has a visible destination. */}
        <section aria-labelledby="mw-pending-preview" className="w-full">
          <h2
            id="mw-pending-preview"
            className="text-center text-xs font-semibold uppercase tracking-wide text-mw-text-muted"
          >
            Once you are verified, you can ask things like
          </h2>
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {EXAMPLE_PROMPTS.map((example) => (
              <li key={example.title}>
                <div
                  aria-disabled="true"
                  className="h-full cursor-not-allowed rounded-xl border border-mw-border bg-mw-surface-raised p-3 text-left opacity-60"
                >
                  <span className="block text-sm font-medium">{example.title}</span>
                  <span className="mt-1 block text-xs text-mw-text-muted">{example.prompt}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <button
          type="button"
          className="text-xs text-mw-text-muted underline hover:text-mw-text"
          onClick={() => void shellSignOut(props.config)}
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
