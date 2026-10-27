import { afterEach, describe, expect, it } from "vitest";
import { UnsubscribePage } from "./UnsubscribePage";
import { tokenCategory } from "./unsubscribeToken";
import { UNSUBSCRIBE_PATH, isAnonymousPath } from "./frontDoor";
import { ShellContext, type ShellContextValue } from "./shellContext";
import {
  alertText,
  buttonNamed,
  cleanup,
  click,
  jsonResponse,
  linkTo,
  mount,
  stubApi,
  view,
} from "./frontDoorHarness";

/**
 * The unsubscribe page: anonymous, opening it sends nothing, the button
 * sends the RFC 8058 form POST with the token and no cookie, and a refused
 * token says so. The page names which mail the button stops by reading the
 * token's payload, and a link that is not even shaped like ours is refused
 * without a request.
 */

// base64url("usage_alerts:user-1") and a signature the page never checks.
const TOKEN = "dXNhZ2VfYWxlcnRzOnVzZXItMQ.c2ln";
const PRODUCT_TOKEN = `${btoa("product_updates:user-1").replace(/=+$/, "")}.c2ln`;
const POST_URL = `/api/unsubscribe?t=${TOKEN}`;

function mountPage(search = `?t=${TOKEN}`): Promise<void> {
  return mount(`${UNSUBSCRIBE_PATH}${search}`, { [UNSUBSCRIBE_PATH]: UnsubscribePage });
}

afterEach(cleanup);

describe("tokenCategory", () => {
  it("reads the category from a token shaped like ours, and nothing from anything else", () => {
    expect(tokenCategory(TOKEN)).toBe("usage_alerts");
    expect(tokenCategory(PRODUCT_TOKEN)).toBe("product_updates");
    expect(tokenCategory("cGF5bG9hZA.c2ln")).toBeNull(); // "payload": no category
    expect(tokenCategory("not-a-token")).toBeNull();
    expect(tokenCategory("a.b.c")).toBeNull();
    expect(tokenCategory(`${btoa("billing_receipts:u").replace(/=+$/, "")}.c2ln`)).toBeNull();
    expect(tokenCategory("")).toBeNull();
  });
});

describe("UnsubscribePage", () => {
  it("is a front-door path", () => {
    expect(isAnonymousPath(UNSUBSCRIBE_PATH)).toBe(true);
  });

  it("names the mail the button stops, sends nothing until it is pressed, then the one-click POST", async () => {
    const fetchMock = stubApi({
      [POST_URL]: jsonResponse({ category: "usage_alerts", unsubscribed: true }),
    });
    await mountPage();
    expect(view().querySelector("h1")?.textContent).toBe("Unsubscribe from usage alerts?");
    expect(view().textContent).toContain("nears its budget or plan allowance");
    expect(view().textContent).toContain("Receipts and security mail still reach you");
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/unsubscribe"))).toBe(
      false,
    );

    await click(buttonNamed("Unsubscribe")!);

    const call = fetchMock.mock.calls.find(([url]) => String(url) === POST_URL);
    expect(call).toBeDefined();
    const init = call![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe("List-Unsubscribe=One-Click");
    expect(init.credentials).toBe("omit");
    expect(view().textContent).toContain("You will no longer get usage alerts by email.");
  });

  it("names product updates for that token", async () => {
    stubApi({});
    await mountPage(`?t=${PRODUCT_TOKEN}`);
    expect(view().querySelector("h1")?.textContent).toBe("Unsubscribe from product updates?");
    expect(view().textContent).toContain("new models and features");
  });

  it("tells a signed-out reader where the switches live, and links them when signed in", async () => {
    stubApi({});
    await mountPage();
    expect(view().textContent).toContain("Settings, Preferences");
    expect(linkTo("/settings/preferences")).toBeNull();
    cleanup();

    stubApi({});
    const shell = { principal: { subject: "u", email: "u@example.com" } } as unknown as ShellContextValue;
    const Page = () => (
      <ShellContext.Provider value={shell}>
        <UnsubscribePage />
      </ShellContext.Provider>
    );
    await mount(`${UNSUBSCRIBE_PATH}?t=${TOKEN}`, { [UNSUBSCRIBE_PATH]: Page });
    expect(linkTo("/settings/preferences")?.textContent).toBe("Open notification preferences");
  });

  it("when the API refuses the token, says so and takes the button away", async () => {
    stubApi({ [POST_URL]: jsonResponse({ detail: "This unsubscribe link is not valid." }, 400) });
    await mountPage();
    await click(buttonNamed("Unsubscribe")!);
    expect(view().querySelector("h1")?.textContent).toBe("This link cannot be used");
    expect(alertText()).toContain("not valid");
    expect(view().textContent).toContain("Nothing has changed");
    expect(buttonNamed("Unsubscribe")).toBeUndefined();
    // Announced, not focused: the alert is the page.
    expect(document.activeElement).not.toBe(view().querySelector("[role='alert']"));
  });

  it("keeps the button for a refusal that may pass later", async () => {
    stubApi({ [POST_URL]: jsonResponse({ detail: "Too many." }, 429) });
    await mountPage();
    await click(buttonNamed("Unsubscribe")!);
    expect(alertText()).toContain("Too many attempts");
    expect(buttonNamed("Unsubscribe")).toBeDefined();
  });

  it("refuses a link that is not shaped like ours without asking the API", async () => {
    const fetchMock = stubApi({});
    await mountPage("?t=cGF5bG9hZA.c2ln");
    expect(view().querySelector("h1")?.textContent).toBe("This link cannot be used");
    expect(alertText()).toContain("not valid");
    expect(buttonNamed("Unsubscribe")).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/unsubscribe"))).toBe(false);
  });

  it("refuses a link with no token without offering the button", async () => {
    stubApi({});
    await mountPage("");
    expect(alertText()).toContain("not valid");
    expect(buttonNamed("Unsubscribe")).toBeUndefined();
  });
});
