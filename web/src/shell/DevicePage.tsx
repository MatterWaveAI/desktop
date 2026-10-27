import { useContext, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Button } from "../components/ui/button";
import { ApiError, apiFetch } from "../lib/api";
import { Alert, AuthPage, DonePanel, Field } from "./AuthForm";
import { ensureAuthConfig, failureMessage, queryParam } from "./authForms";
import { DEVICE_PATH, LOGIN_PATH } from "./frontDoor";
import { ShellContext } from "./shellContext";

/**
 * Device login: `/device?user_code=`. A terminal or an editor printed a
 * code and this URL; the person checks the code here and approves, and the
 * device's next poll gets an API key for them (the API's device_login.py).
 *
 * Anonymous like /join so the link opens before there is a session, but it
 * acts only for a signed-in person: without one it sends the browser to the
 * login with the way back in `?return=`. Signed in, the code is looked up
 * first so the page can say which client asked -- approving a code someone
 * else read out to you is the attack this flow has, and the name is the
 * check against it.
 */

interface DeviceLookup {
  user_code: string;
  client_name: string | null;
  expires_in: number;
}

type DeviceState =
  | { phase: "form" }
  | { phase: "looking" }
  | { phase: "confirm"; device: DeviceLookup }
  | { phase: "deciding"; device: DeviceLookup }
  | { phase: "approved"; device: DeviceLookup }
  | { phase: "denied"; device: DeviceLookup }
  | { phase: "error"; message: string; device?: DeviceLookup };

/** The API's cap on a key name (device_login.MAX_CLIENT_NAME). */
const KEY_NAME_MAX_LENGTH = 64;

/** XXXX-XXXX; the API also forgives case, spaces and the hyphen. */
const USER_CODE_SHAPE = /^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/;

function validateUserCode(code: string): string | undefined {
  if (code === "") return "Enter the code shown on your device.";
  if (!USER_CODE_SHAPE.test(code.replace(/\s/g, ""))) {
    return "The code is the eight characters shown on your device, like ABCD-2345.";
  }
  return undefined;
}

function clientLabel(device: DeviceLookup): string {
  return device.client_name ?? "A device";
}

/**
 * Which client a code belongs to. A 404 or 409 is about the code (unknown,
 * expired, already decided), so it goes on the field; anything else is the
 * page's problem.
 */
async function lookupOutcome(code: string): Promise<{ state: DeviceState; codeError?: string }> {
  try {
    await ensureAuthConfig();
    const device = await apiFetch<DeviceLookup>("/api/auth/device/lookup", {
      method: "POST",
      json: { user_code: code },
    });
    return { state: { phase: "confirm", device } };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
      return { state: { phase: "form" }, codeError: err.message };
    }
    return { state: { phase: "error", message: failureMessage(err) } };
  }
}

/** Where login should bring the person back to, code included. */
function deviceReturnPath(code: string | undefined): string {
  return code ? `${DEVICE_PATH}?user_code=${encodeURIComponent(code)}` : DEVICE_PATH;
}

export function DevicePage() {
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const prefilled = queryParam(searchStr, "user_code") ?? "";
  // Null outside the shell: no session, so the front door rendered this page.
  const shell = useContext(ShellContext);
  // The effects key on this, not on `shell`: the shell's context value is a
  // new object on its every render, and a lookup re-run after the approval
  // would find the code decided and put the form back.
  const signedIn = shell !== null;
  const navigate = useNavigate();
  const [state, setState] = useState<DeviceState>({ phase: prefilled ? "looking" : "form" });
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const id = useId();

  // Once: while the router moves to the login the page renders again with
  // the login's search, and a second send would lose the code.
  const sentToLogin = useRef(false);

  useEffect(() => {
    if (signedIn || sentToLogin.current) return;
    sentToLogin.current = true;
    void navigate({
      href: `${LOGIN_PATH}?return=${encodeURIComponent(deviceReturnPath(prefilled || undefined))}`,
      replace: true,
    });
  }, [signedIn, navigate, prefilled]);

  useEffect(() => {
    if (!signedIn || !prefilled) return;
    let alive = true;
    void lookupOutcome(prefilled).then((outcome) => {
      if (!alive) return;
      setCodeError(outcome.codeError);
      setState(outcome.state);
    });
    return () => {
      alive = false;
    };
  }, [signedIn, prefilled]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const code = String(data.get("user_code") ?? "").trim();
    const error = validateUserCode(code);
    setCodeError(error);
    if (error) return;
    setState({ phase: "looking" });
    const outcome = await lookupOutcome(code);
    setCodeError(outcome.codeError);
    setState(outcome.state);
  }

  /**
   * `name` is what the key will be listed as in Settings ("Device: <name>");
   * the API falls back to the client's own name, then the code, so an empty
   * field is not an error and is simply not sent.
   */
  async function decide(device: DeviceLookup, decision: "approve" | "deny", name?: string) {
    setState({ phase: "deciding", device });
    try {
      await apiFetch(`/api/auth/device/${decision}`, {
        method: "POST",
        json: name ? { user_code: device.user_code, name } : { user_code: device.user_code },
      });
      setState({ phase: decision === "approve" ? "approved" : "denied", device });
    } catch (err) {
      setState({ phase: "error", message: failureMessage(err), device });
    }
  }

  function handleApprove(event: FormEvent<HTMLFormElement>, device: DeviceLookup) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    void decide(device, "approve", name.slice(0, KEY_NAME_MAX_LENGTH) || undefined);
  }

  if (shell === null) {
    return (
      <AuthPage title="Sign in to approve a device">
        <p aria-live="polite" className="animate-pulse text-sm text-mw-text-muted">
          Taking you to sign in…
        </p>
      </AuthPage>
    );
  }

  const { principal } = shell;
  const who = principal.email ?? principal.subject;

  if (state.phase === "approved") {
    return (
      <AuthPage title="Device approved" brand={false}>
        <div aria-live="polite">
          <DonePanel id={id} title={`${clientLabel(state.device)} is signed in`}>
            <p className="text-sm text-mw-text-muted">
              It signs in as {who} with a key named after it, which you can revoke in Settings,
              under API keys. You can close this page.
            </p>
          </DonePanel>
        </div>
      </AuthPage>
    );
  }
  if (state.phase === "denied") {
    return (
      <AuthPage title="Device denied" brand={false}>
        <div aria-live="polite">
          <DonePanel id={id} title="The sign-in was denied">
            <p className="text-sm text-mw-text-muted">
              {clientLabel(state.device)} was not given access. You can close this page.
            </p>
          </DonePanel>
        </div>
      </AuthPage>
    );
  }

  const device =
    state.phase === "confirm" || state.phase === "deciding"
      ? state.device
      : state.phase === "error"
        ? state.device
        : undefined;

  if (device !== undefined) {
    const busy = state.phase === "deciding";
    return (
      <AuthPage
        title="Approve this device?"
        intro={`${clientLabel(device)} wants to sign in to MatterWave as ${who}.`}
        brand={false}
      >
        {state.phase === "error" && (
          <Alert>
            <p>{state.message}</p>
          </Alert>
        )}
        <div className="flex flex-col gap-1 rounded-lg border border-mw-border bg-mw-surface-raised p-4">
          <p className="text-sm text-mw-text-muted">Code</p>
          <p className="font-mono text-lg tracking-widest">{device.user_code}</p>
          <p className="text-xs text-mw-text-muted">
            Only approve if this matches the code on your device and you started the sign-in.
          </p>
        </div>
        <form
          noValidate
          aria-busy={busy}
          onSubmit={(event) => handleApprove(event, device)}
          className="flex flex-col gap-4"
        >
          <Field
            id={`${id}-name`}
            name="name"
            label="Key name (optional)"
            // Keyed on the code so a new lookup refills it; the input itself
            // stays uncontrolled, read at submit like the other forms.
            key={device.user_code}
            defaultValue={device.client_name ?? ""}
            maxLength={KEY_NAME_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            hint="How the device's key is listed in Settings, under API keys."
          />
          <div className="flex flex-wrap gap-3">
            {/* The shell's buttons: this page renders inside it. */}
            <Button type="submit" disabled={busy}>
              {busy ? "Working…" : "Approve"}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void decide(device, "deny")}>
              Deny
            </Button>
          </div>
        </form>
      </AuthPage>
    );
  }

  return (
    <AuthPage title="Sign in a device" intro="Enter the code shown in your terminal or editor." brand={false}>
      {state.phase === "error" && (
        <Alert>
          <p>{state.message}</p>
        </Alert>
      )}
      <form noValidate onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
        <Field
          id={`${id}-code`}
          name="user_code"
          label="Code"
          defaultValue={prefilled}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="ABCD-2345"
          error={codeError}
        />
        <div>
          <Button type="submit" disabled={state.phase === "looking"}>
            {state.phase === "looking" ? "Checking…" : "Continue"}
          </Button>
        </div>
      </form>
    </AuthPage>
  );
}
