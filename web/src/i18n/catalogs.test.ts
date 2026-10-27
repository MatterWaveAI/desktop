import { describe, expect, it } from "vitest";

/**
 * The catalogues on disk, as the rules in docs/i18n.md state them:
 *
 *   - no entry is obsolete (`#~`): `pnpm i18n:extract` runs with --clean, so
 *     a string removed from the source leaves the catalogues too;
 *   - every source message has a translation in the pilot locale, since
 *     es-ES has no fallback and a missing one would render the message id;
 *   - en-US holds only what differs from en-GB, and every entry it does
 *     hold differs -- a copy of the British string there is noise;
 *   - the draft locale says it is a draft in its header, where a reviewer
 *     and the language select both read it.
 *
 * Whether the catalogues match the SOURCE is `make i18n-check`'s question
 * (extract, then `git diff --exit-code`), which needs the CLI and git; this
 * file reads what is committed. node:fs through a dynamic import, as
 * hex-drift.test.ts does, because the web tsconfig has no node types.
 */

const fsModuleName = "node:fs";
const processModuleName = "node:process";
const { readFileSync } = (await import(/* @vite-ignore */ fsModuleName)) as {
  readFileSync: (path: string, encoding: string) => string;
};
const { cwd } = (await import(/* @vite-ignore */ processModuleName)) as { cwd: () => string };

const LOCALES_DIR = `${cwd()}/src/locales`;

interface Entry {
  msgid: string;
  msgstr: string;
  obsolete: boolean;
}

function unquote(line: string): string {
  const match = line.match(/^"(.*)"$/);
  if (!match) throw new Error(`not a PO string: ${line}`);
  return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

/** The entries of a PO file, header included as the entry whose msgid is "". */
function parsePo(text: string): Entry[] {
  const entries: Entry[] = [];
  let current: Partial<Entry> & { field?: "msgid" | "msgstr" } = {};
  const flush = () => {
    if (current.msgid !== undefined) {
      entries.push({ msgid: current.msgid, msgstr: current.msgstr ?? "", obsolete: current.obsolete ?? false });
    }
    current = {};
  };
  for (const raw of text.split(/\r?\n/)) {
    const obsolete = raw.startsWith("#~");
    const line = obsolete ? raw.slice(2).trim() : raw;
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("#")) continue;
    if (line.startsWith("msgid ")) {
      if (current.msgid !== undefined) flush();
      current = { msgid: unquote(line.slice(6)), field: "msgid", obsolete };
    } else if (line.startsWith("msgstr ")) {
      current.msgstr = unquote(line.slice(7));
      current.field = "msgstr";
    } else if (line.startsWith('"')) {
      if (current.field === "msgid") current.msgid = (current.msgid ?? "") + unquote(line);
      else current.msgstr = (current.msgstr ?? "") + unquote(line);
    }
  }
  flush();
  return entries;
}

function catalogue(locale: string): { header: string; messages: Entry[] } {
  const entries = parsePo(readFileSync(`${LOCALES_DIR}/${locale}.po`, "utf8"));
  const header = entries.find((entry) => entry.msgid === "")?.msgstr ?? "";
  return { header, messages: entries.filter((entry) => entry.msgid !== "") };
}

const source = catalogue("en-GB");
const enUS = catalogue("en-US");
const esES = catalogue("es-ES");

describe("the catalogues", () => {
  it("hold the same messages, none obsolete", () => {
    expect(source.messages.length).toBeGreaterThan(100);
    const ids = source.messages.map((entry) => entry.msgid).sort();
    expect(enUS.messages.map((entry) => entry.msgid).sort()).toEqual(ids);
    expect(esES.messages.map((entry) => entry.msgid).sort()).toEqual(ids);
    for (const { messages } of [source, enUS, esES]) {
      expect(messages.filter((entry) => entry.obsolete)).toEqual([]);
    }
  });

  it("name their language in the header", () => {
    expect(source.header).toContain("Language: en-GB\n");
    expect(enUS.header).toContain("Language: en-US\n");
    expect(esES.header).toContain("Language: es-ES\n");
  });
});

describe("en-GB, the source", () => {
  it("carries its own wording as the translation of every message", () => {
    for (const entry of source.messages) expect(entry.msgstr).toBe(entry.msgid);
  });
});

describe("en-US, spelling variants only", () => {
  it("translates only what differs, and every translation differs", () => {
    const translated = enUS.messages.filter((entry) => entry.msgstr !== "");
    expect(translated.length).toBeGreaterThan(0);
    expect(translated.length).toBeLessThan(source.messages.length / 4);
    for (const entry of translated) expect(entry.msgstr).not.toBe(entry.msgid);
  });

  it("keeps every placeholder of the source", () => {
    for (const entry of enUS.messages) {
      if (entry.msgstr === "") continue;
      expect(placeholders(entry.msgstr), entry.msgid).toEqual(placeholders(entry.msgid));
    }
  });
});

describe("es-ES, the machine-drafted pilot", () => {
  it("is marked as a draft in its header", () => {
    expect(esES.header).toContain("X-Translation-Status: draft\n");
  });

  it("translates every message, so nothing can render as an id", () => {
    const missing = esES.messages.filter((entry) => entry.msgstr === "").map((entry) => entry.msgid);
    expect(missing).toEqual([]);
  });

  it("keeps every placeholder and tag of the source", () => {
    for (const entry of esES.messages) {
      expect(placeholders(entry.msgstr), entry.msgid).toEqual(placeholders(entry.msgid));
    }
  });
});

/**
 * The `{name}` placeholders, `<0>…</0>` component tags and `{x, plural, …}`
 * selectors a message carries, as a sorted list; a translation must carry
 * the same ones or the runtime renders a hole where the value should be.
 */
function placeholders(message: string): string[] {
  const simple = [...message.matchAll(/\{(\w+)(?=[,}])/g)].map((match) => `{${match[1]}}`);
  const tags = [...message.matchAll(/<(\d+)>/g)].map((match) => `<${match[1]}>`);
  const plural = [...message.matchAll(/\{(\w+), plural,/g)].map((match) => `plural:${match[1]}`);
  return [...simple, ...tags, ...plural].sort();
}
