import { describe, expect, it } from "vitest";
import { CONTRACT, CONTRACT_SHA256 } from "./sdk/contract";
import { allowed, systemPrompt, toolsForMode } from "./sdk/modes";
import { unifiedDiff } from "./sdk/diff";
import { MODE_NAMES } from "./sdk/types";

/**
 * The SPA's copy of the SDK's agent helpers against the files the Rust tool
 * host reads (src-tauri/agent): the same contract, value for value, and the
 * shared conformance cases for the parts the SPA uses -- the mode
 * decisions, the tools each mode offers, the diff and the system prompt.
 * node:fs through a dynamic import: the web tsconfig has no node types.
 */
const fsModuleName = "node:fs";
const cryptoModuleName = "node:crypto";
const processModuleName = "node:process";
const { readFileSync } = (await import(/* @vite-ignore */ fsModuleName)) as {
  readFileSync: (path: string, encoding: string) => string;
};
const { createHash } = (await import(/* @vite-ignore */ cryptoModuleName)) as {
  createHash: (alg: string) => { update: (s: string, e: string) => { digest: (f: string) => string } };
};
const { cwd } = (await import(/* @vite-ignore */ processModuleName)) as { cwd: () => string };

const hostDir = `${cwd()}/../src-tauri/agent`;
const hostContract: unknown = JSON.parse(readFileSync(`${hostDir}/contract.json`, "utf-8"));
const conformance = JSON.parse(readFileSync(`${hostDir}/conformance.json`, "utf-8")) as {
  decisions: Record<string, Record<string, string>>;
  tools_for_mode: Record<string, string[]>;
  diffs: { name: string; old: string; new: string; path?: string; context?: number; expected: string }[];
  prompts: { mode: string; root: string; platform: string; expected: string }[];
};

describe("the vendored agent contract", () => {
  it("is the contract the native host reads", () => {
    expect(CONTRACT).toEqual(hostContract);
  });

  it("has the hash it was generated with", () => {
    const digest = createHash("sha256").update(JSON.stringify(CONTRACT), "utf8").digest("hex");
    expect(digest).toBe(CONTRACT_SHA256);
  });
});

describe("the shared conformance cases", () => {
  it("decides each tool in each mode", () => {
    for (const [mode, tools] of Object.entries(conformance.decisions)) {
      for (const [tool, decision] of Object.entries(tools)) {
        expect(allowed(tool, mode), `${tool} in ${mode}`).toBe(decision);
      }
    }
  });

  it("offers each mode its tools", () => {
    for (const mode of MODE_NAMES) {
      expect(toolsForMode(mode).map((t) => t.function.name)).toEqual(conformance.tools_for_mode[mode]);
    }
  });

  it.each(conformance.diffs.map((c) => [c.name, c] as const))("diffs %s", (_name, c) => {
    expect(unifiedDiff(c.old, c.new, c.path ?? "file", c.context === undefined ? {} : { context: c.context })).toBe(
      c.expected,
    );
  });

  it("renders the system prompt", () => {
    for (const c of conformance.prompts) {
      expect(systemPrompt(c.mode, c.root, { platform: c.platform })).toBe(c.expected);
    }
  });
});
