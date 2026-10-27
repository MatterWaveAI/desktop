import { afterEach, describe, expect, it, vi } from "vitest";
import { createPasskey, passkeysSupported } from "../../../lib/webauthn";
import type { MfaState } from "../../../shell/mfaForms";
import type { SessionInfo } from "../../../types";
import { AccountPane } from "./AccountPane";
import {
  buttonLabelled,
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  setInputValue,
  stubApi,
  submit,
  type Mounted,
} from "./paneHarness";

/**
 * The Account pane as the user sees it: the display name saves through
 * PATCH /api/me and says so (or says why not), and the sessions list names
 * this device, offers to sign the others out one at a time or all at once,
 * and never offers to revoke this device from the list.
 */

// The WebAuthn prompt is the browser's and jsdom has none; the codec is
// tested in lib/webauthn.test.ts. Scripted here so the card's own behaviour
// around the prompt can be seen.
vi.mock("../../../lib/webauthn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/webauthn")>();
  return {
    ...actual,
    passkeysSupported: vi.fn(() => true),
    createPasskey: vi.fn(async () => ({ id: "cred-1", rawId: "cred-1", type: "public-key" })),
  };
});

const THIS_DEVICE: SessionInfo = {
  id: "s-here",
  current: true,
  created_at: "2026-10-01T09:00:00Z",
  last_seen_at: "2026-10-03T08:00:00Z",
  user_agent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36",
  ip: "203.0.113.7",
};

const PHONE: SessionInfo = {
  id: "s-phone",
  current: false,
  created_at: "2026-09-28T09:00:00Z",
  last_seen_at: "2026-10-02T20:00:00Z",
  user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605.1",
  ip: "198.51.100.4",
};

const NOT_ENROLLED: MfaState = {
  totp_enrolled: false,
  recovery_codes_left: 0,
  org_requires_mfa: false,
};

const ENROLLED: MfaState = {
  totp_enrolled: true,
  recovery_codes_left: 7,
  org_requires_mfa: false,
};

function mfaAnswer(state: MfaState): { status: number; body: unknown } {
  return { status: 200, body: state };
}

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function nameInput(): HTMLInputElement {
  const input = mounted!.container.querySelector<HTMLInputElement>(
    "input[name='full_name']",
  );
  if (!input) throw new Error("no name input");
  return input;
}

describe("the display name", () => {
  it("saves the trimmed name through PATCH /api/me and reports it", async () => {
    const calls = stubApi(({ method, url, body }) => {
      if (method === "GET" && url === "/api/me/mfa")
        return mfaAnswer(NOT_ENROLLED);
      if (method === "GET" && url === "/api/me/sessions")
        return { status: 200, body: { sessions: [] } };
      if (method === "PATCH" && url === "/api/me") {
        return {
          status: 200,
          body: { name: (body as { full_name: string }).full_name },
        };
      }
      return undefined;
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      name: "Dev",
    });

    const save = buttonNamed(mounted.container, "Save name");
    expect(save.disabled).toBe(true);

    setInputValue(nameInput(), "  Ada   Lovelace ");
    expect(save.disabled).toBe(false);
    submit(nameInput().form!);
    await flush();

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/api/me");
    expect(patch?.body).toEqual({ full_name: "Ada Lovelace" });
    expect(mounted.container.textContent).toContain("Name saved.");
    expect(nameInput().value).toBe("Ada Lovelace");
    expect(mounted.container.querySelector("[role='alert']")).toBeNull();
  });

  it("will not submit an empty name, and shows the API's refusal when it refuses", async () => {
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/mfa")
        return mfaAnswer(NOT_ENROLLED);
      if (method === "GET" && url === "/api/me/sessions")
        return { status: 200, body: { sessions: [] } };
      if (method === "PATCH" && url === "/api/me") {
        return {
          status: 503,
          body: { detail: "The identity provider did not accept the change." },
        };
      }
      return undefined;
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      name: "Dev",
    });

    setInputValue(nameInput(), "   ");
    expect(buttonNamed(mounted.container, "Save name").disabled).toBe(true);
    submit(nameInput().form!);
    await flush();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);

    setInputValue(nameInput(), "Someone Else");
    submit(nameInput().form!);
    await flush();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(
      mounted.container.querySelector("[role='alert']")?.textContent,
    ).toContain("did not accept the change");
    expect(mounted.container.textContent).not.toContain("Name saved.");
  });
});

describe("the display name, when the API answers without one", () => {
  it("keeps what was typed rather than crashing on a null name", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/mfa")
        return mfaAnswer(NOT_ENROLLED);
      if (method === "GET" && url === "/api/me/sessions")
        return { status: 200, body: { sessions: [] } };
      if (method === "PATCH" && url === "/api/me")
        return { status: 200, body: { name: null } };
      return undefined;
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      name: "Dev",
    });

    setInputValue(nameInput(), "  Ada  Lovelace ");
    submit(nameInput().form!);
    await flush();

    expect(nameInput().value).toBe("Ada Lovelace");
    expect(mounted.container.textContent).toContain("Name saved.");
    expect(buttonNamed(mounted.container, "Save name").disabled).toBe(true);
  });
});

describe("the identity card", () => {
  it("leads with the person and the org, and keeps the ids behind Technical details", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/mfa")
        return mfaAnswer(NOT_ENROLLED);
      if (method === "GET" && url === "/api/me/sessions")
        return { status: 200, body: { sessions: [] } };
      return undefined;
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith(["mw:admin"], "owner"),
      name: "Ada",
    });

    const card = mounted.container.querySelector("section")!;
    const summary = card.querySelector("dl")!;
    expect(summary.textContent).toContain("dev@localhost");
    expect(summary.textContent).toContain("Dev Org");
    expect(summary.textContent).toContain("Owner");
    expect(summary.textContent).not.toContain("dev-user");
    const details = card.querySelector("details")!;
    expect(details.querySelector("summary")?.textContent).toBe("Technical details");
    expect(details.textContent).toContain("dev-user");
    expect(details.textContent).toContain("dev-org");
    expect(details.textContent).toContain("mw:admin");
  });
});

describe("sessions", () => {
  it("lists every session, flags this device and offers no revoke for it", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/sessions"
        ? { status: 200, body: { sessions: [THIS_DEVICE, PHONE] } }
        : method === "GET" && url === "/api/me/mfa"
          ? mfaAnswer(NOT_ENROLLED)
          : undefined,
    );
    mounted = await mount(<AccountPane />, principalWith([]));

    const items = [
      ...mounted.container.querySelectorAll("ul[aria-label='Sessions'] li"),
    ];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Chrome on Windows");
    expect(items[0].textContent).toContain("This device");
    expect(items[0].textContent).toContain("203.0.113.7");
    expect(items[0].querySelector("button")).toBeNull();
    expect(items[1].textContent).toContain("Safari on iOS");
    expect(items[1].textContent).toContain("198.51.100.4");
    expect(items[1].querySelector("button")?.textContent).toBe(
      "Sign out this device",
    );
    expect(
      buttonNamed(mounted.container, "Sign out other devices").disabled,
    ).toBe(false);
  });

  it("revokes one device through DELETE and drops it from the list", async () => {
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/mfa")
        return mfaAnswer(NOT_ENROLLED);
      if (method === "GET" && url === "/api/me/sessions") {
        return { status: 200, body: { sessions: [THIS_DEVICE, PHONE] } };
      }
      if (method === "DELETE" && url === "/api/me/sessions/s-phone") {
        return { status: 200, body: { status: "revoked", current: false } };
      }
      return undefined;
    });
    mounted = await mount(<AccountPane />, principalWith([]));

    click(buttonNamed(mounted.container, "Sign out this device"));
    await flush();

    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.url === "/api/me/sessions/s-phone",
      ),
    ).toBe(true);
    const items = [
      ...mounted.container.querySelectorAll("ul[aria-label='Sessions'] li"),
    ];
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("This device");
    // Nothing left to sign out but this device.
    expect(
      buttonNamed(mounted.container, "Sign out other devices").disabled,
    ).toBe(true);
  });

  it("signs the other devices out in one POST and keeps only this one", async () => {
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/mfa")
        return mfaAnswer(NOT_ENROLLED);
      if (method === "GET" && url === "/api/me/sessions") {
        return {
          status: 200,
          body: { sessions: [PHONE, THIS_DEVICE, { ...PHONE, id: "s-3" }] },
        };
      }
      if (method === "POST" && url === "/api/me/sessions/revoke-others") {
        return { status: 200, body: { revoked: 2 } };
      }
      return undefined;
    });
    mounted = await mount(<AccountPane />, principalWith([]));

    click(buttonNamed(mounted.container, "Sign out other devices"));
    await flush();

    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const items = [
      ...mounted.container.querySelectorAll("ul[aria-label='Sessions'] li"),
    ];
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("This device");
  });

  it("collapses the same device at the same address to one row with a count, most recent first", async () => {
    const again = { ...PHONE, id: "s-phone-2", last_seen_at: "2026-10-03T07:00:00Z" };
    const older = { ...PHONE, id: "s-phone-3", last_seen_at: "2026-09-30T07:00:00Z" };
    // The same browser from another address is another device.
    const elsewhere = { ...PHONE, id: "s-cafe", ip: "192.0.2.9", last_seen_at: "2026-10-01T07:00:00Z" };
    const calls = stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/mfa") return mfaAnswer(NOT_ENROLLED);
      if (method === "GET" && url === "/api/me/sessions") {
        return { status: 200, body: { sessions: [older, elsewhere, PHONE, THIS_DEVICE, again] } };
      }
      if (method === "DELETE" && url.startsWith("/api/me/sessions/s-phone")) {
        return { status: 200, body: { status: "revoked", current: false } };
      }
      return undefined;
    });
    mounted = await mount(<AccountPane />, principalWith([]));
    const rows = () => [...mounted!.container.querySelectorAll("ul[aria-label='Sessions'] li")];

    expect(rows()).toHaveLength(3);
    expect(rows()[0].textContent).toContain("This device");
    expect(rows()[1].textContent).toContain("3 sessions");
    expect(rows()[1].textContent).toContain("198.51.100.4");
    // The row carries the newest sighting of the three, not the first row's.
    expect(rows()[1].querySelector("time, div.text-xs")?.textContent).toContain(
      new Date("2026-10-03T07:00:00Z").toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    );
    expect(rows()[1].querySelector("button")?.textContent).toBe("Sign out all 3");
    expect(rows()[2].textContent).toContain("192.0.2.9");
    expect(rows()[2].querySelector("button")?.textContent).toBe("Sign out this device");

    // The actions sit above the list, and the full list is a toggle away.
    const strip = mounted.container.querySelector("ul[aria-label='Sessions']")!;
    const others = buttonNamed(mounted.container, "Sign out other devices");
    expect(others.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    click(buttonNamed(mounted.container, "Show all 5 sessions"));
    expect(rows()).toHaveLength(5);
    expect(rows().map((r) => r.querySelector("button")?.textContent ?? null)).toEqual([
      null,
      "Sign out this device",
      "Sign out this device",
      "Sign out this device",
      "Sign out this device",
    ]);
    click(buttonNamed(mounted.container, "Show one row per device"));
    expect(rows()).toHaveLength(3);

    // Signing a device out ends every one of its sessions, one DELETE each.
    click(buttonNamed(mounted.container, "Sign out all 3"));
    await flush();
    expect(
      calls.filter((c) => c.method === "DELETE").map((c) => c.url).sort(),
    ).toEqual(["/api/me/sessions/s-phone", "/api/me/sessions/s-phone-2", "/api/me/sessions/s-phone-3"]);
    expect(rows()).toHaveLength(2);
    expect(mounted.container.textContent).not.toContain("3 sessions");
  });

  it("says when nothing is recorded, and still offers Sign out", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/sessions"
        ? { status: 200, body: { sessions: [] } }
        : method === "GET" && url === "/api/me/mfa"
          ? mfaAnswer(NOT_ENROLLED)
          : undefined,
    );
    mounted = await mount(<AccountPane />, principalWith([]));
    expect(mounted.container.textContent).toContain("No sessions are recorded");
    expect(buttonNamed(mounted.container, "Sign out")).toBeDefined();
    expect(
      buttonNamed(mounted.container, "Sign out other devices").disabled,
    ).toBe(true);
  });

  it("shows a refusal from the API rather than an empty list pretending", async () => {
    stubApi(({ method, url }) =>
      method === "GET" && url === "/api/me/sessions"
        ? { status: 503, body: { detail: "Sessions need Postgres." } }
        : method === "GET" && url === "/api/me/mfa"
          ? mfaAnswer(NOT_ENROLLED)
          : undefined,
    );
    mounted = await mount(<AccountPane />, principalWith([]));
    expect(
      mounted.container.querySelector("[role='alert']")?.textContent,
    ).toContain("Sessions need Postgres.");
  });
});

describe("security: the authenticator app", () => {
  const SECRET = "JBSWY3DPEHPK3PXP";
  const ENROLMENT = {
    secret: SECRET,
    uri: `otpauth://totp/MatterWave:dev%40localhost?secret=${SECRET}&issuer=MatterWave`,
    qr_svg:
      "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E",
  };
  const CODES = Array.from(
    { length: 10 },
    (_, i) => `abcd-efgh-${String(i).padStart(4, "j")}`,
  );

  function section(): HTMLElement {
    const heading = [...mounted!.container.querySelectorAll("h2")].find(
      (h) => h.textContent === "Two-factor authentication",
    );
    const card = heading?.closest("section");
    if (!card) throw new Error("no two-factor section");
    return card;
  }

  function proofInput(): HTMLInputElement {
    const input = section().querySelector<HTMLInputElement>(
      "input[name='proof']",
    );
    if (!input) throw new Error("no proof input");
    return input;
  }

  function codeInput(): HTMLInputElement {
    const input =
      section().querySelector<HTMLInputElement>("input[name='code']");
    if (!input) throw new Error("no code input");
    return input;
  }

  /** The Security section's stub: a mutable state the writes advance, like the API would. */
  function stubSecurity(
    initial: MfaState,
    options: { confirmStatus?: number } = {},
  ) {
    let state = { ...initial };
    const calls = stubApi(({ method, url, body }) => {
      if (method === "GET" && url === "/api/me/sessions")
        return { status: 200, body: { sessions: [] } };
      if (method === "GET" && url === "/api/me/mfa") return mfaAnswer(state);
      if (method === "POST" && url === "/api/me/mfa/totp/start")
        return { status: 200, body: ENROLMENT };
      if (method === "POST" && url === "/api/me/mfa/totp/confirm") {
        if (options.confirmStatus) {
          return {
            status: options.confirmStatus,
            body: { detail: "That code is not right." },
          };
        }
        state = { ...state, totp_enrolled: true, recovery_codes_left: 10 };
        return {
          status: 200,
          body: {
            totp_enrolled: true,
            recovery_codes: CODES,
            recovery_codes_left: 10,
          },
        };
      }
      if (method === "DELETE" && url === "/api/me/mfa/totp") {
        if ((body as { code?: string }).code === "000000") {
          return { status: 400, body: { detail: "That code is not right." } };
        }
        state = { ...state, totp_enrolled: false, recovery_codes_left: 0 };
        return {
          status: 200,
          body: { totp_enrolled: false, recovery_codes_left: 0 },
        };
      }
      if (method === "POST" && url === "/api/me/mfa/recovery-codes") {
        state = { ...state, recovery_codes_left: 10 };
        return {
          status: 200,
          body: { recovery_codes: CODES, recovery_codes_left: 10 },
        };
      }
      return undefined;
    });
    return calls;
  }

  it("says there is no authenticator and offers to set one up", async () => {
    stubSecurity(NOT_ENROLLED);
    mounted = await mount(<AccountPane />, principalWith([]));
    expect(section().textContent).toContain("No authenticator app.");
    expect(buttonNamed(section(), "Set up an authenticator")).toBeDefined();
    expect(section().querySelector("button[disabled]")).toBeNull();
  });

  it("runs the wizard: start, QR and key, confirm with the first code, keep the codes", async () => {
    const calls = stubSecurity(NOT_ENROLLED);
    mounted = await mount(<AccountPane />, principalWith([]));

    click(buttonNamed(section(), "Set up an authenticator"));
    await flush();
    expect(
      calls.some(
        (c) => c.method === "POST" && c.url === "/api/me/mfa/totp/start",
      ),
    ).toBe(true);
    const img = section().querySelector<HTMLImageElement>("img");
    expect(img?.getAttribute("src")).toBe(ENROLMENT.qr_svg);
    expect(img?.getAttribute("alt")).toContain("QR code");
    // The key for typing by hand is there, under a disclosure.
    expect(section().textContent).toContain(SECRET);
    expect(section().textContent).toContain("Can't scan it?");

    // An empty code is refused locally, nothing posted.
    submit(codeInput().form!);
    await flush();
    expect(
      calls.filter((c) => c.url === "/api/me/mfa/totp/confirm"),
    ).toHaveLength(0);
    expect(section().textContent).toContain(
      "Enter the code from your authenticator app.",
    );

    setInputValue(codeInput(), "123 456");
    submit(codeInput().form!);
    await flush();
    const confirm = calls.find((c) => c.url === "/api/me/mfa/totp/confirm");
    expect(confirm?.body).toEqual({ code: "123456" });

    // The codes, once, with the two ways to keep them.
    const list = section().querySelector("ol[aria-label='Recovery codes']");
    expect(
      [...list!.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(CODES);
    expect(buttonNamed(section(), "Copy codes")).toBeDefined();
    expect(buttonNamed(section(), "Download codes")).toBeDefined();

    click(buttonNamed(section(), "Done"));
    await flush();
    expect(section().textContent).toContain("Authenticator app is on.");
    expect(section().textContent).toContain("10 recovery codes left.");
    expect(
      section().querySelector("ol[aria-label='Recovery codes']"),
    ).toBeNull();
  });

  it("shows the API's refusal of a wrong code and stays on the scan step", async () => {
    stubSecurity(NOT_ENROLLED, { confirmStatus: 400 });
    mounted = await mount(<AccountPane />, principalWith([]));
    click(buttonNamed(section(), "Set up an authenticator"));
    await flush();
    setInputValue(codeInput(), "000000");
    submit(codeInput().form!);
    await flush();
    expect(section().querySelector("[role='alert']")?.textContent).toContain(
      "not right",
    );
    expect(section().querySelector("img")).not.toBeNull();
    expect(
      section().querySelector("ol[aria-label='Recovery codes']"),
    ).toBeNull();
  });

  it("cancels the wizard back to the status", async () => {
    stubSecurity(NOT_ENROLLED);
    mounted = await mount(<AccountPane />, principalWith([]));
    click(buttonNamed(section(), "Set up an authenticator"));
    await flush();
    click(buttonNamed(section(), "Cancel"));
    await flush();
    expect(section().textContent).toContain("No authenticator app.");
    expect(section().querySelector("img")).toBeNull();
  });

  it("removes the authenticator on a code from the app, through DELETE", async () => {
    const calls = stubSecurity(ENROLLED);
    mounted = await mount(<AccountPane />, principalWith([]));
    expect(section().textContent).toContain("Authenticator app is on.");
    expect(section().textContent).toContain("7 recovery codes left.");

    click(buttonNamed(section(), "Remove authenticator"));
    await flush();
    setInputValue(proofInput(), "000000");
    submit(proofInput().form!);
    await flush();
    expect(section().querySelector("[role='alert']")?.textContent).toContain(
      "not right",
    );
    expect(section().textContent).toContain("Authenticator app is on.");

    setInputValue(proofInput(), "654321");
    submit(proofInput().form!);
    await flush();
    const deletes = calls.filter(
      (c) => c.method === "DELETE" && c.url === "/api/me/mfa/totp",
    );
    expect(deletes.map((c) => c.body)).toEqual([
      { code: "000000" },
      { code: "654321" },
    ]);
    expect(section().textContent).toContain("No authenticator app.");
  });

  it("removes the authenticator on a recovery code instead", async () => {
    const calls = stubSecurity(ENROLLED);
    mounted = await mount(<AccountPane />, principalWith([]));
    click(buttonNamed(section(), "Remove authenticator"));
    await flush();
    click(buttonNamed(section(), "Use a recovery code instead"));
    await flush();
    setInputValue(proofInput(), " abcd-efgh-jjj1 ");
    submit(proofInput().form!);
    await flush();
    const remove = calls.find(
      (c) => c.method === "DELETE" && c.url === "/api/me/mfa/totp",
    );
    expect(remove?.body).toEqual({ recovery_code: "abcd-efgh-jjj1" });
  });

  it("will not offer removal while the org requires a second factor, and says why", async () => {
    stubSecurity({ ...ENROLLED, org_requires_mfa: true });
    mounted = await mount(<AccountPane />, principalWith([]));
    expect(buttonNamed(section(), "Remove authenticator").disabled).toBe(true);
    expect(section().textContent).toContain(
      "Your organisation requires an authenticator",
    );
    expect(section().textContent).toContain("cannot be removed here");
    // Reissuing codes is still the person's to do.
    expect(buttonNamed(section(), "New recovery codes").disabled).toBe(false);
  });

  it("issues new recovery codes on a code from the app, never a recovery code", async () => {
    const calls = stubSecurity(ENROLLED);
    mounted = await mount(<AccountPane />, principalWith([]));
    click(buttonNamed(section(), "New recovery codes"));
    await flush();
    // The lost sheet must not authorise its own replacement: no toggle here.
    expect(
      [...section().querySelectorAll("button")].map((b) => b.textContent),
    ).not.toContain("Use a recovery code instead");
    setInputValue(proofInput(), "111222");
    submit(proofInput().form!);
    await flush();
    const reissue = calls.find((c) => c.url === "/api/me/mfa/recovery-codes");
    expect(reissue?.method).toBe("POST");
    expect(reissue?.body).toEqual({ code: "111222" });
    const list = section().querySelector("ol[aria-label='Recovery codes']");
    expect(list?.querySelectorAll("li")).toHaveLength(10);
    click(buttonNamed(section(), "Done"));
    await flush();
    expect(section().textContent).toContain("10 recovery codes left.");
  });

  it("shows a refusal from the API rather than a status it does not have", async () => {
    stubApi(({ method, url }) => {
      if (method === "GET" && url === "/api/me/sessions")
        return { status: 200, body: { sessions: [] } };
      if (method === "GET" && url === "/api/me/mfa") {
        return {
          status: 503,
          body: { detail: "The identity provider is unavailable right now." },
        };
      }
      return undefined;
    });
    mounted = await mount(<AccountPane />, principalWith([]));
    expect(section().querySelector("[role='alert']")?.textContent).toContain(
      "identity provider is unavailable",
    );
    expect(section().textContent).not.toContain("No authenticator app.");
  });
});

describe("the password card", () => {
  const quiet = ({ method, url }: { method: string; url: string }) => {
    if (method === "GET" && url === "/api/me/mfa")
      return mfaAnswer(NOT_ENROLLED);
    if (method === "GET" && url === "/api/me/sessions")
      return { status: 200, body: { sessions: [] } };
    return undefined;
  };

  function field(name: string): HTMLInputElement {
    const input = mounted!.container.querySelector<HTMLInputElement>(
      `input[name='${name}']`,
    );
    if (!input) throw new Error(`no ${name} input`);
    return input;
  }

  function fill(current: string, next: string, confirm: string) {
    setInputValue(field("current_password"), current);
    setInputValue(field("next_password"), next);
    setInputValue(field("confirm_password"), confirm);
  }

  it("is hidden when the API says there is no password", async () => {
    stubApi(quiet);
    mounted = await mount(<AccountPane />, principalWith([]));
    expect(mounted.container.textContent).not.toContain("Change password");
    expect(
      mounted.container.querySelector("input[name='current_password']"),
    ).toBeNull();
  });

  it("checks the fields before asking the API: empty current, short new, mismatch", async () => {
    const calls = stubApi(quiet);
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      has_password: true,
    });

    fill("", "short", "different");
    submit(field("current_password").form!);
    await flush();

    expect(calls.find((c) => c.method === "POST")).toBeUndefined();
    expect(mounted.container.textContent).toContain(
      "Enter your current password.",
    );
    expect(mounted.container.textContent).toContain(
      "Use 12 characters or more",
    );
    expect(mounted.container.textContent).toContain(
      "The passwords do not match.",
    );
    expect(field("current_password").getAttribute("aria-invalid")).toBe("true");
    expect(field("next_password").getAttribute("aria-invalid")).toBe("true");
    expect(field("confirm_password").getAttribute("aria-invalid")).toBe("true");
  });

  it("posts the current and new password, clears the form and says the other devices are out", async () => {
    const calls = stubApi((call) => {
      if (call.method === "POST" && call.url === "/api/me/password") {
        return { status: 200, body: { status: "changed", revoked: 2 } };
      }
      return quiet(call);
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      has_password: true,
    });

    fill("old password here", "a new longer password", "a new longer password");
    submit(field("current_password").form!);
    await flush();

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/me/password");
    expect(post?.body).toEqual({
      current_password: "old password here",
      new_password: "a new longer password",
    });
    expect(field("current_password").value).toBe("");
    expect(field("next_password").value).toBe("");
    expect(field("confirm_password").value).toBe("");
    expect(document.body.textContent).toContain("Password changed.");
    expect(document.body.textContent).toContain(
      "Other devices were signed out.",
    );
    expect(mounted.container.querySelector("[role='alert']")).toBeNull();
  });

  it("puts the API's wrong-current refusal under the current field, by its code", async () => {
    stubApi((call) => {
      if (call.method === "POST" && call.url === "/api/me/password") {
        return {
          status: 400,
          body: {
            detail: "The current password is not right.",
            code: "wrong_current_password",
          },
        };
      }
      return quiet(call);
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      has_password: true,
    });

    fill("not it", "a new longer password", "a new longer password");
    submit(field("current_password").form!);
    await flush();

    expect(field("current_password").getAttribute("aria-invalid")).toBe("true");
    expect(mounted.container.textContent).toContain(
      "The current password is not right.",
    );
    expect(field("next_password").getAttribute("aria-invalid")).toBeNull();
    expect(document.body.textContent).not.toContain("Password changed.");
  });

  it("shows a refusal without a code as the form's error", async () => {
    stubApi((call) => {
      if (call.method === "POST" && call.url === "/api/me/password") {
        return {
          status: 503,
          body: { detail: "The identity provider is unavailable right now." },
        };
      }
      return quiet(call);
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      has_password: true,
    });

    fill("old password here", "a new longer password", "a new longer password");
    submit(field("current_password").form!);
    await flush();

    expect(mounted.container.querySelector("[role='alert']")?.textContent).toBe(
      "The identity provider is unavailable right now.",
    );
    expect(field("current_password").value).toBe("old password here");
  });
});

describe("the email card", () => {
  const quiet = ({ method, url }: { method: string; url: string }) => {
    if (method === "GET" && url === "/api/me/mfa")
      return mfaAnswer(NOT_ENROLLED);
    if (method === "GET" && url === "/api/me/sessions")
      return { status: 200, body: { sessions: [] } };
    return undefined;
  };

  function field(name: string): HTMLInputElement {
    const input = mounted!.container.querySelector<HTMLInputElement>(
      `input[name='${name}']`,
    );
    if (!input) throw new Error(`no ${name} input`);
    return input;
  }

  async function startWith(email: string, password: string) {
    setInputValue(field("new_email"), email);
    setInputValue(field("email_current_password"), password);
    submit(field("new_email").form!);
    await flush();
  }

  it("is hidden for an account with no password: its address belongs to the SSO", async () => {
    stubApi(quiet);
    mounted = await mount(<AccountPane />, principalWith([]));
    expect(
      mounted.container.querySelector("input[name='new_email']"),
    ).toBeNull();
  });

  it("sends the code, then confirms it and says the address moved", async () => {
    const calls = stubApi((call) => {
      if (call.method === "POST" && call.url === "/api/me/email") {
        return {
          status: 200,
          body: {
            status: "code_sent",
            new_email: "ada@new.example",
            mail_sent: true,
          },
        };
      }
      if (call.method === "POST" && call.url === "/api/me/email/verify") {
        return {
          status: 200,
          body: {
            status: "changed",
            email: "ada@new.example",
            revoked: 1,
            notice_sent: true,
          },
        };
      }
      return quiet(call);
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      has_password: true,
    });

    await startWith(" Ada@New.example ", "my current password");

    const start = calls.find(
      (c) => c.method === "POST" && c.url === "/api/me/email",
    );
    expect(start?.body).toEqual({
      new_email: "ada@new.example",
      current_password: "my current password",
    });
    expect(mounted.container.textContent).toContain(
      "We sent a code to ada@new.example",
    );
    expect(
      mounted.container.querySelector("input[name='new_email']"),
    ).toBeNull();

    setInputValue(field("email_code"), " 246810 ");
    submit(field("email_code").form!);
    await flush();

    const verify = calls.find(
      (c) => c.method === "POST" && c.url === "/api/me/email/verify",
    );
    expect(verify?.body).toEqual({ code: "246810" });
    expect(mounted.container.textContent).toContain(
      "Your sign-in address is now ada@new.example. Other devices were signed out.",
    );
    expect(field("new_email").value).toBe("");
  });

  it("checks the fields before asking the API", async () => {
    const calls = stubApi(quiet);
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      has_password: true,
    });

    await startWith("not an address", "");

    expect(
      calls.some((c) => c.method === "POST" && c.url === "/api/me/email"),
    ).toBe(false);
    expect(field("new_email").getAttribute("aria-invalid")).toBe("true");
    expect(field("email_current_password").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  it("puts a wrong password and a taken address on their fields", async () => {
    let answer = {
      detail: "The current password is not right.",
      code: "wrong_current_password",
    };
    stubApi((call) => {
      if (call.method === "POST" && call.url === "/api/me/email") {
        return {
          status: answer.code === "email_taken" ? 409 : 400,
          body: answer,
        };
      }
      return quiet(call);
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      has_password: true,
    });

    await startWith("ada@new.example", "not it");
    expect(field("email_current_password").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(mounted.container.textContent).toContain(
      "The current password is not right.",
    );

    answer = {
      detail: "An account already exists for this address.",
      code: "email_taken",
    };
    await startWith("ada@new.example", "my current password");
    expect(field("new_email").getAttribute("aria-invalid")).toBe("true");
    expect(mounted.container.textContent).toContain(
      "An account already exists for this address.",
    );
    expect(
      mounted.container.querySelector("input[name='email_code']"),
    ).toBeNull();
  });

  it("gives each password field on the page its own label", async () => {
    stubApi(quiet);
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      has_password: true,
    });
    const labels = [...mounted.container.querySelectorAll("label")]
      .filter((label) => label.querySelector("input[type='password']"))
      .map((label) => label.querySelector("span")?.textContent);
    expect(labels.length).toBeGreaterThan(3);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("comes back to the code step after a reload when a change is pending", async () => {
    stubApi((call) => {
      if (call.method === "GET" && call.url === "/api/me/email") {
        return {
          status: 200,
          body: { email: "dev@localhost", pending_email: "ada@new.example" },
        };
      }
      return quiet(call);
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      has_password: true,
    });

    expect(mounted.container.textContent).toContain(
      "We sent a code to ada@new.example",
    );
    expect(mounted.container.querySelector("input[name='email_code']")).not.toBeNull();
  });

  it("cancels a pending change through the API and goes back to the address step", async () => {
    const calls = stubApi((call) => {
      if (call.method === "GET" && call.url === "/api/me/email") {
        return {
          status: 200,
          body: { email: "dev@localhost", pending_email: "ada@new.example" },
        };
      }
      if (call.method === "POST" && call.url === "/api/me/email/cancel") {
        return { status: 200, body: { status: "cancelled", email: "dev@localhost" } };
      }
      return quiet(call);
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      has_password: true,
    });

    click(buttonNamed(mounted.container, "Cancel change"));
    await flush();

    expect(calls.some((c) => c.method === "POST" && c.url === "/api/me/email/cancel")).toBe(true);
    expect(field("new_email").value).toBe("");
    expect(mounted.container.textContent).toContain(
      "Change cancelled. You still sign in as dev@localhost.",
    );
  });

  it("resends the code and says where it went", async () => {
    const calls = stubApi((call) => {
      if (call.method === "GET" && call.url === "/api/me/email") {
        return {
          status: 200,
          body: { email: "dev@localhost", pending_email: "ada@new.example" },
        };
      }
      if (call.method === "POST" && call.url === "/api/me/email/resend") {
        return {
          status: 200,
          body: { status: "code_sent", new_email: "ada@new.example", mail_sent: true },
        };
      }
      return quiet(call);
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      has_password: true,
    });

    click(buttonNamed(mounted.container, "Resend code"));
    await flush();

    expect(calls.some((c) => c.method === "POST" && c.url === "/api/me/email/resend")).toBe(true);
    const live = mounted.container.querySelector("[aria-live='polite']");
    expect(mounted.container.textContent).toContain("A new code is on its way to ada@new.example.");
    expect(live).not.toBeNull();
    expect(field("email_code")).toBeTruthy();
  });

  it("keeps the code step open on a wrong code and can start over", async () => {
    stubApi((call) => {
      if (call.method === "POST" && call.url === "/api/me/email") {
        return {
          status: 200,
          body: { status: "code_sent", new_email: "ada@new.example" },
        };
      }
      if (call.method === "POST" && call.url === "/api/me/email/verify") {
        return {
          status: 400,
          body: {
            detail: "That code is not right or has expired.",
            code: "invalid_code",
          },
        };
      }
      if (call.method === "POST" && call.url === "/api/me/email/cancel") {
        return { status: 200, body: { status: "cancelled", email: "dev@localhost" } };
      }
      return quiet(call);
    });
    mounted = await mount(<AccountPane />, {
      ...principalWith([]),
      has_password: true,
    });
    await startWith("ada@new.example", "my current password");

    setInputValue(field("email_code"), "000000");
    submit(field("email_code").form!);
    await flush();

    expect(field("email_code").getAttribute("aria-invalid")).toBe("true");
    expect(mounted.container.textContent).toContain(
      "That code is not right or has expired.",
    );
    click(buttonNamed(mounted.container, "Cancel change"));
    await flush();
    expect(field("new_email").value).toBe("");
  });
});


describe("passkeys", () => {
  const LAPTOP = { id: "pk-1", name: "Work laptop", created_at: "2026-10-01T09:00:00Z" };

  function section(): HTMLElement {
    const card = mounted!.container.querySelector<HTMLElement>("[data-mw-passkeys]");
    if (!card) throw new Error("no passkeys card");
    return card;
  }

  /** The card's stub: a mutable list the writes advance, like the API would. */
  function stubPasskeys(initial: typeof LAPTOP[], options: { verifyStatus?: number } = {}) {
    let rows = [...initial];
    const calls = stubApi(({ method, url, body }) => {
      if (method === "GET" && url === "/api/me/sessions")
        return { status: 200, body: { sessions: [] } };
      if (method === "GET" && url === "/api/me/mfa")
        return { status: 200, body: NOT_ENROLLED };
      if (method === "GET" && url === "/api/me/passkeys")
        return { status: 200, body: { passkeys: rows, rp_id: "app.example", max: 10 } };
      if (method === "POST" && url === "/api/me/passkeys/start")
        return {
          status: 200,
          body: { passkey_id: "pk-new", options: { publicKey: { challenge: "AQ" } } },
        };
      if (method === "POST" && url === "/api/me/passkeys/pk-new/verify") {
        if (options.verifyStatus)
          return { status: options.verifyStatus, body: { detail: "The passkey could not be registered." } };
        const made = { id: "pk-new", name: (body as { name: string }).name, created_at: "2026-10-03T10:00:00Z" };
        rows = [...rows, made];
        return { status: 201, body: made };
      }
      if (method === "PATCH" && url === "/api/me/passkeys/pk-1") {
        rows = rows.map((r) => (r.id === "pk-1" ? { ...r, name: (body as { name: string }).name } : r));
        return { status: 200, body: rows[0] };
      }
      if (method === "DELETE" && url === "/api/me/passkeys/pk-1") {
        rows = rows.filter((r) => r.id !== "pk-1");
        return { status: 204, body: undefined };
      }
      return undefined;
    });
    return calls;
  }

  it("is absent unless the API offers passkeys", async () => {
    stubPasskeys([]);
    mounted = await mount(<AccountPane />, principalWith([]));
    expect(mounted.container.querySelector("[data-mw-passkeys]")).toBeNull();
  });

  it("says there are none and offers to add one", async () => {
    stubPasskeys([]);
    mounted = await mount(<AccountPane />, principalWith([]), { passkey_login: true });
    expect(section().textContent).toContain("No passkeys.");
    expect(buttonNamed(section(), "Add a passkey")).toBeDefined();
  });

  it("adds one: the name, the API's options to the browser, the attestation back with the name", async () => {
    const calls = stubPasskeys([]);
    mounted = await mount(<AccountPane />, principalWith([]), { passkey_login: true });
    click(buttonNamed(section(), "Add a passkey"));
    await flush();
    const name = section().querySelector<HTMLInputElement>("input[name='name']")!;
    expect(name.value).not.toBe(""); // suggested from the browser
    setInputValue(name, "Yubikey");
    submit(name.closest("form")!);
    await flush();
    await flush();

    expect(createPasskey).toHaveBeenCalledWith({ publicKey: { challenge: "AQ" } });
    const verify = calls.find((c) => c.url === "/api/me/passkeys/pk-new/verify")!;
    expect(verify.method).toBe("POST");
    expect(verify.body).toEqual({
      credential: { id: "cred-1", rawId: "cred-1", type: "public-key" },
      name: "Yubikey",
    });
    expect(section().textContent).toContain("1 passkey.");
    expect(section().textContent).toContain("Yubikey");
    expect(section().textContent).toContain("added");
  });

  it("shows the API's refusal of the attestation and adds nothing", async () => {
    stubPasskeys([], { verifyStatus: 400 });
    mounted = await mount(<AccountPane />, principalWith([]), { passkey_login: true });
    click(buttonNamed(section(), "Add a passkey"));
    await flush();
    submit(section().querySelector("form")!);
    await flush();
    await flush();
    expect(section().querySelector("[role='alert']")?.textContent).toContain("could not be registered");
    expect(section().textContent).toContain("No passkeys.");
  });

  it("lists, renames and removes through the API", async () => {
    const calls = stubPasskeys([LAPTOP]);
    mounted = await mount(<AccountPane />, principalWith([]), { passkey_login: true });
    expect(section().textContent).toContain("1 passkey.");
    expect(section().textContent).toContain("Work laptop");

    click(buttonLabelled(section(), "Rename Work laptop"));
    await flush();
    const name = section().querySelector<HTMLInputElement>("input[name='name']")!;
    setInputValue(name, "Desk");
    submit(name.closest("form")!);
    await flush();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ name: "Desk" });
    expect(section().textContent).toContain("Desk");

    click(buttonLabelled(section(), "Remove Desk"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/me/passkeys/pk-1")).toBe(true);
    expect(section().textContent).toContain("No passkeys.");
    expect(section().textContent).toContain("removed");
  });

  it("says why on a browser that cannot make passkeys", async () => {
    vi.mocked(passkeysSupported).mockReturnValueOnce(false).mockReturnValueOnce(false);
    stubPasskeys([]);
    mounted = await mount(<AccountPane />, principalWith([]), { passkey_login: true });
    expect(buttonNamed(section(), "Add a passkey").disabled).toBe(true);
    expect(section().textContent).toContain("cannot make passkeys here");
  });
});
