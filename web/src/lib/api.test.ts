import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";

/**
 * apiFetch's success path. Several routes answer a DELETE with 204 and no
 * body (revoking an invite link, an invite, removing a member); parsing
 * that as JSON threw, and the pane said "Could not reach MatterWave" about
 * a delete that had happened.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("resolves a 204 to undefined instead of parsing an empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(apiFetch("/api/org/invite-links/abc", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("still parses a JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await expect(apiFetch("/api/thing")).resolves.toEqual({ ok: true });
  });
});
