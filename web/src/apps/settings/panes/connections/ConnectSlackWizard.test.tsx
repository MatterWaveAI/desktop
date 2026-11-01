import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectSlackWizard } from "./ConnectSlackWizard";
import { CONNECTION, PENDING } from "./fixtures";
import {
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  setInputValue,
  stubApi,
  submit,
  type Mounted,
  type RecordedCall,
} from "../paneHarness";

/**
 * The Connect Slack wizard against a mocked API: the name creates the
 * pending connection and fetches the manifest carrying its Request URL;
 * the manifest step links to Slack's create-from-manifest page and warns
 * when the ingress host is not public; the credentials step sends the
 * token and secret and shows Slack's refusal in plain words; the last
 * step names the workspace and hands it on to routing.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MANIFEST = {
  display_information: { name: "MatterWave" },
  settings: { event_subscriptions: { request_url: PENDING.ingress_url } },
};
const CREATE_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(MANIFEST))}`;

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-connect-slack-dialog]");
  if (!el) throw new Error("the wizard is not open");
  return el;
}

function step(): string | null {
  return dialog().querySelector("[data-wizard-step]")?.getAttribute("data-wizard-step") ?? null;
}

function stubWizard(options: {
  ingressPublic: boolean;
  activate: (body: unknown) => { status: number; body: unknown };
}): RecordedCall[] {
  return stubApi(({ method, url, body }) => {
    if (method === "POST" && url === "/api/org/connections") return { status: 201, body: PENDING };
    if (method === "GET" && url === `/api/org/connections/slack/manifest?connection_id=${PENDING.id}`) {
      return {
        status: 200,
        body: {
          connection_id: PENDING.id,
          status: "pending",
          request_url: PENDING.ingress_url,
          publicly_reachable: options.ingressPublic,
          manifest: MANIFEST,
          create_url: CREATE_URL,
        },
      };
    }
    if (method === "PATCH" && url === `/api/org/connections/${PENDING.id}`) return options.activate(body);
    return undefined;
  });
}

type Reply = { status: number; body: unknown };

async function openAtManifest(ingressPublic: boolean, activate: () => Reply = () => ({ status: 200, body: CONNECTION })) {
  const calls = stubWizard({ ingressPublic, activate });
  const onConnected = vi.fn();
  mounted = await mount(
    <ConnectSlackWizard open onOpenChange={() => undefined} onConnected={onConnected} />,
    principalWith(["user"], "admin"),
  );
  expect(step()).toBe("name");
  expect(buttonNamed(dialog(), "Continue").disabled).toBe(true);
  setInputValue(dialog().querySelector("input[name='display_name']")!, " Beta Slack ");
  submit(dialog().querySelector("form")!);
  await flush();
  return { calls, onConnected };
}

describe("the Connect Slack wizard", () => {
  it("creates the pending connection from the name and shows the manifest with its Request URL", async () => {
    const { calls } = await openAtManifest(true);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/api/org/connections",
      body: { connector: "slack", display_name: "Beta Slack" },
    });
    expect(calls[1].url).toBe(`/api/org/connections/slack/manifest?connection_id=${PENDING.id}`);
    expect(step()).toBe("manifest");
    expect(dialog().textContent).toContain("Step 1 of 3");
    expect(dialog().querySelector("[data-testid='slack-manifest']")!.textContent).toContain(PENDING.ingress_url);
    const link = dialog().querySelector<HTMLAnchorElement>("[data-wizard-create-app]")!;
    expect(link.textContent).toBe("Create the app in Slack");
    expect(link.target).toBe("_blank");
    expect(link.href).toBe(CREATE_URL);
    expect(dialog().querySelector("[data-wizard-ingress-private]")).toBeNull();
  });

  it("says first when Slack cannot reach the ingress host", async () => {
    await openAtManifest(false);
    const warning = dialog().querySelector("[data-wizard-ingress-private]")!;
    expect(warning.textContent).toContain("Slack cannot reach this deployment");
    expect(warning.textContent).toContain(PENDING.ingress_url);
    // Said before the manifest, not after it.
    expect(warning.compareDocumentPosition(dialog().querySelector("[data-testid='slack-manifest']")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the API's refusal of a bad name where it was typed", async () => {
    stubApi(({ method, url }) =>
      method === "POST" && url === "/api/org/connections"
        ? { status: 422, body: { detail: [{ loc: ["body", "display_name"], msg: "required", type: "value_error" }] } }
        : undefined,
    );
    mounted = await mount(
      <ConnectSlackWizard open onOpenChange={() => undefined} onConnected={() => undefined} />,
      principalWith(["user"], "admin"),
    );
    setInputValue(dialog().querySelector("input[name='display_name']")!, "x");
    submit(dialog().querySelector("form")!);
    await flush();
    expect(step()).toBe("name");
    expect(dialog().querySelector("[role='alert']")!.textContent).toBe("required");
  });

  it("checks the pasted token and secret with Slack, showing a refusal in plain words, then connects", async () => {
    let attempt = 0;
    const { calls, onConnected } = await openAtManifest(true, () => {
      attempt += 1;
      return attempt === 1
        ? {
            status: 422,
            body: { detail: [{ loc: ["body", "credentials"], msg: "Slack does not recognise this token.", type: "value_error" }] },
          }
        : { status: 200, body: { ...CONNECTION, id: PENDING.id, display_name: "Beta Slack", external_workspace_id: "T0BETA" } };
    });
    click(buttonNamed(dialog(), "The app is installed"));
    await flush();
    expect(step()).toBe("credentials");
    expect(dialog().textContent).toContain("Step 2 of 3");
    const connect = buttonNamed(dialog(), "Connect");
    expect(connect.disabled).toBe(true);
    setInputValue(dialog().querySelector("input[name='bot_token']")!, "xoxb-123");
    setInputValue(dialog().querySelector("input[name='signing_secret']")!, "abc");
    expect(connect.disabled).toBe(false);
    submit(dialog().querySelector("form")!);
    await flush();
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe(`/api/org/connections/${PENDING.id}`);
    expect(patch.body).toEqual({ credentials: { bot_token: "xoxb-123", signing_secret: "abc" } });
    expect(step()).toBe("credentials");
    expect(dialog().querySelector("[role='alert']")!.textContent).toBe("Slack does not recognise this token.");

    submit(dialog().querySelector("form")!);
    await flush();
    expect(step()).toBe("done");
    expect(dialog().textContent).toContain("Step 3 of 3");
    expect(dialog().textContent).toContain("Beta Slack is connected");
    expect(dialog().textContent).toContain("T0BETA");
    click(buttonNamed(dialog(), "Continue to routing"));
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ id: PENDING.id, external_workspace_id: "T0BETA" }));
  });

  it("explains a provider that could not be asked", async () => {
    await openAtManifest(true, () => ({
      status: 502,
      body: { detail: "The provider could not be reached to check the credentials." },
    }));
    click(buttonNamed(dialog(), "The app is installed"));
    await flush();
    setInputValue(dialog().querySelector("input[name='bot_token']")!, "xoxb-123");
    setInputValue(dialog().querySelector("input[name='signing_secret']")!, "abc");
    submit(dialog().querySelector("form")!);
    await flush();
    expect(dialog().querySelector("[role='alert']")!.textContent).toBe(
      "The provider could not be reached to check the credentials.",
    );
  });
});
