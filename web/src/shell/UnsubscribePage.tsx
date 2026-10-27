import { useContext, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { AuthPage, Alert, DonePanel } from "./AuthForm";
import { NETWORK_MESSAGE, PRIMARY_BUTTON_CLASS, queryParam } from "./authForms";
import { TAP_LINK_CLASS } from "./frontDoorLinks";
import { SessionContext } from "./sessionContext";
import { ShellContext } from "./shellContext";
import { UNSUBSCRIBE_CATEGORIES as CATEGORIES, tokenCategory } from "./unsubscribeToken";

/**
 * `/unsubscribe?t=`: the footer link in a usage alert, and where the API's
 * GET sends a browser that opened the `List-Unsubscribe` URL. Anonymous,
 * because the token in the link is the whole credential and the person may
 * be signed out or on another device.
 *
 * Opening the page changes nothing: link scanners fetch every URL in a mail,
 * so only the button sends the POST. It is the same RFC 8058 request a mail
 * client's own unsubscribe button sends, form body and all, without the
 * session cookie the token does not need.
 *
 * The token's first half is readable (`unsubscribeToken.ts`), so the page
 * says which mail the button stops before it is pressed, and tells a link
 * that is not even the right shape from one the API has to check.
 */

const PREFERENCES_PATH = "/settings/preferences";

type State =
  | { phase: "ready" }
  | { phase: "sending" }
  | { phase: "done"; category: string }
  /** The API said no and will keep saying no: nothing to retry. */
  | { phase: "invalid"; message: string }
  /** A refusal that may pass later: the limiter, the network, a 5xx. */
  | { phase: "error"; message: string };

const INVALID_MESSAGE = "This unsubscribe link is not valid.";

export function UnsubscribePage() {
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const token = queryParam(searchStr, "t") ?? "";
  const category = tokenCategory(token);
  // Signed in anywhere -- inside the shell or at one of its gates -- the
  // preferences pane is a real alternative to the one-click, so it is linked.
  const shell = useContext(ShellContext);
  const session = useContext(SessionContext);
  const signedIn = shell !== null || session !== null;
  const [state, setState] = useState<State>({ phase: "ready" });

  async function unsubscribe() {
    setState({ phase: "sending" });
    try {
      const res = await fetch(`/api/unsubscribe?${new URLSearchParams({ t: token }).toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }).toString(),
        credentials: "omit",
      });
      if (res.ok) {
        const body = (await res.json()) as { category: string };
        setState({ phase: "done", category: body.category });
      } else if (res.status === 429) {
        setState({ phase: "error", message: "Too many attempts. Try again in a few minutes." });
      } else if (res.status === 400) {
        setState({ phase: "invalid", message: INVALID_MESSAGE });
      } else {
        setState({ phase: "error", message: "Something went wrong. Try again in a moment." });
      }
    } catch {
      setState({ phase: "error", message: NETWORK_MESSAGE });
    }
  }

  const preferences = signedIn ? (
    <a href={PREFERENCES_PATH} className={TAP_LINK_CLASS}>
      Open notification preferences
    </a>
  ) : (
    <p className="text-sm text-mw-text-muted">
      Each kind of email can also be turned on or off from Settings, Preferences, once you are
      signed in.
    </p>
  );

  if (category === null || state.phase === "invalid") {
    return (
      <AuthPage title="This link cannot be used">
        <Alert focus={false}>
          <p>{state.phase === "invalid" ? state.message : INVALID_MESSAGE}</p>
        </Alert>
        <p className="text-sm text-mw-text-muted">
          It may have been cut short by the mail client, or it belongs to a different MatterWave.
          Nothing has changed. To stop these emails, use the preferences in your account instead.
        </p>
        {preferences}
      </AuthPage>
    );
  }

  const { label, what } = CATEGORIES[category];

  if (state.phase === "done") {
    const done = CATEGORIES[state.category]?.label ?? label;
    return (
      <AuthPage title="You are unsubscribed">
        <div aria-live="polite">
          <DonePanel id="unsubscribed" title={`You will no longer get ${done} by email.`}>
            <p className="text-sm text-mw-text-muted">
              Receipts and security mail still reach you. Turn {done} back on any time under
              Settings, Preferences.
            </p>
            <a href={PREFERENCES_PATH} className={TAP_LINK_CLASS}>
              Open preferences
            </a>
          </DonePanel>
        </div>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title={`Unsubscribe from ${label}?`}
      intro={`This stops ${label}: ${what}. Receipts and security mail still reach you. No sign-in needed.`}
    >
      {state.phase === "error" && (
        <Alert>
          <p>{state.message}</p>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={PRIMARY_BUTTON_CLASS}
          disabled={state.phase === "sending"}
          onClick={() => void unsubscribe()}
        >
          {state.phase === "sending" ? "Unsubscribing…" : "Unsubscribe"}
        </button>
      </div>
      {preferences}
    </AuthPage>
  );
}
