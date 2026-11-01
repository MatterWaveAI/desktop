import { useContext, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import type { MessageDescriptor } from "@lingui/core";
import { msg, select, t as coreT } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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

const STATUS_MESSAGE: Record<Exclude<InviteLookup["status"], "pending">, MessageDescriptor> = {
  expired: msg`This invite has expired.`,
  accepted: msg`This invite has already been used.`,
  revoked: msg`This invite was withdrawn.`,
};

function JoinInvitePage() {
  const { t, i18n } = useLingui();
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
      setState({ phase: "invalid", message: coreT`This invite link is missing its token.` });

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
    return <CheckingInvite />;
  }
  if (state.phase === "invalid") {
    return (
      <UnusableInvite signedIn={shell !== null}>{state.message}</UnusableInvite>
    );
  }
  const { invite } = state;
  if (invite.status !== "pending") {
    return (
      <UnusableInvite signedIn={shell !== null}>{i18n._(STATUS_MESSAGE[invite.status])}</UnusableInvite>
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
  const orgName = invite.org_name;
  const signedInAs = principal.email ?? principal.subject;
  const signedInEmail = principal.email;
  const invitedEmail = invite.email;

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
      <JoinedPage orgName={orgName} role={invite.role} />
    );
  }

  return (
    <AuthPage
      title={t`Join ${orgName}`}
      intro={invitedAs(invite.role, orgName)}
    >
      {state.phase === "error" && (
        <Alert>
          <p>{state.message}</p>
          {isOtherOrg(state.message) && (
            <p className="text-xs">
              <Trans>You are signed in as {signedInAs}.</Trans>
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
            {state.phase === "accepting" ? t`Joining…` : t`Join ${orgName}`}
          </button>
          <span className="text-sm text-mw-text-muted">
            <Trans>as {signedInEmail}</Trans>
          </span>
        </div>
      ) : (
        <Alert>
          <p>
            <Trans>
              This invitation was sent to {invitedEmail}, but you are signed in as {signedInAs}.
            </Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => void shell.signOut()}>
              <Trans>Sign out</Trans>
            </button>
            <a href={LOGIN_PATH} className={SECONDARY_BUTTON_CLASS + " inline-block"}>
              <Trans>Sign in as someone else</Trans>
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
  const { t } = useLingui();
  return (
    <AuthPage title={t`This invitation cannot be used`}>
      <Alert focus={false}>
        <p>{props.children}</p>
      </Alert>
      <p className="text-sm text-mw-text-muted">
        <Trans>
          Ask the person who invited you for a new link. An administrator of the organisation
          sends one from Settings, Members.
        </Trans>
      </p>
      <div className="flex flex-wrap gap-2">
        {props.signedIn ? (
          <a href="/" className={PRIMARY_BUTTON_CLASS + " inline-block text-center"}>
            <Trans>Go to MatterWave</Trans>
          </a>
        ) : (
          <>
            <a href={LOGIN_PATH} className={PRIMARY_BUTTON_CLASS + " inline-block text-center"}>
              <Trans>Go to sign in</Trans>
            </a>
            <a href="/" className={SECONDARY_BUTTON_CLASS + " inline-block text-center"}>
              <Trans>Go to MatterWave</Trans>
            </a>
          </>
        )}
      </div>
    </AuthPage>
  );
}

function CheckingInvite() {
  const { t } = useLingui();
  return (
    <AuthPage title={t`Checking your invitation…`}>
      <p aria-live="polite" className="animate-pulse text-sm text-mw-text-muted">
        <Trans>One moment.</Trans>
      </p>
    </AuthPage>
  );
}

/** The done state once a mailed invite or a link is accepted. */
function JoinedPage(props: { orgName: string; role: string }) {
  const { t } = useLingui();
  const { orgName } = props;
  return (
    <AuthPage title={t`Welcome to ${orgName}`}>
      <div aria-live="polite">
        <DonePanel id="joined" title={joinedAs(props.role, orgName)}>
          <a href="/apps/chat" className={PRIMARY_BUTTON_CLASS + " inline-block text-center"}>
            <Trans>Open MatterWave</Trans>
          </a>
        </DonePanel>
      </div>
    </AuthPage>
  );
}

/**
 * The role sentences, one branch per role the API has (owner, admin,
 * member, viewer): the English article and a translation's gender both
 * depend on the role. An unknown role is shown as the API names it, with
 * the English article.
 */
function withArticle(role: string): string {
  return /^[aeiou]/i.test(role) ? `an ${role}` : `a ${role}`;
}

function joinedAs(role: string, orgName: string): string {
  const roleWithArticle = withArticle(role);
  return select(role, {
    owner: `You are now an owner of ${orgName}.`,
    admin: `You are now an admin of ${orgName}.`,
    member: `You are now a member of ${orgName}.`,
    viewer: `You are now a viewer of ${orgName}.`,
    other: `You are now ${roleWithArticle} of ${orgName}.`,
  });
}

function invitedAs(role: string, orgName: string): string {
  const roleWithArticle = withArticle(role);
  return select(role, {
    owner: `You have been invited to join ${orgName} as an owner.`,
    admin: `You have been invited to join ${orgName} as an admin.`,
    member: `You have been invited to join ${orgName} as a member.`,
    viewer: `You have been invited to join ${orgName} as a viewer.`,
    other: `You have been invited to join ${orgName} as ${roleWithArticle}.`,
  });
}

function linkInvitesAs(role: string, orgName: string): string {
  const roleWithArticle = withArticle(role);
  return select(role, {
    owner: `This link invites you to join ${orgName} as an owner.`,
    admin: `This link invites you to join ${orgName} as an admin.`,
    member: `This link invites you to join ${orgName} as a member.`,
    viewer: `This link invites you to join ${orgName} as a viewer.`,
    other: `This link invites you to join ${orgName} as ${roleWithArticle}.`,
  });
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

const LINK_STATUS_MESSAGE: Record<Exclude<InviteLinkLookup["status"], "active">, MessageDescriptor> = {
  expired: msg`This invite link has expired.`,
  used_up: msg`This invite link has been used up.`,
  revoked: msg`This invite link was withdrawn.`,
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
  const { t, i18n } = useLingui();
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
    return <CheckingInvite />;
  }
  if (state.phase === "invalid") {
    return (
      <UnusableInvite signedIn={shell !== null}>{state.message}</UnusableInvite>
    );
  }
  const { link } = state;
  if (link.status !== "active") {
    return (
      <UnusableInvite signedIn={shell !== null}>{i18n._(LINK_STATUS_MESSAGE[link.status])}</UnusableInvite>
    );
  }

  if (shell === null) {
    return <SignupPage invite={{ token, orgName: link.org_name, role: link.role, link: true }} />;
  }

  const { principal } = shell;
  const orgName = link.org_name;
  const signedInAs = principal.email ?? principal.subject;

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
    return <JoinedPage orgName={orgName} role={link.role} />;
  }

  return (
    <AuthPage
      title={t`Join ${orgName}`}
      intro={linkInvitesAs(link.role, orgName)}
    >
      {state.phase === "error" && (
        <Alert>
          <p>{state.message}</p>
          {isOtherOrg(state.message) && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs">
                <Trans>You are signed in as {signedInAs}.</Trans>
              </span>
              <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => void shell.signOut()}>
                <Trans>Sign out</Trans>
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
          {state.phase === "joining" ? t`Joining…` : t`Join ${orgName}`}
        </button>
        <span className="text-sm text-mw-text-muted">
          <Trans>as {signedInAs}</Trans>
        </span>

      </div>
    </AuthPage>
  );
}
