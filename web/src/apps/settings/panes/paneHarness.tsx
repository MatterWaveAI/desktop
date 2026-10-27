import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import type { AuthConfig, Principal } from "../../../types";
import { ShellContext, type ShellContextValue } from "../../../shell/shellContext";

/**
 * The pane tests' harness: react-dom directly, no testing library,
 * the same shape settings.test.tsx uses -- plus a fetch stub keyed by
 * `METHOD /path` so each test states the API it expects in one place.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const authConfig: AuthConfig = {
  auth_mode: "none",
  csrf_cookie: "mw_csrf",
  default_model: "fake-mini",
};

/**
 * A principal with the platform claim(s) given and, separately, the org
 * membership role: the two are different authorities, and the panes gate
 * on the second.
 */
export function principalWith(roles: string[], orgRole: string | null = null): Principal {
  return {
    subject: "dev-user",
    kind: "dev",
    email: "dev@localhost",
    name: null,
    roles,
    org_id: "dev-org",
    org_name: "Dev Org",
    org_role: orgRole,
  };
}

function shellValue(principal: Principal, config: Partial<AuthConfig> = {}): ShellContextValue {
  return {
    authConfig: { ...authConfig, ...config },
    principal,
    conversations: [],
    conversationsLoading: false,
    conversationsError: null,
    activeConversationId: null,
    selectConversation: () => {},
    deleteConversation: async () => {},
    // Pin, archive and the list filter. Inert here -- these harnesses
    // mount panes that never touch the conversation list.
    setPinned: async () => {},
    setArchived: async () => {},
    listFilter: "default" as const,
    setListFilter: () => {},
    onConversationCreated: () => {},
    onConversationRenamed: () => {},
    reloadConversations: async () => {},
    signOut: async () => {},
  };
}

export interface Mounted {
  container: HTMLElement;
  unmount: () => void;
}

export async function mount(
  node: React.ReactNode,
  principal: Principal,
  config: Partial<AuthConfig> = {},
): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <ShellContext.Provider value={shellValue(principal, config)}>{node}</ShellContext.Provider>,
    );
  });
  await flush();
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Let pending fetches resolve and their state updates commit. */
export async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

export type Responder = (call: RecordedCall) => { status: number; body: unknown } | undefined;

/**
 * Stub `fetch` with a responder. Returns the calls in order so a test can
 * assert the exact request the API received.
 */
export function stubApi(respond: Responder): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, url, body };
    calls.push(call);
    const reply = respond(call) ?? { status: 404, body: { detail: `no mock for ${method} ${url}` } };
    return {
      ok: reply.status < 400,
      status: reply.status,
      statusText: "",
      json: async () => reply.body,
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

export function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** React tracks the input's value internally; set it the way the DOM would. */
export function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function buttonNamed(scope: ParentNode, text: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

/** A button's accessible name: its aria-label when it has one, else its text. */
export function accessibleName(button: Element): string {
  return button.getAttribute("aria-label") ?? button.textContent ?? "";
}

/** The button a screen reader would announce by this name. */
export function buttonLabelled(scope: ParentNode, name: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll("button")].find((b) => accessibleName(b) === name);
  if (!button) throw new Error(`no button labelled "${name}"`);
  return button;
}

export function submit(form: HTMLFormElement): void {
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/**
 * The styled select (SimpleSelect) by its accessible name: the combobox
 * trigger. Null when the pane did not render one.
 */
export function selectNamed(scope: ParentNode, name: string): HTMLElement | null {
  return (
    [...scope.querySelectorAll<HTMLElement>("[role=combobox]")].find(
      (el) => el.getAttribute("aria-label") === name ||
        (el.id !== "" && document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() === name),
    ) ?? null
  );
}

/** The option label the styled select is showing. */
export function selectShown(trigger: HTMLElement): string {
  return trigger.querySelector("[data-slot=select-value]")?.textContent?.trim() ?? trigger.textContent?.trim() ?? "";
}

/** Open a styled select from the keyboard and return its open list's options. */
async function openOptions(trigger: HTMLElement): Promise<HTMLElement[]> {
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  let options: HTMLElement[] = [];
  await vi.waitFor(() => {
    // The open list is the one the trigger controls; a list closed a
    // moment ago may still be in the document while it animates out.
    const listId = trigger.getAttribute("aria-controls");
    const list = listId ? document.getElementById(listId) : null;
    const scope: ParentNode = list ?? document;
    options = [...scope.querySelectorAll<HTMLElement>("[role=option]")];
    if (options.length === 0) throw new Error("the list did not open");
  });
  return options;
}

/**
 * Pick an option of a styled select the way a person does: open the list
 * from the keyboard, then click the option with this text.
 */
export async function chooseOption(trigger: HTMLElement, label: string): Promise<void> {
  const options = await openOptions(trigger);
  const option = options.find((o) => o.textContent?.trim() === label);
  if (!option) {
    throw new Error(`no option "${label}" (saw ${options.map((o) => o.textContent?.trim()).join(", ")})`);
  }
  await act(async () => {
    option.click();
  });
  await flush();
}

/** The labels a styled select offers, read by opening it and closing it again. */
export async function optionsOf(trigger: HTMLElement): Promise<string[]> {
  const labels = (await openOptions(trigger)).map((o) => o.textContent?.trim() ?? "");
  await act(async () => {
    (document.activeElement ?? trigger).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await flush();
  return labels;
}
