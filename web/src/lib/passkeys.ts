import { apiFetch } from "./api";
import { createPasskey, getPasskey, type JsonObject } from "./webauthn";

/**
 * Passkeys, typed once (api/matterwave/passkeys.py).
 *
 * Registration is two requests around one browser prompt: `start` hands
 * back the provider's creation options, the browser makes the credential,
 * `verify` hands the attestation back with the name. Sign-in is the same
 * shape on the anonymous side, with the provider's session sealed in
 * `challenge` between the two calls; the second answers the same redirect
 * the password form gets, into `/api/auth/callback`.
 */

export interface PasskeyInfo {
  id: string;
  name: string;
  created_at: string;
}

export interface PasskeyList {
  passkeys: PasskeyInfo[];
  /** The relying-party id the passkeys are bound to, for the pane's hint. */
  rp_id: string;
  max: number;
}

export function fetchPasskeys(): Promise<PasskeyList> {
  return apiFetch<PasskeyList>("/api/me/passkeys");
}

/**
 * Register a passkey on this device: options from the API, the browser's
 * prompt, the attestation back with `name`. Rejects with `PasskeyCancelled`
 * when the person closed the prompt, with an `ApiError` when the API
 * refused either half.
 */
export async function addPasskey(name: string): Promise<PasskeyInfo> {
  const started = await apiFetch<{ passkey_id: string; options: JsonObject }>(
    "/api/me/passkeys/start",
    { method: "POST" },
  );
  const credential = await createPasskey(started.options);
  return apiFetch<PasskeyInfo>(`/api/me/passkeys/${encodeURIComponent(started.passkey_id)}/verify`, {
    method: "POST",
    json: { credential, name },
  });
}

export function renamePasskey(id: string, name: string): Promise<PasskeyInfo> {
  return apiFetch<PasskeyInfo>(`/api/me/passkeys/${encodeURIComponent(id)}`, {
    method: "PATCH",
    json: { name },
  });
}

export function removePasskey(id: string): Promise<void> {
  return apiFetch<void>(`/api/me/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Sign in with a passkey for `email`: the challenge for this address, the
 * browser's prompt, the assertion back. Resolves to the redirect that
 * finishes the sign-in. The API's refusals (`no_passkey`, `sso_required`,
 * a refused assertion) arrive as `ApiError`s for the page to render.
 */
export async function signInWithPasskey(email: string, authRequest: string): Promise<string> {
  const started = await apiFetch<{ challenge: string; options: JsonObject }>(
    "/api/auth/passkey/start",
    { method: "POST", json: { email, auth_request: authRequest } },
  );
  const credential = await getPasskey(started.options);
  const finished = await apiFetch<{ redirect: string }>("/api/auth/passkey/finish", {
    method: "POST",
    json: { challenge: started.challenge, credential },
  });
  return finished.redirect;
}
