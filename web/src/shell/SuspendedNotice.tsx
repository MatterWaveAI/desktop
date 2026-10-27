import type { AuthConfig } from "../types";
import { POLICY_PATH } from "./frontDoor";
import { shellSignOut } from "./signOut";

/**
 * The whole page when the API says the account is suspended:
 * the shell is not mounted, because every request behind it would answer the
 * same 403, and a sidebar full of errors says less than one sentence. Sign
 * out is the only action - the session cookie is still set, and the next
 * person at this browser should not inherit a suspended one.
 */
export function SuspendedNotice(props: { config: AuthConfig }) {
  return (
    <main
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-4 bg-mw-surface px-4 text-center text-mw-text"
    >
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Your account is suspended
      </h1>
      <p className="max-w-md text-sm text-mw-text-muted">
        Signing in and every request are refused while it is. The{" "}
        <a href={`${POLICY_PATH}#appeal`} className="underline underline-offset-2">
          Acceptable Use Policy
        </a>{" "}
        explains why an account is suspended and how to appeal. If you think this is a
        mistake, appeal there or contact your organisation&apos;s administrator.
      </p>
      <button
        type="button"
        className="rounded-lg border border-mw-border px-4 py-2 text-sm hover:bg-mw-surface-hover"
        onClick={() => void shellSignOut(props.config)}
      >
        Sign out
      </button>
    </main>
  );
}
