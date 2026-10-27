import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { KeyRoundIcon, MonitorIcon, SmartphoneIcon } from "lucide-react";
import { Alert } from "../../../components/ui/alert";
import { Badge, StatusDot } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Toaster, toast } from "../../../components/ui/toast";
import { ApiError, apiFetch } from "../../../lib/api";
import {
  failureMessage,
  hasErrors,
  validateConfirm,
  validateEmail,
  validatePassword,
} from "../../../shell/authForms";
import { EnrolWizard, RecoveryCodes } from "../../../shell/MfaPage";
import {
  normalizeTotpCode,
  validateRecoveryCode,
  validateTotpCode,
  type MfaState,
  type TotpEnrolment,
} from "../../../shell/mfaForms";
import {
  addPasskey,
  fetchPasskeys,
  removePasskey,
  renamePasskey,
  type PasskeyInfo,
} from "../../../lib/passkeys";
import { PasskeyCancelled, passkeysSupported } from "../../../lib/webauthn";
import { useShell } from "../../../shell/shellContext";
import type { SessionInfo } from "../../../types";
import { LearnMore, PaneSection } from "../PaneSection";
import { Row, RowList } from "../rows";

function Field(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
      <dt className="text-sm text-mw-text-muted">{props.label}</dt>
      <dd className="min-w-0 text-sm">
        <span className="break-all">{props.value}</span>
        {props.hint && (
          <span className="ml-2 text-xs text-mw-text-muted">{props.hint}</span>
        )}
      </dd>
    </div>
  );
}

/** An org role as a person reads it: "owner" -> "Owner". */
function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** The API's bound on a display name (routes_account.py); mirrored for the field's maxLength. */
const NAME_MAX = 120;

/**
 * The display name, editable in place. `PATCH /api/me` writes the users
 * row and, under OIDC, the identity provider too, so the name the next
 * login carries is the one saved here. On success the shell's principal
 * is updated so the header shows it at once.
 */
function DisplayNameField(props: { name: string | null }) {
  const shell = useShell();
  // What the API last confirmed, kept here as well as on the principal:
  // the pane's own answer to "is there anything to save" cannot wait on
  // the shell folding the rename back into the principal it hands down.
  // Seeded from the principal once and never synced back from it: while
  // this field is mounted it is the only writer of the name, and a name
  // that arrives any other way comes with a fresh principal from Boot,
  // which remounts the whole shell.
  const [savedName, setSavedName] = useState(props.name ?? "");
  const [draft, setDraft] = useState(props.name ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  const trimmed = draft.trim().replace(/\s+/g, " ");
  const dirty = trimmed !== savedName;

  const save = useCallback(async () => {
    if (!trimmed || trimmed.length > NAME_MAX) return;
    setState("saving");
    setError(null);
    try {
      const body = await apiFetch<{ name?: string | null }>("/api/me", {
        method: "PATCH",
        json: { full_name: trimmed },
      });
      // The store can answer without a name (the dev principal has no
      // users row to read back); what was sent is then what was saved.
      const saved = body.name?.trim() || trimmed;
      setSavedName(saved);
      setDraft(saved);
      setState("saved");
      shell.updatePrincipal?.({ name: saved });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not save the name.",
      );
      setState("idle");
    }
  }, [shell, trimmed]);

  return (
    <form
      className="flex flex-wrap items-end gap-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm text-mw-text-muted">Display name</span>
        <Input
          name="full_name"
          value={draft}
          maxLength={NAME_MAX}
          autoComplete="name"
          onChange={(event) => {
            setDraft(event.target.value);
            if (state === "saved") setState("idle");
          }}
        />
      </label>
      <Button type="submit" disabled={!dirty || !trimmed || state === "saving"}>
        {state === "saving" ? "Saving…" : "Save name"}
      </Button>
      <p aria-live="polite" className="basis-full text-xs text-mw-text-muted">
        {state === "saved" && !dirty && "Name saved."}
        {error && (
          <span role="alert" className="text-mw-danger">
            {error}
          </span>
        )}
      </p>
    </form>
  );
}

type EmailField = "email" | "password" | "code";

/** The API's `code` on a refusal from POST /api/me/email(/verify), each sorted onto its field. */
const EMAIL_CODES: Record<string, EmailField> = {
  wrong_current_password: "password",
  email_taken: "email",
  disposable_email: "email",
  same_email: "email",
  invalid_code: "code",
};

/**
 * Email: the new address and the current password, then the code that was
 * mailed to the new address. Nothing changes until the code comes back --
 * the old address keeps signing in -- so the code step can be abandoned
 * and started again. A success moves the sign-in address, tells the old
 * address, and signs every other device out; the shell's principal takes
 * the new address so the Identity list shows it at once.
 */
function EmailCard() {
  const shell = useShell();
  const id = useId();
  const [step, setStep] = useState<"address" | "code">("address");
  const [values, setValues] = useState<Record<EmailField, string>>({
    email: "",
    password: "",
    code: "",
  });
  const [pending, setPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<EmailField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A change started before a reload is still waiting on its code: the
  // provider holds the new address unverified. Come back to the code step
  // rather than offering a fresh start that would silently replace it.
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ email: string | null; pending_email: string | null }>("/api/me/email")
      .then((body) => {
        if (cancelled || !body.pending_email) return;
        setPending(body.pending_email);
        setStep("code");
      })
      .catch(() => {
        // An older API, or a provider outage: the address step still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function set(field: EmailField, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }

  function refused(err: unknown) {
    const code =
      err instanceof ApiError
        ? (err.body as { code?: unknown })?.code
        : undefined;
    const field = typeof code === "string" ? EMAIL_CODES[code] : undefined;
    if (field && err instanceof ApiError) setErrors({ [field]: err.message });
    else setFormError(failureMessage(err));
  }

  async function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = values.email.trim().toLowerCase();
    const found: Partial<Record<EmailField, string>> = {
      email: validateEmail(email),
      password:
        values.password === "" ? "Enter your current password." : undefined,
    };
    setErrors(found);
    setFormError(null);
    setDone(null);
    setNotice(null);
    if (hasErrors(found)) return;
    setBusy(true);
    try {
      const body = await apiFetch<{ new_email: string }>("/api/me/email", {
        method: "POST",
        json: { new_email: email, current_password: values.password },
      });
      setPending(body.new_email);
      setValues({ email: "", password: "", code: "" });
      setStep("code");
    } catch (err) {
      refused(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = values.code.trim();
    const found = {
      code: code === "" ? "Enter the code from the mail." : undefined,
    };
    setErrors(found);
    setFormError(null);
    setNotice(null);
    if (hasErrors(found)) return;
    setBusy(true);
    try {
      const body = await apiFetch<{ email: string }>("/api/me/email/verify", {
        method: "POST",
        json: { code },
      });
      shell.updatePrincipal?.({ email: body.email });
      setDone(body.email);
      setPending(null);
      setValues({ email: "", password: "", code: "" });
      setStep("address");
    } catch (err) {
      refused(err);
    } finally {
      setBusy(false);
    }
  }

  async function cancelChange() {
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const body = await apiFetch<{ email: string }>("/api/me/email/cancel", {
        method: "POST",
      });
      setStep("address");
      setPending(null);
      setErrors({});
      setValues({ email: "", password: "", code: "" });
      setNotice(`Change cancelled. You still sign in as ${body.email}.`);
    } catch (err) {
      setFormError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const body = await apiFetch<{ new_email: string }>("/api/me/email/resend", {
        method: "POST",
      });
      setPending(body.new_email);
      setNotice(`A new code is on its way to ${body.new_email}.`);
    } catch (err) {
      const code =
        err instanceof ApiError ? (err.body as { code?: unknown })?.code : undefined;
      if (code === "no_pending_change") {
        // Cancelled or finished elsewhere: there is no code to wait for.
        setStep("address");
        setPending(null);
      }
      setFormError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function input(
    field: EmailField,
    label: string,
    props: {
      name: string;
      type?: string;
      autoComplete: string;
      maxLength: number;
      inputMode?: "text" | "email";
    },
  ) {
    return (
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-mw-text-muted">{label}</span>
          <Input
            {...props}
            value={values[field]}
            aria-invalid={errors[field] !== undefined || undefined}
            aria-describedby={
              errors[field] ? `${id}-${field}-error` : undefined
            }
            onChange={(event) => set(field, event.target.value)}
          />
        </label>
        {errors[field] && (
          <span
            id={`${id}-${field}-error`}
            role="alert"
            className="text-xs text-mw-danger"
          >
            {errors[field]}
          </span>
        )}
      </div>
    );
  }

  const status = (
    <>
      {formError && (
        <p role="alert" className="text-sm text-mw-danger">
          {formError}
        </p>
      )}
      <p aria-live="polite" className="text-sm text-mw-text-muted">
        {done &&
          `Your sign-in address is now ${done}. Other devices were signed out.`}
        {notice}
      </p>
    </>
  );

  if (step === "code") {
    return (
      <form
        noValidate
        aria-busy={busy}
        onSubmit={handleVerify}
        className="flex flex-col gap-2"
      >
        <p className="text-sm">
          We sent a code to{" "}
          <span className="font-medium break-all">{pending}</span>. Enter it to
          make that your sign-in address.
        </p>
        {input("code", "Code from the mail", {
          name: "email_code",
          autoComplete: "one-time-code",
          maxLength: 64,
          inputMode: "text",
        })}
        {status}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Checking…" : "Confirm address"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void resend()}
          >
            Resend code
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void cancelChange()}
          >
            Cancel change
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form
      noValidate
      aria-busy={busy}
      onSubmit={handleStart}
      className="flex flex-col gap-2"
    >
      {input("email", "New email address", {
        name: "new_email",
        type: "email",
        autoComplete: "email",
        maxLength: 254,
        inputMode: "email",
      })}
      {input("password", "Your current password, to confirm", {
        name: "email_current_password",
        type: "password",
        autoComplete: "current-password",
        maxLength: 256,
      })}
      {status}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send code"}
        </Button>
      </div>
    </form>
  );
}

type PasswordField = "current" | "next" | "confirm";

/** The API's `code` on a 400 from POST /api/me/password, each sorted onto its field. */
const PASSWORD_CODES: Record<string, PasswordField> = {
  wrong_current_password: "current",
  weak_password: "next",
};

/**
 * Password: the current one proves the person, the new one typed twice.
 * The length rule is the signup form's, checked here first so the API is
 * not asked about a password it would refuse; the API's own refusals come
 * back with a `code` that names the field. A success ends every other
 * session on the server, and the toast says so, because a changed password
 * is most often a response to a device the person no longer trusts.
 */
function PasswordCard() {
  const id = useId();
  const [values, setValues] = useState<Record<PasswordField, string>>({
    current: "",
    next: "",
    confirm: "",
  });
  const [errors, setErrors] = useState<Partial<Record<PasswordField, string>>>(
    {},
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set(field: PasswordField, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Partial<Record<PasswordField, string>> = {
      current:
        values.current === "" ? "Enter your current password." : undefined,
      next: validatePassword(values.next, "a new password"),
      confirm: validateConfirm(values.next, values.confirm),
    };
    setErrors(found);
    setFormError(null);
    if (hasErrors(found)) return;
    setBusy(true);
    try {
      await apiFetch("/api/me/password", {
        method: "POST",
        json: { current_password: values.current, new_password: values.next },
      });
      setValues({ current: "", next: "", confirm: "" });
      toast.add({
        type: "success",
        title: "Password changed.",
        description: "Other devices were signed out.",
      });
    } catch (err) {
      const code =
        err instanceof ApiError
          ? (err.body as { code?: unknown })?.code
          : undefined;
      const field = typeof code === "string" ? PASSWORD_CODES[code] : undefined;
      if (field && err instanceof ApiError) setErrors({ [field]: err.message });
      else setFormError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const fields: { key: PasswordField; label: string; autoComplete: string }[] =
    [
      {
        key: "current",
        label: "Current password",
        autoComplete: "current-password",
      },
      { key: "next", label: "New password", autoComplete: "new-password" },
      {
        key: "confirm",
        label: "Confirm new password",
        autoComplete: "new-password",
      },
    ];

  return (
    <form
      noValidate
      aria-busy={busy}
      onSubmit={handleSubmit}
      className="flex flex-col gap-2"
    >
      {fields.map(({ key, label, autoComplete }) => (
        <div key={key} className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-mw-text-muted">{label}</span>
            <Input
              type="password"
              name={`${key}_password`}
              value={values[key]}
              autoComplete={autoComplete}
              maxLength={256}
              aria-invalid={errors[key] !== undefined || undefined}
              aria-describedby={errors[key] ? `${id}-${key}-error` : undefined}
              onChange={(event) => set(key, event.target.value)}
            />
          </label>
          {/* Beside the label, not inside it, so the field's name stays
              "New password" rather than growing the refusal; and an alert
              as well as the field's description, because the refusal
              arrives while focus is on the button and a description is
              only read when its field takes focus. */}
          {errors[key] && (
            <span
              id={`${id}-${key}-error`}
              role="alert"
              className="text-xs text-mw-danger"
            >
              {errors[key]}
            </span>
          )}
        </div>
      ))}
      {formError && (
        <p role="alert" className="text-sm text-mw-danger">
          {formError}
        </p>
      )}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "Changing…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}

function ThisDevice() {
  return (
    <Badge variant="positive">
      <StatusDot tone="positive" />
      This device
    </Badge>
  );
}

/** The row's mark: a phone or a computer, read off the same User-Agent as the label. */
function DeviceMark(props: { agent: string | null }) {
  const Icon = /iPhone|iPad|Android/.test(props.agent ?? "") ? SmartphoneIcon : MonitorIcon;
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-mw-surface-raised text-mw-text-muted"
    >
      <Icon className="size-4" />
    </span>
  );
}

/** "Last seen <when>" with the address, the secondary line of a session row. */
function SeenLine(props: { at: string; ip: string | null }) {
  return (
    <>
      Last seen <time dateTime={props.at}>{formatSeen(props.at)}</time>
      {props.ip ? ` · ${props.ip}` : ""}
    </>
  );
}

function formatSeen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * A readable device line from the User-Agent the API kept at login.
 * Heuristic on purpose: it is a label for the person to recognise their own
 * browser, not a fingerprint, and the raw string is in the title attribute.
 */
function describeAgent(agent: string | null): string {
  if (!agent) return "Unknown browser";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /OPR\//.test(agent)
      ? "Opera"
      : /Firefox\//.test(agent)
        ? "Firefox"
        : /Chrome\//.test(agent)
          ? "Chrome"
          : /Safari\//.test(agent)
            ? "Safari"
            : "Browser";
  const os = /Windows/.test(agent)
    ? "Windows"
    : /Android/.test(agent)
      ? "Android"
      : /iPhone|iPad/.test(agent)
        ? "iOS"
        : /Mac OS/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
}

/**
 * The sessions as one row per device: the same browser from the same
 * address, however many times it signed in. A browser that signs in daily
 * (a test runner, a laptop that clears cookies) leaves dozens of rows that
 * say the same thing; the person wants to know which devices are signed
 * in, not how often. The row carries the most recent sighting and the
 * count; Show all lists every session.
 */
export interface SessionGroup {
  key: string;
  label: string;
  ip: string | null;
  /** Newest sighting first. */
  sessions: SessionInfo[];
  /** The newest sighting's time. */
  lastSeenAt: string;
  /** This group holds the session making the request. */
  current: boolean;
}

export function groupSessions(sessions: SessionInfo[]): SessionGroup[] {
  const byKey = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const label = describeAgent(session.user_agent);
    const key = `${label}|${session.ip ?? ""}`;
    const group = byKey.get(key) ?? {
      key,
      label,
      ip: session.ip,
      sessions: [],
      lastSeenAt: session.last_seen_at,
      current: false,
    };
    group.sessions.push(session);
    group.current ||= session.current;
    if (Date.parse(session.last_seen_at) > Date.parse(group.lastSeenAt)) {
      group.lastSeenAt = session.last_seen_at;
    }
    byKey.set(key, group);
  }
  const newestFirst = (a: { last_seen_at: string }, b: { last_seen_at: string }) =>
    Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at);
  const groups = [...byKey.values()];
  for (const group of groups) group.sessions.sort(newestFirst);
  // This device first, then by most recent activity.
  return groups.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
  });
}

/**
 * Every live session for this account, this device flagged, every other
 * one revocable. This device is ended by Sign out, which clears the cookie
 * as well; revoking its row from the list would leave a shell whose every
 * next request is a 401.
 */
function SessionsList() {
  const shell = useShell();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ sessions: SessionInfo[] }>("/api/me/sessions")
      .then((body) => {
        if (cancelled) return;
        setSessions(body.sessions);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? err.message
            : "Could not load your sessions.",
        );
        setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const revoke = useCallback(async (session: SessionInfo) => {
    setBusy(session.id);
    setError(null);
    try {
      await apiFetch(`/api/me/sessions/${encodeURIComponent(session.id)}`, {
        method: "DELETE",
      });
      setSessions((list) => (list ?? []).filter((s) => s.id !== session.id));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not sign that session out.",
      );
    } finally {
      setBusy(null);
    }
  }, []);

  /** A whole device's sessions, one DELETE each; this device's own session is never among them. */
  const revokeGroup = useCallback(async (group: SessionGroup) => {
    setBusy(group.key);
    setError(null);
    const done: string[] = [];
    try {
      for (const session of group.sessions) {
        if (session.current) continue;
        await apiFetch(`/api/me/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
        done.push(session.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign that device out.");
    } finally {
      // Whatever was revoked before a failure is gone; show that.
      setSessions((list) => (list ?? []).filter((s) => !done.includes(s.id)));
      setBusy(null);
    }
  }, []);

  const revokeOthers = useCallback(async () => {
    setBusy("others");
    setError(null);
    try {
      await apiFetch("/api/me/sessions/revoke-others", { method: "POST" });
      setSessions((list) => (list ?? []).filter((s) => s.current));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not sign the other sessions out.",
      );
    } finally {
      setBusy(null);
    }
  }, []);

  const others = (sessions ?? []).filter((s) => !s.current);
  const groups = groupSessions(sessions ?? []);
  const collapsible = groups.some((g) => g.sessions.length > 1);

  return (
    <PaneSection
      title="Sessions"
      description="Where this account is signed in. A device signed out here ends on its next request."
      flush
      actions={
        // The actions in the header: on a long list they are what the person came for.
        <>
          <Button variant="outline" size="sm" onClick={() => void shell.signOut()}>
            Sign out
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || others.length === 0}
            onClick={() => void revokeOthers()}
          >
            Sign out other devices
          </Button>
        </>
      }
    >
      {sessions === null ? (
        <p className="px-5 py-4 text-sm text-mw-text-muted">Loading sessions…</p>
      ) : sessions.length === 0 ? (
        <p className="px-5 py-4 text-sm text-mw-text-muted">
          No sessions are recorded for this account. A session signed in before
          sessions were tracked is not listed and ends when it expires.
        </p>
      ) : showAll ? (
        <RowList aria-label="Sessions">
          {groups.flatMap((group) => group.sessions).map((session) => (
            <Row
              key={session.id}
              leading={<DeviceMark agent={session.user_agent} />}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span title={session.user_agent ?? undefined}>
                    {describeAgent(session.user_agent)}
                  </span>
                  {session.current && <ThisDevice />}
                </span>
              }
              meta={<SeenLine at={session.last_seen_at} ip={session.ip} />}
              trailing={
                !session.current && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void revoke(session)}
                  >
                    Sign out this device
                  </Button>
                )
              }
            />
          ))}
        </RowList>
      ) : (
        <RowList aria-label="Sessions">
          {groups.map((group) => {
            const revocable = group.sessions.filter((s) => !s.current).length;
            return (
              <Row
                key={group.key}
                leading={<DeviceMark agent={group.sessions[0].user_agent} />}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span title={group.sessions[0].user_agent ?? undefined}>{group.label}</span>
                    {group.current && <ThisDevice />}
                    {group.sessions.length > 1 && (
                      <span className="text-sm font-normal text-mw-text-muted">
                        {group.sessions.length} sessions
                      </span>
                    )}
                  </span>
                }
                meta={<SeenLine at={group.lastSeenAt} ip={group.ip} />}
                trailing={
                  revocable > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void revokeGroup(group)}
                    >
                      {revocable === 1
                        ? "Sign out this device"
                        : group.current
                          ? `Sign out ${revocable} other sessions`
                          : `Sign out all ${revocable}`}
                    </Button>
                  )
                }
              />
            );
          })}
        </RowList>
      )}
      {(collapsible || error) && (
        <div className="flex flex-col gap-2 border-t border-border px-5 py-3">
          {collapsible && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={showAll}
                onClick={() => setShowAll((on) => !on)}
              >
                {showAll ? "Show one row per device" : `Show all ${sessions?.length ?? 0} sessions`}
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-mw-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </PaneSection>
  );
}

/**
 * A code from the app -- or, when `allowRecovery`, one of the recovery
 * codes -- typed before a destructive step. One field, one submit, and the
 * proof goes up with the request rather than being checked here: the API
 * is what decides whether a code is right.
 */
function ProofForm(props: {
  title: string;
  submitLabel: string;
  /** The submit is the destructive step itself (removing the factor), styled as such. */
  destructive?: boolean;
  allowRecovery: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (proof: { code?: string; recovery_code?: string }) => void;
  onCancel: () => void;
}) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const id = useId();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = String(new FormData(event.currentTarget).get("proof") ?? "");
    const error = useRecovery
      ? validateRecoveryCode(typed)
      : validateTotpCode(typed);
    setFieldError(error);
    if (error) return;
    props.onSubmit(
      useRecovery
        ? { recovery_code: typed.trim() }
        : { code: normalizeTotpCode(typed) },
    );
  }

  return (
    <form
      noValidate
      aria-busy={props.busy}
      aria-labelledby={`${id}-title`}
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 border-t border-border pt-3"
    >
      <p id={`${id}-title`} className="text-sm font-medium">
        {props.title}
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-mw-text-muted">
          {useRecovery ? "Recovery code" : "Code from your authenticator app"}
        </span>
        <Input
          name="proof"
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete={useRecovery ? "off" : "one-time-code"}
          aria-invalid={fieldError !== undefined || undefined}
          aria-describedby={fieldError ? `${id}-error` : undefined}
        />
      </label>
      {fieldError && (
        <p id={`${id}-error`} className="text-xs text-mw-danger">
          {fieldError}
        </p>
      )}
      {props.error && (
        <p role="alert" className="text-sm text-mw-danger">
          {props.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant={props.destructive ? "destructive" : "default"} disabled={props.busy}>
          {props.busy ? "Checking…" : props.submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        {props.allowRecovery && (
          <button
            type="button"
            className="text-sm text-mw-text-muted underline-offset-2 hover:underline"
            onClick={() => {
              setUseRecovery((value) => !value);
              setFieldError(undefined);
            }}
          >
            {useRecovery
              ? "Use the app instead"
              : "Use a recovery code instead"}
          </button>
        )}
      </div>
    </form>
  );
}

type SecurityView =
  | { kind: "status" }
  | { kind: "enrol" }
  | { kind: "remove" }
  | { kind: "reissue" }
  /** Freshly reissued codes, shown once. */
  | { kind: "codes"; codes: string[] };

/**
 * Security: the authenticator app and its recovery codes. The state comes
 * from `GET /api/me/mfa`; the wizard, the removal and the reissue are the
 * `/api/me/mfa/*` writes, each needing a code from the app (or, for
 * removal, a recovery code) -- the session cookie alone must not be able
 * to switch off the factor that protects it. While the org requires a
 * second factor the Remove action is unavailable and says why.
 */
function SecuritySection() {
  const shell = useShell();
  const email = shell.principal.email ?? undefined;
  const [mfa, setMfa] = useState<MfaState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<SecurityView>({ kind: "status" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setMfa(await apiFetch<MfaState>("/api/me/mfa"));
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof ApiError
          ? err.message
          : "Could not load your two-factor settings.",
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<MfaState>("/api/me/mfa")
      .then((state) => {
        if (cancelled) return;
        setMfa(state);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError
            ? err.message
            : "Could not load your two-factor settings.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(
    () => apiFetch<TotpEnrolment>("/api/me/mfa/totp/start", { method: "POST" }),
    [],
  );
  const confirm = useCallback(async (code: string) => {
    const body = await apiFetch<{ recovery_codes: string[] }>(
      "/api/me/mfa/totp/confirm",
      {
        method: "POST",
        json: { code },
      },
    );
    return body.recovery_codes;
  }, []);

  function open(next: SecurityView) {
    setActionError(null);
    setView(next);
  }

  async function remove(proof: { code?: string; recovery_code?: string }) {
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch("/api/me/mfa/totp", { method: "DELETE", json: proof });
      setView({ kind: "status" });
      await reload();
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? err.message
          : "Could not remove the authenticator.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function reissue(proof: { code?: string; recovery_code?: string }) {
    setBusy(true);
    setActionError(null);
    try {
      const body = await apiFetch<{ recovery_codes: string[] }>(
        "/api/me/mfa/recovery-codes",
        {
          method: "POST",
          json: proof,
        },
      );
      setView({ kind: "codes", codes: body.recovery_codes });
      await reload();
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : "Could not issue new codes.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <p role="alert" className="text-sm text-mw-danger">
        {loadError}
      </p>
    );
  }
  if (mfa === null) {
    return (
      <p className="text-sm text-mw-text-muted">Loading two-factor settings…</p>
    );
  }

  if (view.kind === "enrol") {
    return (
      <EnrolWizard
        start={start}
        confirm={confirm}
        email={email}
        doneLabel="Done"
        onDone={() => {
          setView({ kind: "status" });
          void reload();
        }}
        onCancel={() => setView({ kind: "status" })}
      />
    );
  }
  if (view.kind === "codes") {
    return (
      <div className="flex flex-col gap-3" aria-live="polite">
        <RecoveryCodes codes={view.codes} email={email} />
        <div>
          <Button type="button" onClick={() => setView({ kind: "status" })}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap items-center gap-x-2 text-sm" aria-live="polite">
        <StatusDot tone={mfa.totp_enrolled ? "positive" : "neutral"} />
        {mfa.totp_enrolled ? (
          <>
            <span className="font-medium">Authenticator app is on.</span>{" "}
            {mfa.recovery_codes_left === 1
              ? "1 recovery code left."
              : `${mfa.recovery_codes_left} recovery codes left.`}
          </>
        ) : (
          <>
            <span className="font-medium">No authenticator app.</span> Add one
            and every sign-in asks for a code from it as well as your password.
          </>
        )}
      </p>
      {mfa.org_requires_mfa && (
        <p className="text-sm text-mw-text-muted">
          Your organisation requires an authenticator on every account
          {mfa.totp_enrolled ? ", so it cannot be removed here." : "."}
        </p>
      )}
      {view.kind === "remove" && (
        <ProofForm
          title="Remove the authenticator"
          submitLabel="Remove"
          destructive
          allowRecovery
          busy={busy}
          error={actionError}
          onSubmit={(proof) => void remove(proof)}
          onCancel={() => setView({ kind: "status" })}
        />
      )}
      {view.kind === "reissue" && (
        <ProofForm
          title="Issue new recovery codes"
          submitLabel="Issue new codes"
          allowRecovery={false}
          busy={busy}
          error={actionError}
          onSubmit={(proof) => void reissue(proof)}
          onCancel={() => setView({ kind: "status" })}
        />
      )}
      {view.kind === "status" && (
        <div className="flex flex-wrap items-center gap-2">
          {mfa.totp_enrolled ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => open({ kind: "reissue" })}
              >
                New recovery codes
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={mfa.org_requires_mfa}
                onClick={() => open({ kind: "remove" })}
              >
                Remove authenticator
              </Button>
            </>
          ) : (
            <Button type="button" onClick={() => open({ kind: "enrol" })}>
              Set up an authenticator
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

type PasskeysView =
  | { kind: "list" }
  /** Naming the passkey about to be made; the browser prompt follows the name. */
  | { kind: "add" }
  | { kind: "rename"; id: string };

/**
 * Passkeys: the credentials this account can sign in with instead of a
 * password. The list is `GET /api/me/passkeys`; adding one is the API's
 * creation options, the browser's prompt, and the attestation back with
 * the name (lib/passkeys.ts). The password stays: a passkey is one more
 * way in, and removing the last one leaves the password sign-in as it
 * was. Hidden with a line saying why on a browser that cannot take part.
 */
export function PasskeysCard() {
  const shell = useShell();
  const [list, setList] = useState<PasskeyInfo[] | null>(null);
  const [rpId, setRpId] = useState<string | null>(null);
  const [max, setMax] = useState(10);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<PasskeysView>({ kind: "list" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const nameId = useId();
  const supported = passkeysSupported();
  const offered = shell.authConfig.passkey_login === true;

  useEffect(() => {
    if (!offered) return;
    let cancelled = false;
    fetchPasskeys()
      .then((body) => {
        if (cancelled) return;
        setList(body.passkeys);
        setRpId(body.rp_id);
        setMax(body.max);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setList([]);
        setLoadError(err instanceof ApiError ? err.message : "Could not load your passkeys.");
      });
    return () => {
      cancelled = true;
    };
  }, [offered]);

  if (!offered) return null;

  /** A name for a new passkey, guessed from the browser it is being made in. */
  function suggestedName(): string {
    const agent = navigator.userAgent;
    const os = /Windows/.test(agent)
      ? "Windows"
      : /Android/.test(agent)
        ? "Android"
        : /iPhone|iPad/.test(agent)
          ? "iPhone"
          : /Mac OS/.test(agent)
            ? "Mac"
            : /Linux/.test(agent)
              ? "Linux"
              : "";
    return os ? `${os} passkey` : "This device";
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name) {
      setError("Give the passkey a name, like the device it lives on.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const made = await addPasskey(name);
      setList((rows) => [...(rows ?? []), made]);
      setView({ kind: "list" });
      setNotice(`Passkey "${made.name}" added. You can sign in with it from the login page.`);
    } catch (err) {
      if (err instanceof PasskeyCancelled) {
        setError("The passkey prompt was closed before a passkey was made. Nothing was added.");
      } else {
        setError(err instanceof ApiError ? err.message : "Could not add the passkey.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function rename(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name) {
      setError("A passkey needs a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const renamed = await renamePasskey(id, name);
      setList((rows) => (rows ?? []).map((row) => (row.id === id ? renamed : row)));
      setView({ kind: "list" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not rename the passkey.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: PasskeyInfo) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await removePasskey(row.id);
      setList((rows) => (rows ?? []).filter((r) => r.id !== row.id));
      setNotice(`Passkey "${row.name}" removed. It can no longer sign in to this account.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove the passkey.");
    } finally {
      setBusy(false);
    }
  }

  const rows = list ?? [];
  const full = rows.length >= max;
  return (
    <PaneSection
      title="Passkeys"
      description="Sign in with your fingerprint, face or device PIN."
      flush
    >
      <div className="flex flex-col" data-mw-passkeys="">
        <div className="flex flex-col gap-2 px-5 py-4">
          <p className="text-sm" aria-live="polite">
            {list === null ? (
              "Loading passkeys…"
            ) : rows.length === 0 ? (
              <>
                <span className="font-medium">No passkeys.</span> Add one to sign in with your
                fingerprint, face or device PIN instead of a password.
              </>
            ) : (
              <>
                <span className="font-medium">
                  {rows.length === 1 ? "1 passkey." : `${rows.length} passkeys.`}
                </span>{" "}
                Any of them signs in to this account without the password.
              </>
            )}
          </p>
          <LearnMore>
            <p>A passkey is a way in beside your password, not a replacement for it.</p>
          </LearnMore>
          {loadError && (
            <p role="alert" className="text-sm text-mw-danger">
              {loadError}
            </p>
          )}
        </div>
        {rows.length > 0 && (
          <RowList aria-label="Passkeys" className="border-t border-border">
            {rows.map((row) =>
              view.kind === "rename" && view.id === row.id ? (
                <Row
                  key={row.id}
                  leading={<PasskeyMark />}
                  title={row.name}
                  extra={
                    <form
                      className="mt-2 flex flex-wrap items-end gap-2"
                      onSubmit={(event) => void rename(event, row.id)}
                    >
                      <label className="flex min-w-0 flex-col gap-1">
                        <span className="text-sm font-normal text-mw-text-muted">New name</span>
                        <Input name="name" defaultValue={row.name} maxLength={64} autoFocus />
                      </label>
                      <Button type="submit" size="sm" disabled={busy}>
                        Save
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setView({ kind: "list" })}
                      >
                        Cancel
                      </Button>
                    </form>
                  }
                />
              ) : (
                <Row
                  key={row.id}
                  leading={<PasskeyMark />}
                  title={row.name}
                  meta={
                    <>
                      Added <time dateTime={row.created_at}>{formatSeen(row.created_at)}</time>
                    </>
                  }
                  trailing={
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Rename ${row.name}`}
                        onClick={() => {
                          setError(null);
                          setView({ kind: "rename", id: row.id });
                        }}
                      >
                        Rename
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        aria-label={`Remove ${row.name}`}
                        onClick={() => void remove(row)}
                      >
                        Remove
                      </Button>
                    </>
                  }
                />
              ),
            )}
          </RowList>
        )}
        {(view.kind === "add" || (view.kind === "list" && list !== null) || notice || error) && (
          <div className="flex flex-col gap-3 border-t border-border px-5 py-4">
            {view.kind === "add" && (
              <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void add(event)}>
                <label htmlFor={nameId} className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
                  <span className="text-sm text-mw-text-muted">Name this passkey</span>
                  <Input
                    id={nameId}
                    name="name"
                    defaultValue={suggestedName()}
                    maxLength={64}
                    autoFocus
                  />
                </label>
                <Button type="submit" disabled={busy}>
                  {busy ? "Waiting for your device…" : "Create passkey"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setView({ kind: "list" });
                  }}
                >
                  Cancel
                </Button>
                <p className="basis-full text-xs text-mw-text-muted">
                  Your browser will ask you to confirm with your fingerprint, face or PIN.
                  {rpId ? ` The passkey works for ${rpId}.` : ""}
                </p>
              </form>
            )}
            {view.kind === "list" && list !== null && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !supported || full}
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    setView({ kind: "add" });
                  }}
                >
                  Add a passkey
                </Button>
                {!supported && (
                  <span className="text-xs text-mw-text-muted">
                    This browser cannot make passkeys here; a secure (https) connection and a
                    recent browser are needed.
                  </span>
                )}
                {supported && full && (
                  <span className="text-xs text-mw-text-muted">
                    This account holds the most passkeys it can ({max}). Remove one to add another.
                  </span>
                )}
              </div>
            )}
            {notice && (
              <Alert variant="success" role="status">
                {notice}
              </Alert>
            )}
            {error && (
              <p role="alert" className="text-sm text-mw-danger">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </PaneSection>
  );
}

/** A passkey row's mark: a key, since the name beside it is the person's own label. */
function PasskeyMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-mw-surface-raised text-mw-text-muted"
    >
      <KeyRoundIcon className="size-4" />
    </span>
  );
}

/**
 * Account: the identity the request is made as. The display name, the
 * email address and the password are the editable fields -- they are the person's own -- and
 * the rest describes the session: subject, org, roles. Under MW_AUTH_MODE=none the
 * principal is a fixed dev identity the API synthesises; the name still
 * saves (to the in-memory store) so the pane behaves the same on a laptop.
 */
export function AccountPane() {
  const shell = useShell();
  const {
    email,
    subject,
    name,
    org_id: orgId,
    org_name: orgName,
    kind,
    roles,
    org_role: orgRole,
  } = shell.principal;
  const isDevPrincipal = shell.authConfig.auth_mode === "none";
  // The API says whether there is a password: none under MW_AUTH_MODE=none,
  // none for an account that only signs in through its org's IdP.
  const hasPassword = shell.principal.has_password === true;

  return (
    <div className="flex flex-col gap-4">
      <PaneSection
        title="Identity"
        description={
          isDevPrincipal
            ? "No identity provider here: these values come from the dev principal."
            : undefined
        }
      >
        <DisplayNameField name={name} />
        <dl className="mt-2 divide-y divide-border border-t border-border">
          <Field label="Email" value={email ?? "Not set"} />
          <Field label="Organisation" value={orgName ?? "No organisation"} />
          {orgRole && <Field label="Role" value={roleLabel(orgRole)} />}
        </dl>
        {/* The ids are for support and scripts, not for recognising
            yourself: kept, but folded away. */}
        <LearnMore label="Technical details" className="mt-3">
          <dl className="divide-y divide-border">
            <Field label="User id" value={subject} />
            <Field label="Organisation id" value={orgId ?? "None"} />
            <Field label="Signed in as" value={kind} />
            <Field
              label="Platform roles"
              value={roles.length > 0 ? roles.join(", ") : "None"}
            />
          </dl>
        </LearnMore>
      </PaneSection>

      {hasPassword && (
        <PaneSection
          title="Email"
          description="Move your sign-in to a new address."
        >
          <EmailCard />
          <LearnMore className="mt-3">
            <p>
              The new address has to receive a code first; until then your current
              address keeps working.
            </p>
          </LearnMore>
        </PaneSection>
      )}

      {hasPassword && (
        <PaneSection
          title="Password"
          description="Changing it signs out every other device."
        >
          <Toaster>
            <PasswordCard />
          </Toaster>
        </PaneSection>
      )}

      <PaneSection
        title="Two-factor authentication"
        description="A code from an authenticator app at every sign-in."
      >
        <SecuritySection />
        <LearnMore className="mt-3">
          <p>Recovery codes stand in for the app when it is gone.</p>
        </LearnMore>
      </PaneSection>

      <PasskeysCard />

      <SessionsList />
    </div>
  );
}
