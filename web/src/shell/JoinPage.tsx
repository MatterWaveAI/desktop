import { useContext, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { apiFetch } from "../lib/api";
import { AuthPage, Alert, DonePanel } from "./AuthForm";
import { PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS, ensureAuthConfig, failureMessage, queryParam } from "./authForms";
import { LOGIN_PATH } from "./frontDoor";
import { ShellContext } from "./shellContext";
import { SignupPage, type SignupInvite } from "./SignupPage";

/**
 * The invite landing: `/join?token=` for a mailed invite, `/join?link=` for
 * a shareable invite link. One route, so both reach the anonymous front
 * door the same way; the parameter says which the token is.
 */
export function JoinPage() {
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const link = queryParam(searchStr, "link");
  if (link && !queryParam(searchStr, "token")) return <JoinLinkPage token={link} />;
  return <JoinInvitePage />;
}

/**
 * A mailed invite: `/join?token=`. Anonymous like /signup, so
 * the link in the mail works before there is an account. What it shows
 * depends on who is here:
 *
 * - a stranger gets the signup form with the invited address locked in and
 *   the token riding along, so the account lands in the inviting org with
 *   the invite's role instead of minting an org of its own;
 * - a signed-in person whose verified email is the invited one gets a
 *   one-click accept;
 * - anyone else signed in is told the invite is for a different address.
 *
 * The API decides everything that matters (expiry, single use, the
 * one-account-one-org rule); this page only asks it what the link is and
 * renders the answer.
 */

interface InviteLookup {
  org_name: string;
  email: string;
  role: string;
  expires_at: string;
  status: "pending" | "expired" | "accepted" | "revoked";
}

type JoinState =
  | { phase: "loading" }
  | { phase: "invalid"; message: string }
  | { phase: "ready"; invite: InviteLookup }
  | { phase: "accepting"; invite: InviteLookup }
  | { phase: "accepted"; invite: InviteLookup }
  | { phase: "error"; invite: InviteLookup; message: string };

const STATUS_MESSAGE: Record<Exclude<InviteLookup["status"], "pending">, string> = {
  expired: "This invite has expired.",
  accepted: "This invite has already been used.",
  revoked: "This invite was withdrawn.",
};

function JoinInvitePage() {
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const token = queryParam(searchStr, "token") ?? "";
  // Null outside the shell: no session, so the front door rendered this page.
  const shell = useContext(ShellContext);
  const [state, setState] = useState<JoinState>({ phase: "loading" });

  useEffect(() => {
    let alive = true;
    if (!token) {
      // Set from the effect rather than the initial state so the render
      // rule stays one-way: the token comes from the router's location.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ phase: "invalid", message: "This invite link is missing its token." });
      return;
    }
    (async () => {
      try {
        await ensureAuthConfig();
        const invite = await apiFetch<InviteLookup>("/api/org/invites/lookup", {
          method: "POST",
          json: { token },
        });
        if (alive) setState({ phase: "ready", invite });
      } catch (err) {
        if (alive) setState({ phase: "invalid", message: failureMessage(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  if (state.phase === "loading") {
    return (
      <AuthPage title="Checking your invitation…">
        <p aria-live="polite" className="animate-pulse text-sm text-mw-text-muted">
          One moment.
        </p>
      </AuthPage>
    );
  }
  if (state.phase === "invalid") {
    return (
      <UnusableInvite signedIn={shell !== null}>{state.message}</UnusableInvite>
    );
  }
  const { invite } = state;
  if (invite.status !== "pending") {
    return (
      <UnusableInvite signedIn={shell !== null}>{STATUS_MESSAGE[invite.status]}</UnusableInvite>
    );
  }

  if (shell === null) {
    const signupInvite: SignupInvite = {
      token,
      email: invite.email,
      orgName: invite.org_name,
      role: invite.role,
    };
    return <SignupPage invite={signupInvite} />;
  }

  const { principal } = shell;
  const matches = (principal.email ?? "").trim().toLowerCase() === invite.email;

  async function accept() {
    setState({ phase: "accepting", invite });
    try {
      await apiFetch("/api/org/invites/accept", { method: "POST", json: { token } });
      setState({ phase: "accepted", invite });
    } catch (err) {
      setState({ phase: "error", invite, message: failureMessage(err) });
    }
  }

  if (state.phase === "accepted") {
    return (
      <AuthPage title={`Welcome to ${invite.org_name}`}>
        <div aria-live="polite">
          <DonePanel id="joined" title={`You are now ${anArticle(invite.role)} ${invite.role} of ${invite.org_name}.`}>
            <a href="/apps/chat" className={PRIMARY_BUTTON_CLASS + " inline-block text-center"}>
              Open MatterWave
            </a>
          </DonePanel>
        </div>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title={`Join ${invite.org_name}`}
      intro={`You have been invited to join ${invite.org_name} as ${anArticle(invite.role)} ${invite.role}.`}
    >
      {state.phase === "error" && (
        <Alert>
          <p>{state.message}</p>
          {isOtherOrg(state.message) && (
            <p className="text-xs">
              You are signed in as {principal.email ?? principal.subject}.
            </p>
          )}
        </Alert>
      )}
      {matches ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={PRIMARY_BUTTON_CLASS}
            disabled={state.phase === "accepting"}
            onClick={() => void accept()}
          >
            {state.phase === "accepting" ? "Joining…" : `Join ${invite.org_name}`}
          </button>
          <span className="text-sm text-mw-text-muted">as {principal.email}</span>
        </div>
      ) : (
        <Alert>
          <p>
            This invitation was sent to {invite.email}, but you are signed in as{" "}
            {principal.email ?? principal.subject}.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => void shell.signOut()}>
              Sign out
            </button>
            <a href={LOGIN_PATH} className={SECONDARY_BUTTON_CLASS + " inline-block"}>
              Sign in as someone else
            </a>
          </div>
        </Alert>
      )}
    </AuthPage>
  );
}

/**
 * An invite that cannot be used, with the ways on from it: the one person
 * who can mend it, signing in (the invite may already have been accepted by
 * this person), and the front page.
 */
/**
 * An invite the API would not honour: expired, spent, withdrawn or not one
 * it issued. The alert is announced but not focused -- it is the whole page,
 * and a focus ring round the text on load reads as something to fix. There
 * is no way to ask for a new invite from here (only an organisation admin
 * can send one, from Settings, Members), so the page says who to ask and
 * offers the two things that do help: signing in, for a person who already
 * has an account the invite was never needed for, and the front page.
 */
function UnusableInvite(props: { signedIn: boolean; children: ReactNode }) {
  return (
    <AuthPage title="This invitation cannot be used">
      <Alert focus={false}>
        <p>{props.children}</p>
      </Alert>
      <p className="text-sm text-mw-text-muted">
        Ask the person who invited you for a new link. An administrator of the organisation
        sends one from Settings, Members.
      </p>
      <div className="flex flex-wrap gap-2">
        {props.signedIn ? (
          <a href="/" className={PRIMARY_BUTTON_CLASS + " inline-block text-center"}>
            Go to MatterWave
          </a>
        ) : (
          <>
            <a href={LOGIN_PATH} className={PRIMARY_BUTTON_CLASS + " inline-block text-center"}>
              Go to sign in
            </a>
            <a href="/" className={SECONDARY_BUTTON_CLASS + " inline-block text-center"}>
              Go to MatterWave
            </a>
          </>
        )}
      </div>
    </AuthPage>
  );
}

function anArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function isOtherOrg(message: string): boolean {
  return message.includes("another organization");
}

// --- invite links ------------------------------------------------------------------------

/**
 * What the API says about a shareable link before the page renders it:
 * whose org and which role, never who else has used it.
 */
interface InviteLinkLookup {
  org_name: string;
  role: string;
  expires_at: string;
  status: "active" | "expired" | "used_up" | "revoked";
}

type JoinLinkState =
  | { phase: "loading" }
  | { phase: "invalid"; message: string }
  | { phase: "ready"; link: InviteLinkLookup }
  | { phase: "joining"; link: InviteLinkLookup }
  | { phase: "joined"; link: InviteLinkLookup }
  | { phase: "error"; link: InviteLinkLookup; message: string };

const LINK_STATUS_MESSAGE: Record<Exclude<InviteLinkLookup["status"], "active">, string> = {
  expired: "This invite link has expired.",
  used_up: "This invite link has been used up.",
  revoked: "This invite link was withdrawn.",
};

/**
 * `/join?link=`: the shareable invite. The same two ways in as a mailed
 * invite, without an address to match -- the link is to whoever holds
 * it. A stranger gets the signup form with the token riding along; a
 * signed-in person gets a one-click join, which the API allows only for
 * an account already in that org (one account, one organisation) and says
 * so otherwise.
 */
function JoinLinkPage(props: { token: string }) {
  const { token } = props;
  const shell = useContext(ShellContext);
  const [state, setState] = useState<JoinLinkState>({ phase: "loading" });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await ensureAuthConfig();
        const link = await apiFetch<InviteLinkLookup>("/api/join/lookup", {
          method: "POST",
          json: { token },
        });
        if (alive) setState({ phase: "ready", link });
      } catch (err) {
        if (alive) setState({ phase: "invalid", message: failureMessage(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  if (state.phase === "loading") {
    return (
      <AuthPage title="Checking your invitation…">
        <p aria-live="polite" className="animate-pulse text-sm text-mw-text-muted">
          One moment.
        </p>
      </AuthPage>
    );
  }
  if (state.phase === "invalid") {
    return (
      <UnusableInvite signedIn={shell !== null}>{state.message}</UnusableInvite>
    );
  }
  const { link } = state;
  if (link.status !== "active") {
    return (
      <UnusableInvite signedIn={shell !== null}>{LINK_STATUS_MESSAGE[link.status]}</UnusableInvite>
    );
  }

  if (shell === null) {
    return <SignupPage invite={{ token, orgName: link.org_name, role: link.role, link: true }} />;
  }

  const { principal } = shell;

  async function join() {
    setState({ phase: "joining", link });
    try {
      await apiFetch("/api/join", { method: "POST", json: { token } });
      setState({ phase: "joined", link });
    } catch (err) {
      setState({ phase: "error", link, message: failureMessage(err) });
    }
  }

  if (state.phase === "joined") {
    return (
      <AuthPage title={`Welcome to ${link.org_name}`}>
        <div aria-live="polite">
          <DonePanel id="joined" title={`You are now ${anArticle(link.role)} ${link.role} of ${link.org_name}.`}>
            <a href="/apps/chat" className={PRIMARY_BUTTON_CLASS + " inline-block text-center"}>
              Open MatterWave
            </a>
          </DonePanel>
        </div>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title={`Join ${link.org_name}`}
      intro={`This link invites you to join ${link.org_name} as ${anArticle(link.role)} ${link.role}.`}
    >
      {state.phase === "error" && (
        <Alert>
          <p>{state.message}</p>
          {isOtherOrg(state.message) && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs">You are signed in as {principal.email ?? principal.subject}.</span>
              <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => void shell.signOut()}>
                Sign out
              </button>
            </div>
          )}
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={PRIMARY_BUTTON_CLASS}
          disabled={state.phase === "joining"}
          onClick={() => void join()}
        >
          {state.phase === "joining" ? "Joining…" : `Join ${link.org_name}`}
        </button>
        <span className="text-sm text-mw-text-muted">as {principal.email ?? principal.subject}</span>
      </div>
    </AuthPage>
  );
}
