import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../types";
import { LandingPage } from "./LandingPage";
import {
  DEVELOPERS_PATH,
  LOGIN_PATH,
  PRICING_PATH,
  POLICY_PATH,
  PRIVACY_PATH,
  SIGNUP_PATH,
  TERMS_PATH,
} from "./frontDoor";
import { PRODUCT_DESCRIPTION, PRODUCT_LINE } from "./productCopy";
import { jsonResponse } from "./frontDoorHarness";

/**
 * The front page a stranger reads: the headline and one line on what
 * MatterWave is, the things the app actually does, the model family as the
 * API prices it, and every way in -- Pricing, Docs, Sign in, Create account,
 * Start free -- with Terms,
 * Privacy, Contact and (when the deployment has one) Status in the footer.
 * Plain anchors throughout, so no router is mounted here.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const config: AuthConfig = {
  auth_mode: "oidc",
  csrf_cookie: "mw_csrf",
  default_model: "grt-nano",
  login_url: "/api/auth/login",
  password_login: true,
};

const PLANS = {
  data: [],
  models: [
    { id: "grt-nano", label: "GRT Nano", multiplier: 1, input_usd_per_m: 0.1, output_usd_per_m: 0.4, partner: false },
    { id: "grt-nano-pro", label: "GRT Nano Pro", multiplier: 5, input_usd_per_m: 0.5, output_usd_per_m: 2, partner: false },
    { id: "grt-nano-max", label: "GRT Nano Max", multiplier: 20, input_usd_per_m: 2, output_usd_per_m: 8, partner: false },
    { id: "glm-4.6", label: "glm-4.6", multiplier: 1, input_usd_per_m: 0.6, output_usd_per_m: 2.2, partner: true },
  ],
  default_model: "grt-nano",
};

let root: Root | null = null;
let container: HTMLElement | null = null;

function stubPlans(answer: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/plans" ? answer : jsonResponse({ detail: "no mock" }, 404),
    ),
  );
}

async function render(props: { config: AuthConfig }): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<LandingPage {...props} />);
  });
  return container;
}

function links(scope: ParentNode): string[] {
  return [...scope.querySelectorAll("a")].map((a) => `${a.textContent?.trim()}|${a.getAttribute("href")}`);
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the landing page", () => {
  it("leads with the headline and what MatterWave is, and offers every way in, from the header and from the hero", async () => {
    stubPlans(jsonResponse(PLANS));
    const page = await render({ config });
    const h1 = page.querySelector("h1")!;
    expect(h1.textContent).toBe("Models that move with you.");
    // One italic word in the display headline, as the brand sets it.
    expect(h1.querySelector("em")?.textContent).toBe("move");
    const hero = page.querySelector("[data-landing-hero]")!;
    expect(hero.textContent).toContain(PRODUCT_DESCRIPTION.message);
    expect(hero.textContent).toContain("Free plan, no card. Nothing you write trains a model.");
    // The slogan still says what this is, under the features' title.
    expect(page.querySelector("#landing-features")!.parentElement!.textContent).toContain(PRODUCT_LINE.message);

    const header = page.querySelector("nav[aria-label='MatterWave']")!;
    // The header carries the brand and the ways into the app; Pricing and
    // Docs are reached from the page body and the hero, not the header.
    expect(links(header)).toEqual([
      "MatterWave ai|/",
      `Sign in|${LOGIN_PATH}`,
      `Create account|${SIGNUP_PATH}`,
    ]);
    expect(links(hero)).toEqual([`Start free|${SIGNUP_PATH}`, `Read the docs|${DEVELOPERS_PATH}`]);
    const main = page.querySelector("main")!;
    expect(links(main)).toEqual(
      expect.arrayContaining([`Create your account|${SIGNUP_PATH}`, `the Plans page|${PRICING_PATH}`]),
    );
    // The preview is one named image, not a transcript a screen reader would read as real.
    const preview = page.querySelector("[role='img']")!;
    expect(preview.getAttribute("aria-label")).toMatch(/illustration/i);
    // Phone first: nothing fixed-width, one scrolling column.
    expect(page.firstElementChild?.className).toContain("overflow-y-auto");
  });

  it("names six things the app does, each of which exists, under alternating overlines", async () => {
    stubPlans(jsonResponse(PLANS));
    const page = await render({ config });
    const cards = () => [...page.querySelector("#landing-features")!.closest("section")!.querySelectorAll("li")];
    await vi.waitFor(() => expect(cards()[0].textContent).toContain("GRT Nano Max"));
    expect(cards().map((li) => li.querySelector("h3")?.textContent)).toEqual([
      "Conversations that keep up",
      "API, SDKs and MCP",
      "Seats, roles and budgets",
      "Web, terminal, VS Code, desktop",
      "Passkeys and sign-on",
      "Import and export",
    ]);
    const overlines = cards().map((li) => li.querySelector("p"));
    expect(overlines.map((p) => p?.textContent)).toEqual(["CHAT", "BUILD", "TEAMS", "EVERYWHERE", "SECURE", "YOURS"]);
    expect(overlines[0]?.className).toContain("text-mw-link");
    expect(overlines[1]?.className).toContain("text-mw-positive");
    expect(page.textContent).not.toMatch(/coming soon|roadmap/i);
    const bodies = cards().map((li) => li.querySelectorAll("p")[1]?.textContent ?? "");
    // The tiers are the catalog's labels, not a list written here.
    expect(bodies[0]).toContain("on GRT Nano, GRT Nano Pro and GRT Nano Max");
    // A limit is not a feature, and single sign-on is the Team plan's, not everyone's.
    expect(page.textContent).not.toContain("One organisation per account");
    expect(bodies[2]).toMatch(/Team plan .* single sign-on/);
    expect(bodies[2]).not.toContain("attach single sign-on");
  });

  it("derives the family's name from the catalog and quotes the cheapest paid plan", async () => {
    const data = [
      { code: "free", price_cents_monthly: 0 },
      { code: "team", price_cents_monthly: 3000 },
      { code: "pro", price_cents_monthly: 2000 },
    ];
    stubPlans(jsonResponse({ ...PLANS, data }));
    const page = await render({ config });
    await vi.waitFor(() => expect(page.querySelector("#landing-models")?.textContent).toBe("The GRT Nano family"));
    expect(page.querySelector("#landing-models em")?.textContent).toBe("family");
    const section = page.querySelector("#landing-models")!.parentElement!;
    expect(section.textContent).toContain("Paid plans add the dearer models");
    // The prose link is finger-sized like the rest of the front door.
    const plans = section.querySelector(`a[href='${PRICING_PATH}']`)!;
    expect(plans.className).toContain("min-h-6");
    expect(page.querySelector("#landing-start")!.parentElement!.textContent).toContain("Paid plans from $20 a month.");
  });

  it("says 'the models' while the catalog is loading, and names the family once it is in", async () => {
    let answer: (value: Record<string, unknown>) => void = () => undefined;
    stubPlans(new Promise<Record<string, unknown>>((resolve) => (answer = resolve)) as unknown as Record<string, unknown>);
    const page = await render({ config });
    expect(page.querySelector("#landing-models")?.textContent).toBe("The models");
    expect(page.textContent).toContain("Chat with hosted language models");
    expect(page.textContent).not.toContain("GRT Nano");
    await act(async () => answer(jsonResponse(PLANS)));
    await vi.waitFor(() => expect(page.querySelector("#landing-models")?.textContent).toBe("The GRT Nano family"));
  });

  it("lists the GRT models from the price list with their weights, and leaves partner models out", async () => {
    stubPlans(jsonResponse(PLANS));
    const page = await render({ config });
    await vi.waitFor(() => expect(page.querySelector("table[aria-label='Models']")).not.toBeNull());
    const rows = [...page.querySelectorAll("table[aria-label='Models'] tbody tr")];
    expect(rows.map((tr) => tr.getAttribute("data-model"))).toEqual(["grt-nano", "grt-nano-pro", "grt-nano-max"]);
    // The family upright, the tier word in italic.
    expect(rows[1].querySelector("th")?.textContent).toBe("GRT Nano Pro");
    expect(rows[1].querySelector("th em")?.textContent).toBe("Pro");
    expect(rows[0].querySelector("th em")).toBeNull();
    expect([...rows[2].querySelectorAll("td")].map((td) => td.textContent)).toEqual(["$2.00", "$8.00", "20×"]);
    expect(page.textContent).not.toContain("glm-4.6");
    // No paid plan in the catalogue, no "from" line.
    expect(page.textContent).not.toContain("Paid plans from");
  });

  it("still reads, without the model table, when the catalog cannot be fetched", async () => {
    stubPlans(jsonResponse({ detail: "down" }, 503));
    const page = await render({ config });
    await act(async () => {});
    expect(page.querySelector("table[aria-label='Models']")).toBeNull();
    // No catalog, no family name to claim: the neutral copy stays.
    expect(page.querySelector("#landing-models")?.textContent).toBe("The models");
    expect(page.textContent).not.toContain("GRT Nano");
    expect(page.textContent).toContain("Paid plans add the dearer models");
    expect(page.querySelector(`a[href='${PRICING_PATH}']`)).not.toBeNull();
  });

  it("puts Terms, Privacy, Acceptable use and Contact in the footer, and Status only when the deployment has one", async () => {
    stubPlans(jsonResponse(PLANS));
    let page = await render({ config });
    let footer = page.querySelector("nav[aria-label='About MatterWave']")!;
    expect(links(footer)).toEqual([
      `Terms|${TERMS_PATH}`,
      `Privacy|${PRIVACY_PATH}`,
      `Acceptable use|${POLICY_PATH}`,
      "Contact|mailto:support@matterwave.dev",
    ]);
    act(() => root?.unmount());
    container?.remove();

    page = await render({
      config: { ...config, support_url: "https://help.example.test", status_url: "https://status.example.test" },
    });
    footer = page.querySelector("nav[aria-label='About MatterWave']")!;
    expect(links(footer)).toEqual([
      `Terms|${TERMS_PATH}`,
      `Privacy|${PRIVACY_PATH}`,
      `Acceptable use|${POLICY_PATH}`,
      "Contact|https://help.example.test",
      "Status|https://status.example.test",
    ]);
    const status = footer.querySelector("a[href='https://status.example.test']")!;
    expect(status.getAttribute("target")).toBe("_blank");
    expect(status.getAttribute("rel")).toContain("noopener");
  });

  it("makes Sign in a button that starts the API's login when there is no password form", async () => {
    stubPlans(jsonResponse(PLANS));
    const page = await render({ config: { ...config, password_login: false } });
    const buttons = [...page.querySelectorAll("button")].filter((b) => b.textContent === "Sign in");
    expect(buttons.length).toBeGreaterThan(0);
    expect(page.querySelector(`a[href='${LOGIN_PATH}']`)).toBeNull();
  });
});
