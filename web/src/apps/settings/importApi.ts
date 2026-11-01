import { plural, t } from "@lingui/core/macro";
import { formatNumber } from "../../i18n/format";
import { ApiError, apiFetch } from "../../lib/api";

/**
 * Importing a ChatGPT or Claude export: the shapes `/api/me/imports`
 * serves and the requests the Data pane makes. Outside the component so
 * the summary wording is testable without a DOM.
 */

export type ImportStatus = "pending" | "running" | "done" | "failed";
export type ImportSource = "chatgpt" | "claude";

export interface ImportRecord {
  readonly id: string;
  readonly status: ImportStatus;
  readonly source: ImportSource;
  readonly filename: string;
  readonly size_bytes: number;
  readonly conversations_total: number;
  readonly conversations_done: number;
  readonly conversations_created: number;
  readonly conversations_existing: number;
  readonly conversations_skipped: number;
  readonly messages_created: number;
  readonly attachments_skipped: number;
  readonly branches_dropped: number;
  /** Why the import stopped early or failed; null when it ran clean. */
  readonly error: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

/** How often the Data pane asks where a running import stands. */
export const IMPORT_POLL_MS = 1500;

/** The API's cap, mirrored so the pane can refuse before the upload would. */
export const IMPORT_MAX_BYTES = 100 * 1024 * 1024;

/** The file types an export arrives as. The server decides from the bytes. */
export const IMPORT_ACCEPT = ".json,.zip,application/json,application/zip";

export const SOURCE_NAMES: Record<ImportSource, string> = { chatgpt: "ChatGPT", claude: "Claude" };

export function startImport(file: File): Promise<ImportRecord> {
  const form = new FormData();
  form.append("file", file, file.name);
  return apiFetch<ImportRecord>("/api/me/imports", { method: "POST", form });
}

export async function listImports(): Promise<ImportRecord[]> {
  const body = await apiFetch<{ data: ImportRecord[] }>("/api/me/imports");
  return body.data;
}

export function fetchImport(importId: string): Promise<ImportRecord> {
  return apiFetch<ImportRecord>(`/api/me/imports/${encodeURIComponent(importId)}`);
}

export function isActive(record: ImportRecord): boolean {
  return record.status === "pending" || record.status === "running";
}

/** 0-100, for the bar; a job that has not said anything yet is 0. */
export function percentDone(record: ImportRecord): number {
  if (record.conversations_total <= 0) return record.status === "done" ? 100 : 0;
  return Math.min(100, Math.round((record.conversations_done / record.conversations_total) * 100));
}

/** One line of what the import did, for the result card, in the active language. */
export function summarize(record: ImportRecord): string {
  const source = SOURCE_NAMES[record.source] ?? record.source;
  const created = record.conversations_created;
  const existing = record.conversations_existing;
  const skipped = record.conversations_skipped;
  const messages = record.messages_created;
  const parts = [
    plural(created, {
      one: `# conversation imported from ${source}`,
      other: `# conversations imported from ${source}`,
    }),
    plural(messages, { one: "# message", other: "# messages" }),
  ];
  if (existing > 0) {
    parts.push(t`${existing} already here`);
  }
  if (skipped > 0) {
    parts.push(t`${skipped} skipped`);
  }
  return parts.join(" · ");
}

/** What was left behind, as a sentence; empty when nothing was. */
export function leftBehind(record: ImportRecord): string {
  const notes: string[] = [];
  const branches = record.branches_dropped;
  const attachments = record.attachments_skipped;
  if (record.branches_dropped > 0) {
    notes.push(
      plural(branches, {
        one: "# message on other branches of the original conversations was not imported; each conversation is the thread as it was last shown.",
        other:
          "# messages on other branches of the original conversations were not imported; each conversation is the thread as it was last shown.",
      }),
    );
  }
  if (record.attachments_skipped > 0) {
    notes.push(
      plural(attachments, {
        one: "# attachment was not imported: exports do not carry the files.",
        other: "# attachments were not imported: exports do not carry the files.",
      }),
    );
  }
  return notes.join(" ");
}

/** The line to show when the upload was refused; the API's own wording where it has one. */
export function importFailureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 413) return t`That file is larger than the 100 MB limit.`;
    if (err.status === 402 || err.status === 403 || err.status === 409) return err.message;
    if (err.status === 422 || err.status === 429) return err.message;
    if (err.status === 503) return err.message;
  }
  return t`The file could not be uploaded. Try again in a moment.`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${formatNumber(n)} B`;
  if (n < 1024 * 1024) return `${formatNumber(Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  return `${formatNumber(mb, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}
