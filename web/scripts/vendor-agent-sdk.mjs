// Copies the TypeScript SDK's browser-safe agent helpers into
// src/apps/agent/sdk/, the copy agent mode's loop uses:
//
//   node scripts/vendor-agent-sdk.mjs <typescript-sdk checkout> <its ref>
//
// The files are taken as they are, with three mechanical edits: a header
// naming where they came from, relative imports without the `.js` suffix
// (the web build resolves bare module paths), and in modes.ts the SDK's
// `Tool` type (from the SDK's own types.ts, outside the agent folder)
// restated, so the copy stands alone. `vendored()` is the same transform
// sdk.test.ts applies to check the copy against a checkout of the SDK.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FILES = [
  "contract.ts",
  "types.ts",
  "modes.ts",
  "diff.ts",
  "deny.ts",
  "fill.ts",
  "ignore.ts",
  "output.ts",
];

const TOOL = `/** A \`tools\` entry for \`/v1/chat/completions\`: the SDK's \`Tool\`, restated here so the copy stands alone. */
export interface Tool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}
`;

export function header(file, ref) {
  return [
    `// Vendored from @matterwave/sdk (typescript-sdk, ${ref}), src/agent/${file}.`,
    "// Do not edit here: change the SDK (or the Python SDK's contract.json it is",
    "// generated from), then copy the file again. sdk.test.ts checks the copy",
    "// against src-tauri/agent/contract.json, the file the Rust tool host reads.",
    "",
  ].join("\n");
}

/** The SDK file's text as the copy holds it, below its header. */
export function vendored(file, source) {
  let text = source.replace(/(from "\.\/[A-Za-z]+)\.js"/g, '$1"');
  if (file === "modes.ts") {
    const toolImport = 'import type { Tool } from "../types.js";\n';
    if (!text.includes(toolImport)) throw new Error("modes.ts no longer imports Tool from ../types.js");
    text = text.replace(toolImport, "");
    const end = text.indexOf('} from "./types";\n');
    if (end === -1) throw new Error("modes.ts: the types import moved");
    const at = end + '} from "./types";\n'.length;
    text = `${text.slice(0, at)}\n${TOOL}${text.slice(at)}`;
  }
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sdk, ref] = process.argv.slice(2);
  if (!sdk || !ref) {
    console.error("usage: node scripts/vendor-agent-sdk.mjs <typescript-sdk checkout> <ref>");
    process.exit(2);
  }
  const out = fileURLToPath(new URL("../src/apps/agent/sdk/", import.meta.url));
  for (const file of FILES) {
    const source = readFileSync(join(sdk, "src", "agent", file), "utf8");
    writeFileSync(join(out, file), header(file, ref) + vendored(file, source));
    console.log(`vendored ${file}`);
  }
}
