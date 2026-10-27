import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationActions } from "./ConversationActions";
import { ShellContext, type ShellContextValue } from "../../shell/shellContext";
import { ApiError } from "../../lib/api";

/**
 * Rename, pin, archive, move and delete from the thread header. The items
 * come from the shell -- the row lives on its conversation list -- so the
 * menu is mounted inside a stub shell here, and once without one to show
 * they are simply absent. Same harness as CompactionDivider.test.tsx, which
 * covers the other items.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: React.ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function click(element: Element | null | undefined): void {
  act(() => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** The item's words: the folder items carry a tick glyph that is hidden from a reader. */
function itemText(button: HTMLButtonElement): string {
  return (button.textContent ?? "").replace(/^✓/, "");
}

function item(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")).find(
    (b) => itemText(b) === label,
  );
}

function byLabel(label: string): HTMLInputElement | null {
  return container!.querySelector(`[aria-label="${label}"]`);
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function menu() {
  return (
    <ConversationActions
      busy={false}
      onShare={() => undefined}
      onExport={() => undefined}
      onReport={() => undefined}
    />
  );
}

function shellWith(
  renameConversation: ShellContextValue["renameConversation"],
  over: Partial<ShellContextValue> = {},
  row: Record<string, unknown> = {},
) {
  const value = {
    activeConversationId: "c-1",
    conversations: [
      { id: "c-1", title: "Infra", created_at: "2026-09-01", updated_at: "2026-09-01", ...row },
    ],
    renameConversation,
    setPinned: vi.fn(() => Promise.resolve()),
    setArchived: vi.fn(() => Promise.resolve()),
    deleteConversation: vi.fn(() => Promise.resolve()),
    reloadConversations: vi.fn(() => Promise.resolve()),
    ...over,
  } as unknown as ShellContextValue;
  return <ShellContext.Provider value={value}>{menu()}</ShellContext.Provider>;
}

/** `/api/library` with these folders, and `PUT …/folder` recorded. */
function stubLibrary(folders: { id: string; name: string }[]): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url} ${init?.body ?? ""}`.trim());
      const body = url === "/api/library" ? { folders, tags: [], assignments: {} } : {};
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "",
        headers: new Headers(),
        json: () => Promise.resolve(body),
      } as Response);
    }),
  );
  return { calls };
}

async function openMenu(): Promise<void> {
  click(container!.querySelector("[aria-label='Conversation actions']"));
  await act(async () => {
    await Promise.resolve();
  });
}

function itemLabels(): string[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")).map(itemText);
}

function openRename(): HTMLInputElement {
  click(container!.querySelector("[aria-label='Conversation actions']"));
  click(item("Rename…"));
  const input = byLabel("New name for Infra");
  expect(input).not.toBeNull();
  expect(input!.value).toBe("Infra");
  return input!;
}

describe("Rename from the thread header", () => {
  it("is absent outside the shell, where there is nothing to rename", () => {
    render(menu());
    click(container!.querySelector("[aria-label='Conversation actions']"));
    expect(item("Rename…")).toBeUndefined();
    expect(item("Share…")).not.toBeUndefined();
  });

  it("opens the title for editing, and Enter saves through the shell", () => {
    const rename = vi.fn(() => Promise.resolve());
    render(shellWith(rename));
    const input = openRename();
    typeInto(input, " Infra notes ");
    act(() => {
      input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(rename).toHaveBeenCalledWith("c-1", "Infra notes");
    expect(byLabel("New name for Infra")).toBeNull();
  });

  it("Escape cancels, and an unchanged name on blur sends nothing", () => {
    const rename = vi.fn(() => Promise.resolve());
    render(shellWith(rename));
    const input = openRename();
    typeInto(input, "Dropped");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(byLabel("New name for Infra")).toBeNull();

    const again = openRename();
    act(() => {
      again.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(rename).not.toHaveBeenCalled();
  });

  it("blur saves, and a refusal is said beside the button", async () => {
    const rename = vi.fn(() =>
      Promise.reject(new ApiError(422, "title must not be empty", undefined, "req-1")),
    );
    render(shellWith(rename));
    const input = openRename();
    typeInto(input, "Renamed by blur");
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    expect(rename).toHaveBeenCalledWith("c-1", "Renamed by blur");
    expect(container!.querySelector("[role='alert']")?.textContent).toContain(
      "title must not be empty",
    );
  });
});

describe("the row actions from the thread header", () => {
  it("are absent outside the shell, where there is no row to act on", async () => {
    stubLibrary([]);
    render(menu());
    await openMenu();
    const labels = itemLabels();
    for (const label of ["Pin", "Archive", "Delete…", "No folder"]) {
      expect(labels).not.toContain(label);
    }
  });

  it("pins and archives through the shell, reading the row's state for the word", async () => {
    stubLibrary([]);
    const setPinned = vi.fn(() => Promise.resolve());
    const setArchived = vi.fn(() => Promise.resolve());
    render(shellWith(undefined, { setPinned, setArchived }));
    await openMenu();
    expect(itemLabels()).toEqual(
      expect.arrayContaining(["Pin", "Archive", "Delete…", "Share…", "Report conversation…"]),
    );
    click(item("Pin"));
    expect(setPinned).toHaveBeenCalledWith("c-1", true);
    await openMenu();
    click(item("Archive"));
    expect(setArchived).toHaveBeenCalledWith("c-1", true);

    act(() => root?.unmount());
    container?.remove();
    render(
      shellWith(undefined, { setPinned, setArchived }, { pinned_at: "2026-09-02", archived_at: "2026-09-03" }),
    );
    await openMenu();
    expect(itemLabels()).toEqual(expect.arrayContaining(["Unpin", "Unarchive"]));
    click(item("Unpin"));
    expect(setPinned).toHaveBeenLastCalledWith("c-1", false);
  });

  it("offers Move to only when a folder exists, and files the conversation there", async () => {
    const { calls } = stubLibrary([{ id: "f1", name: "Work" }]);
    const reloadConversations = vi.fn(() => Promise.resolve());
    render(shellWith(undefined, { reloadConversations }));
    await openMenu();
    expect(itemLabels()).toEqual(expect.arrayContaining(["No folder", "Work"]));
    expect(item("No folder")?.getAttribute("aria-current")).toBe("true");
    click(item("Work"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toContain('PUT /api/library/conversations/c-1/folder {"folder_id":"f1"}');
    expect(reloadConversations).toHaveBeenCalled();
  });

  it("has no Move to when there are no folders", async () => {
    stubLibrary([]);
    render(shellWith(undefined));
    await openMenu();
    expect(itemLabels()).not.toContain("No folder");
  });

  it("asks before deleting, and deletes through the shell on confirm", async () => {
    stubLibrary([]);
    const deleteConversation = vi.fn(() => Promise.resolve());
    render(shellWith(undefined, { deleteConversation }));
    await openMenu();
    click(item("Delete…"));
    expect(deleteConversation).not.toHaveBeenCalled();
    const dialog = document.querySelector("[role='dialog']")!;
    expect(dialog.textContent).toContain("Delete this conversation?");
    expect(dialog.textContent).toContain("Infra");
    const confirm = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Delete")!;
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(deleteConversation).toHaveBeenCalledWith("c-1");
  });

  it("says so beside the button when the shell refuses", async () => {
    stubLibrary([]);
    const setPinned = vi.fn(() => Promise.reject(new ApiError(409, "Pinned limit reached", undefined, "req-9")));
    render(shellWith(undefined, { setPinned }));
    await openMenu();
    click(item("Pin"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container!.querySelector("[role='alert']")?.textContent).toContain("Pinned limit reached");
  });
});

describe("the items that open a dialog", () => {
  // The dialog returns focus to whatever had it when it opened, and the
  // menu's own late return-focus would land outside the open modal: focus
  // is on the menu button before the action runs.
  it.each(["Report conversation…", "Share…"])("%s hands focus to the menu button first", (label) => {
    let focusedAtOpen: Element | null = null;
    const open = () => {
      focusedAtOpen = document.activeElement;
    };
    render(
      <ConversationActions busy={false} onShare={open} onExport={() => undefined} onReport={open} />,
    );
    const button = container!.querySelector("[aria-label='Conversation actions']");
    click(button);
    click(item(label));
    expect(focusedAtOpen).toBe(button);
  });
});
