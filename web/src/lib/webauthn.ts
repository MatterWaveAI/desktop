/**
 * The browser half of a passkey ceremony, and nothing else.
 *
 * The API hands over the options the identity provider minted (the
 * `{publicKey: {...}}` shape, every buffer base64url-encoded, as Zitadel's
 * own login UI receives them) and takes back the `PublicKeyCredential` the
 * browser produced, in the JSON form WebAuthn Level 3 defines
 * (`PublicKeyCredential.toJSON()`): `id`, `rawId`, `type`, `response` with
 * its buffers base64url-encoded, `clientExtensionResults`, and the
 * attachment when the browser says it.
 *
 * Decoded and encoded by hand rather than with
 * `parseCreationOptionsFromJSON` / `toJSON`, which Safari and older Chrome
 * do not ship. The shapes are small and fixed, and a hand-rolled codec that
 * works everywhere beats a native one that works in two browsers.
 *
 * No key material and no verification live here: the provider verifies
 * the attestation and the assertion; this file only moves bytes between
 * JSON and ArrayBuffers.
 */

export type JsonObject = Record<string, unknown>;

/** Whether this browser can take part at all: a secure context with WebAuthn. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator.credentials?.create === "function"
  );
}

export function fromBase64Url(text: string): ArrayBuffer {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function toBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function publicKeyOf(options: JsonObject): JsonObject {
  const inner = options.publicKey;
  if (inner && typeof inner === "object") return inner as JsonObject;
  // Some providers answer the bare options rather than wrapping them.
  return options;
}

function descriptors(list: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.map((entry) => {
    const d = entry as JsonObject;
    return {
      type: "public-key",
      id: fromBase64Url(String(d.id)),
      ...(Array.isArray(d.transports)
        ? { transports: d.transports as AuthenticatorTransport[] }
        : {}),
    };
  });
}

/** The provider's creation options as `navigator.credentials.create` wants them. */
export function toCreationOptions(json: JsonObject): PublicKeyCredentialCreationOptions {
  const pk = publicKeyOf(json);
  const user = (pk.user ?? {}) as JsonObject;
  const options: PublicKeyCredentialCreationOptions = {
    challenge: fromBase64Url(String(pk.challenge)),
    rp: pk.rp as PublicKeyCredentialRpEntity,
    user: {
      id: fromBase64Url(String(user.id)),
      name: String(user.name ?? ""),
      displayName: String(user.displayName ?? user.name ?? ""),
    },
    pubKeyCredParams: (pk.pubKeyCredParams ?? []) as PublicKeyCredentialParameters[],
  };
  if (typeof pk.timeout === "number") options.timeout = pk.timeout;
  if (pk.attestation) options.attestation = pk.attestation as AttestationConveyancePreference;
  if (pk.authenticatorSelection) {
    options.authenticatorSelection = pk.authenticatorSelection as AuthenticatorSelectionCriteria;
  }
  const exclude = descriptors(pk.excludeCredentials);
  if (exclude) options.excludeCredentials = exclude;
  if (pk.extensions) options.extensions = pk.extensions as AuthenticationExtensionsClientInputs;
  return options;
}

/** The provider's request options as `navigator.credentials.get` wants them. */
export function toRequestOptions(json: JsonObject): PublicKeyCredentialRequestOptions {
  const pk = publicKeyOf(json);
  const options: PublicKeyCredentialRequestOptions = {
    challenge: fromBase64Url(String(pk.challenge)),
  };
  if (typeof pk.timeout === "number") options.timeout = pk.timeout;
  if (typeof pk.rpId === "string") options.rpId = pk.rpId;
  if (pk.userVerification) {
    options.userVerification = pk.userVerification as UserVerificationRequirement;
  }
  const allow = descriptors(pk.allowCredentials);
  if (allow) options.allowCredentials = allow;
  if (pk.extensions) options.extensions = pk.extensions as AuthenticationExtensionsClientInputs;
  return options;
}

/** The credential the browser produced, in the JSON form the provider verifies. */
export function credentialToJSON(credential: PublicKeyCredential): JsonObject {
  const response = credential.response;
  const out: JsonObject = {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
  const attachment = (credential as { authenticatorAttachment?: string | null })
    .authenticatorAttachment;
  if (attachment) out.authenticatorAttachment = attachment;
  if ("attestationObject" in response) {
    const attestation = response as AuthenticatorAttestationResponse;
    const body: JsonObject = {
      clientDataJSON: toBase64Url(attestation.clientDataJSON),
      attestationObject: toBase64Url(attestation.attestationObject),
    };
    if (typeof attestation.getTransports === "function") {
      body.transports = attestation.getTransports();
    }
    out.response = body;
  } else {
    const assertion = response as AuthenticatorAssertionResponse;
    const body: JsonObject = {
      clientDataJSON: toBase64Url(assertion.clientDataJSON),
      authenticatorData: toBase64Url(assertion.authenticatorData),
      signature: toBase64Url(assertion.signature),
    };
    if (assertion.userHandle) body.userHandle = toBase64Url(assertion.userHandle);
    out.response = body;
  }
  return out;
}

/** A person closing the prompt, a timeout, or no matching passkey on this device. */
export class PasskeyCancelled extends Error {
  constructor(message = "The passkey prompt was closed.") {
    super(message);
  }
}

function asCancelled(err: unknown): never {
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) {
    throw new PasskeyCancelled();
  }
  throw err;
}

/** Run the creation ceremony for the provider's options; the credential as JSON. */
export async function createPasskey(options: JsonObject): Promise<JsonObject> {
  try {
    const credential = await navigator.credentials.create({
      publicKey: toCreationOptions(options),
    });
    if (!credential) throw new PasskeyCancelled();
    return credentialToJSON(credential as PublicKeyCredential);
  } catch (err) {
    return asCancelled(err);
  }
}

/** Run the assertion ceremony for the provider's options; the credential as JSON. */
export async function getPasskey(options: JsonObject): Promise<JsonObject> {
  try {
    const credential = await navigator.credentials.get({
      publicKey: toRequestOptions(options),
    });
    if (!credential) throw new PasskeyCancelled();
    return credentialToJSON(credential as PublicKeyCredential);
  } catch (err) {
    return asCancelled(err);
  }
}
