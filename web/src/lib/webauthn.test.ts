import { describe, expect, it } from "vitest";
import {
  credentialToJSON,
  fromBase64Url,
  passkeysSupported,
  toBase64Url,
  toCreationOptions,
  toRequestOptions,
} from "./webauthn";

/**
 * The codec between the provider's JSON and the browser's buffers. What is
 * pinned: base64url round-trips without padding, the challenge and every
 * credential id become ArrayBuffers, and a credential comes back in the
 * JSON shape the provider verifies (buffers base64url, nothing invented).
 */

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("base64url", () => {
  it("round-trips bytes without padding, with the url alphabet", () => {
    const raw = bytes(0xfb, 0xff, 0xbf, 0x00, 0x01);
    const text = toBase64Url(raw);
    expect(text).not.toMatch(/[+/=]/);
    expect(new Uint8Array(fromBase64Url(text))).toEqual(raw);
  });

  it("decodes what a provider sends, padded or not", () => {
    expect(new TextDecoder().decode(fromBase64Url("aGk"))).toBe("hi");
    expect(new TextDecoder().decode(fromBase64Url("aGk="))).toBe("hi");
  });
});

describe("passkeysSupported", () => {
  it("says no inside the desktop shell: the rpId can never match the webview origin", () => {
    // The Tauri globals the desktopAuth module detects the shell by.
    (window as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    try {
      expect(passkeysSupported()).toBe(false);
    } finally {
      delete (window as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    }
  });
});

describe("the provider's options", () => {
  it("turns creation options into buffers where the browser wants them", () => {
    const options = toCreationOptions({
      publicKey: {
        challenge: toBase64Url(bytes(1, 2, 3)),
        rp: { id: "app.example", name: "MatterWave" },
        user: { id: toBase64Url(bytes(9)), name: "ada@example.com", displayName: "Ada" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        timeout: 60000,
        attestation: "none",
        authenticatorSelection: { userVerification: "required" },
        excludeCredentials: [{ type: "public-key", id: toBase64Url(bytes(7, 7)) }],
      },
    });
    expect(new Uint8Array(options.challenge as ArrayBuffer)).toEqual(bytes(1, 2, 3));
    expect(new Uint8Array(options.user.id as ArrayBuffer)).toEqual(bytes(9));
    expect(options.rp.id).toBe("app.example");
    expect(options.timeout).toBe(60000);
    expect(options.attestation).toBe("none");
    expect(new Uint8Array(options.excludeCredentials![0].id as ArrayBuffer)).toEqual(bytes(7, 7));
  });

  it("turns request options into buffers, allowCredentials included", () => {
    const options = toRequestOptions({
      publicKey: {
        challenge: toBase64Url(bytes(4, 5)),
        rpId: "app.example",
        userVerification: "required",
        allowCredentials: [{ type: "public-key", id: toBase64Url(bytes(8)) }],
      },
    });
    expect(new Uint8Array(options.challenge as ArrayBuffer)).toEqual(bytes(4, 5));
    expect(options.rpId).toBe("app.example");
    expect(options.userVerification).toBe("required");
    expect(new Uint8Array(options.allowCredentials![0].id as ArrayBuffer)).toEqual(bytes(8));
  });

  it("accepts the bare options when the provider does not wrap them", () => {
    const options = toRequestOptions({ challenge: toBase64Url(bytes(1)) });
    expect(new Uint8Array(options.challenge as ArrayBuffer)).toEqual(bytes(1));
  });
});

describe("the browser's credential", () => {
  function fakeCredential(response: object): PublicKeyCredential {
    return {
      id: "Y3JlZA",
      rawId: bytes(99, 114, 101, 100).buffer,
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
      response,
    } as unknown as PublicKeyCredential;
  }

  it("encodes an attestation with its buffers base64url", () => {
    const json = credentialToJSON(
      fakeCredential({
        clientDataJSON: bytes(1).buffer,
        attestationObject: bytes(2).buffer,
        getTransports: () => ["internal"],
      }),
    );
    expect(json).toEqual({
      id: "Y3JlZA",
      rawId: "Y3JlZA",
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: "AQ",
        attestationObject: "Ag",
        transports: ["internal"],
      },
    });
  });

  it("encodes an assertion, with the user handle only when there is one", () => {
    const json = credentialToJSON(
      fakeCredential({
        clientDataJSON: bytes(1).buffer,
        authenticatorData: bytes(2).buffer,
        signature: bytes(3).buffer,
        userHandle: null,
      }),
    );
    expect(json.response).toEqual({
      clientDataJSON: "AQ",
      authenticatorData: "Ag",
      signature: "Aw",
    });
  });
});
