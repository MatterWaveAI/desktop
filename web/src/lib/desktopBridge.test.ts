import { describe, expect, it } from "vitest";

/**
 * Every bridge call the SPA makes must be one the main window's capability
 * allows: the native side refuses anything else, and the SPA catches most
 * refusals, so a missing permission shows up as a feature that silently
 * does nothing. The tests that fake the bridge cannot see it; this test
 * reads the source and the capability file side by side.
 */

// node:fs through a dynamic import, as the other source scans here do: the
// web tsconfig has no node types, and vitest runs with web/ as the cwd.
const fsModuleName = "node:fs";
const processModuleName = "node:process";
const { readdirSync, readFileSync, statSync } = (await import(/* @vite-ignore */ fsModuleName)) as {
  readdirSync: (path: string) => string[];
  readFileSync: (path: string, encoding: string) => string;
  statSync: (path: string) => { isDirectory(): boolean };
};
const { cwd } = (await import(/* @vite-ignore */ processModuleName)) as { cwd: () => string };

const SRC = `${cwd()}/src`;
const CAPABILITY = `${cwd()}/../src-tauri/capabilities/default.json`;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** The command names passed as a literal to the bridge: `call("x")`, `invoke("plugin:y|z")`. */
function bridgeCalls(text: string): string[] {
  const calls = [...text.matchAll(/\b(?:call|invoke)\s*(?:<[^>()]*>)?\(\s*"([a-z_:|-]+)"/g)].map((m) => m[1]);
  return calls.filter((name) => name.includes("|") || /^[a-z_]+$/.test(name));
}

/** The permission a command needs: `allow-<cmd>` for the app's own, `<plugin>:allow-<cmd>` for a plugin's. */
function permissionFor(command: string): string {
  const plugin = /^plugin:([a-z-]+)\|([a-z_]+)$/.exec(command);
  if (!plugin) return `allow-${command.replace(/_/g, "-")}`;
  const [, name, cmd] = plugin;
  // The core plugins (event, window, app, ...) are namespaced under `core:`.
  const prefix = ["event", "window", "webview", "app", "path", "image", "menu", "tray", "resources"].includes(name)
    ? `core:${name}`
    : name;
  return `${prefix}:allow-${cmd.replace(/_/g, "-")}`;
}

describe("the bridge calls the SPA makes", () => {
  const capability = JSON.parse(readFileSync(CAPABILITY, "utf8")) as { windows: string[]; permissions: string[] };
  const calls = [...new Set(sources(SRC).flatMap((file) => bridgeCalls(readFileSync(file, "utf8"))))].sort();

  it("are found: the scan sees the desktop module's commands and the event plugin", () => {
    expect(calls).toContain("get_access_token");
    expect(calls).toContain("plugin:event|listen");
    expect(calls).toContain("plugin:event|unlisten");
  });

  it("are all permitted for the main window", () => {
    expect(capability.windows).toContain("main");
    const missing = calls.filter((command) => !capability.permissions.includes(permissionFor(command)));
    expect(missing).toEqual([]);
  });

  it("name their permissions the way Tauri does", () => {
    expect(permissionFor("get_access_token")).toBe("allow-get-access-token");
    expect(permissionFor("plugin:event|listen")).toBe("core:event:allow-listen");
    expect(permissionFor("plugin:deep-link|get_current")).toBe("deep-link:allow-get-current");
  });
});
