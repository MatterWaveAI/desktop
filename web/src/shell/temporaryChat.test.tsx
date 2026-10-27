import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, Conversation, Principal } from "../types";
import { ConversationSidebar } from "./conversationSidebar";
import { useShellState } from "./useShellState";
import { ShellContext, type ShellContextValue } from "./shellContext";

/**
 * A temporary conversation is open but never listed: creating one makes it
 * the active conversation without adding a sidebar row, while a kept one
 * appears at the top as before. Same harness as conversationPagination.test.tsx.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const PRINCIPAL: Principal = {
  subject: "dev-user",
  kind: "user",
  name: "Dev",
  email: "dev@example.test",
  roles: [],
  org_id: "dev-org",
  org_name: null,
  org_role: null,
};

const AUTH_CONFIG = { mode: "none" } as unknown as AuthConfig;

function conversation(
  over: Partial<Conversation> & { id: string; title: string },
): Conversation {
  return {
    created_at: "2026-09-01T00:00:00+00:00",
    updated_at: "2026-09-01T00:00:00+00:00",
    pinned_at: null,
    archived_at: null,
    ...over,
  };
}

const captured: { shell: ShellContextValue | null } = { shell: null };

function Harness() {
  const context = useShellState({
    authConfig: AUTH_CONFIG,
    principal: PRINCIPAL,
  });
  useEffect(() => {
    captured.shell = context;
  });
  return (
    <ShellContext.Provider value={context}>
      <ConversationSidebar />
    </ShellContext.Provider>
  );
}

function titles(): string[] {
  const list = container?.querySelector('[aria-label="Conversations"]');
  return Array.from(list?.querySelectorAll("li > a[title]") ?? []).map(
    (a) => a.getAttribute("title") ?? "",
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("the sidebar and a temporary conversation", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/apps/chat");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input);
        const body = url.includes("/api/conversations?")
          ? {
              data: [conversation({ id: "old", title: "Older" })],
              next_cursor: null,
            }
          : { data: [], folders: [], tags: [], assignments: {} };
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "",
          headers: new Headers(),
          json: () => Promise.resolve(body),
        } as Response);
      }),
    );
  });

  it("opens a temporary conversation without listing it", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<Harness />);
    });
    await settle();
    expect(titles()).toEqual(["Older"]);

    act(() => {
      captured.shell!.onConversationCreated(
        conversation({ id: "temp", title: "Not kept", temporary: true }),
      );
    });
    expect(captured.shell!.activeConversationId).toBe("temp");
    expect(titles()).toEqual(["Older"]);

    act(() => {
      captured.shell!.onConversationCreated(
        conversation({ id: "kept", title: "Kept" }),
      );
    });
    expect(captured.shell!.activeConversationId).toBe("kept");
    expect(titles()).toEqual(["Kept", "Older"]);
  });
});
