import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportDialog } from "./ReportDialog";
import { REPORT_REASONS, reportFailureMessage } from "./report";
import { ApiError } from "../../lib/api";
import {
  buttonNamed,
  click,
  flush,
  mount,
  principalWith,
  stubApi,
  type Mounted,
} from "../settings/panes/paneHarness";

/**
 * The report dialog as a person meets it: the API's two reasons, a note,
 * and an answer that says whether the report was stored. The dialog
 * renders through a portal, so everything is found on `document`.
 */

const CONVERSATION_ID = "11111111-1111-7111-8111-111111111111";

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function dialog(): HTMLElement {
  const node = document.querySelector<HTMLElement>("[data-mw-report-dialog]");
  if (!node) throw new Error("the report dialog is not open");
  return node;
}

function setTextarea(node: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function chooseReason(kind: string): void {
  const radio = dialog().querySelector<HTMLInputElement>(`input[value="${kind}"]`)!;
  act(() => {
    radio.click();
  });
}

async function mountDialog(
  respond: Parameters<typeof stubApi>[0],
  messageId: string | null = null,
) {
  const closed: boolean[] = [];
  const calls = stubApi(respond);
  mounted = await mount(
    <ReportDialog
      open
      conversationId={CONVERSATION_ID}
      messageId={messageId}
      onOpenChange={(open) => closed.push(open)}
    />,
    principalWith(["user"]),
  );
  return { calls, closed };
}

describe("the report dialog", () => {
  it("offers exactly the reasons the API accepts, unsafe first", async () => {
    await mountDialog(() => undefined);
    const values = [...dialog().querySelectorAll<HTMLInputElement>("input[type='radio']")].map(
      (radio) => radio.value,
    );
    expect(values).toEqual(REPORT_REASONS.map((reason) => reason.kind));
    expect(values).toEqual(["unsafe", "unhelpful"]);
    expect(dialog().textContent).toContain("Report this conversation");
  });

  it("posts the reason, the note and the reply id, and shows the reference it gets back", async () => {
    const { calls } = await mountDialog(({ method, url }) => {
      if (method === "POST" && url === `/api/conversations/${CONVERSATION_ID}/report`) {
        return { status: 201, body: { id: "rep-42", kind: "unhelpful" } };
      }
      return undefined;
    }, "m-7");
    expect(dialog().textContent).toContain("Report this reply");

    chooseReason("unhelpful");
    setTextarea(dialog().querySelector("textarea")!, "  It answered a different question.  ");
    click(buttonNamed(dialog(), "Send report"));
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      kind: "unhelpful",
      message_id: "m-7",
      note: "It answered a different question.",
    });
    // The id, selectable, so it can be quoted to support.
    expect(dialog().getAttribute("data-mw-report-dialog")).toBe("sent");
    expect(dialog().querySelector("[data-testid='report-id']")?.textContent).toBe("rep-42");
    expect(dialog().querySelector("[role='status']")?.textContent).toContain("filed");
    // The form is gone: nothing invites filing the same report twice.
    expect(dialog().querySelector("textarea")).toBeNull();
  });

  it("sends a null note rather than an empty string, and null for the whole conversation", async () => {
    const { calls } = await mountDialog(({ method }) =>
      method === "POST" ? { status: 201, body: { id: "rep-1", kind: "unsafe" } } : undefined,
    );
    click(buttonNamed(dialog(), "Send report"));
    await flush();
    expect(calls[0].body).toEqual({ kind: "unsafe", message_id: null, note: null });
  });

  it("says nothing was filed when the API refuses, keeps the form, and offers another go", async () => {
    await mountDialog(({ method }) =>
      method === "POST"
        ? {
            status: 429,
            body: {
              detail: "You have filed several reports recently. Try again in 12 minutes.",
              request_id: "req-report-429",
            },
          }
        : undefined,
    );
    setTextarea(dialog().querySelector("textarea")!, "note kept");
    click(buttonNamed(dialog(), "Send report"));
    await flush();

    expect(dialog().getAttribute("data-mw-report-dialog")).toBe("failed");
    const alert = dialog().querySelector("[role='alert']")!;
    // The rate limit's own sentence: it carries the minutes to wait.
    expect(alert.textContent).toContain("Try again in 12 minutes");
    expect(alert.textContent).toContain("req-report-429");
    // The note survives the failure and the button says try again.
    expect(dialog().querySelector("textarea")?.value).toBe("note kept");
    expect(buttonNamed(dialog(), "Try again")).toBeTruthy();
    expect(dialog().querySelector("[data-testid='report-id']")).toBeNull();
  });

  it("will not send a note over the API's cap", async () => {
    const { calls } = await mountDialog(() => undefined);
    setTextarea(dialog().querySelector("textarea")!, "x".repeat(2001));
    expect(buttonNamed(dialog(), "Send report").disabled).toBe(true);
    expect(dialog().querySelector("textarea")?.getAttribute("aria-invalid")).toBe("true");
    expect(calls).toHaveLength(0);
  });

  it("closes through Cancel and through Done", async () => {
    const { closed } = await mountDialog(({ method }) =>
      method === "POST" ? { status: 201, body: { id: "rep-9", kind: "unsafe" } } : undefined,
    );
    click(buttonNamed(dialog(), "Cancel"));
    expect(closed).toEqual([false]);
    click(buttonNamed(dialog(), "Send report"));
    await flush();
    click(buttonNamed(dialog(), "Done"));
    expect(closed).toEqual([false, false]);
  });
});

describe("reportFailureMessage", () => {
  it("never leaves a person believing a report went through", () => {
    for (const status of [400, 404, 500, 503]) {
      expect(reportFailureMessage(new ApiError(status, "raw"))).toMatch(/nothing was filed/i);
    }
    expect(reportFailureMessage(new TypeError("Failed to fetch"))).toMatch(/nothing was filed/i);
    // The 503 names the real reason without the operator's env-var prose.
    expect(reportFailureMessage(new ApiError(503, "set MW_DATABASE_URL"))).not.toContain(
      "MW_DATABASE_URL",
    );
  });
});
