/**
 * The composer's attachment layer.
 *
 * The backend of this ticket is complete: `POST /api/attachments` sniffs the
 * type from the bytes and answers 201, `GET /api/attachments/limits/me`
 * reports the caps, and `MessageParts` already renders the `image` and
 * `document` parts a sent message carries. What was missing was every part a
 * person touches. This module is the non-visual half of it: the limits, the
 * client-side pre-check, the upload with progress, and the state machine one
 * pending attachment moves through.
 *
 * ## Two rules shape everything here
 *
 * **1. The typed text is never this module's to lose.** Nothing here owns the
 * draft, clears it, or is given a way to. An upload failure produces a
 * `PendingAttachment` in `status: "failed"` and nothing else; the composer
 * keeps rendering the same textarea it was already rendering. That is why
 * upload is modelled as state *beside* the draft rather than as a step inside
 * the send path -- a step inside the send path is a step that can throw
 * between "clear the draft" and "post the message", and no amount of care
 * makes that safe. It is unreachable instead.
 *
 * **2. The client checks for speed; the server decides.** `precheck` below
 * refuses what the server would refuse anyway, so a user on a phone learns
 * that a 40 MB video is too large in a millisecond rather than after a
 * two-minute upload. It is not a security boundary and must not be mistaken
 * for one: the caps come from the API (never a constant in this file), the
 * type check reads `File.type`, which is the OS's guess from the extension
 * and trivially wrong, and the server re-decides everything from the bytes.
 * A file that passes here can still be refused at 415 or 413, and that
 * refusal is the authoritative one.
 */

import { ApiError } from "../../lib/api";

/** `GET /api/attachments/limits/me`. Every number the composer shows. */
export interface AttachmentLimits {
  max_upload_bytes: number;
  quota_bytes: number;
  quota_used_bytes: number;
  quota_remaining_bytes: number;
}

/** The attachment row `POST /api/attachments` answers with. */
export interface UploadedAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  scan_status: string;
  created_at: string;
  message_id: string | null;
  extract_truncated: boolean;
  /** Minted by the upload response so a thumbnail needs no second request. */
  download_url?: string;
}

/**
 * One attachment in the composer, across its whole life.
 *
 * `uploading -> ready` or `uploading -> failed`, and on a deployment that
 * scans uploads, `uploading -> scanning -> ready | blocked | failed`. A
 * `failed` entry stays in the list on purpose: it carries the reason, it
 * offers a retry, and the user's own gesture is what removes it. Dropping it
 * automatically would make a failed upload look like a file that was never
 * picked. A `blocked` entry is the same minus the retry: the scanner removed
 * the file, and uploading it again would only remove it again.
 */
export type PendingAttachment =
  | {
      readonly status: "uploading";
      /** Client-side id; the server's id does not exist yet. */
      readonly key: string;
      readonly filename: string;
      readonly size_bytes: number;
      /** The type the OS guessed, for the icon only. Never sent, never trusted. */
      readonly local_type: string;
      /** 0-100. Monotonic, and never reported as 100 before the 201 lands. */
      readonly progress: number;
      /** Set while the upload is in flight so remove can abort it. */
      readonly abort: () => void;
      /** An object URL for an image preview, revoked on removal. */
      readonly preview?: string;
    }
  | {
      readonly status: "ready";
      readonly key: string;
      readonly attachment: UploadedAttachment;
      readonly preview?: string;
    }
  | {
      /** Uploaded; the server's malware scan has not answered yet. */
      readonly status: "scanning";
      readonly key: string;
      readonly attachment: UploadedAttachment;
      /** For a retry if the scan itself fails (the scanner was down), never for a resend. */
      readonly file: File;
      readonly preview?: string;
    }
  | {
      /** The scan removed it. Terminal: no retry, only remove. */
      readonly status: "blocked";
      readonly key: string;
      readonly filename: string;
      readonly size_bytes: number;
      readonly local_type: string;
      readonly reason: string;
      readonly preview?: string;
    }
  | {
      readonly status: "failed";
      readonly key: string;
      readonly filename: string;
      readonly size_bytes: number;
      readonly local_type: string;
      /** What to show the user. Already a sentence; never a raw status code. */
      readonly reason: string;
      /** The file itself, so Retry does not ask the user to pick it again. */
      readonly file: File;
      readonly preview?: string;
    };

/** The ids a send carries. Only `ready` entries have one. */
export function readyIds(pending: readonly PendingAttachment[]): string[] {
  return pending
    .filter((entry): entry is Extract<PendingAttachment, { status: "ready" }> =>
      entry.status === "ready",
    )
    .map((entry) => entry.attachment.id);
}

/**
 * Is anything still uploading, or waiting on its scan? The send button
 * waits on this: the server refuses a message whose attachment is not yet
 * `clean`, and a chip that says "scanning" beside a live send button would
 * be an invitation to that refusal.
 */
export function anyUploading(pending: readonly PendingAttachment[]): boolean {
  return pending.some((entry) => entry.status === "uploading" || entry.status === "scanning");
}

/**
 * Did any attachment fail, or get removed by the scan? Send waits on this
 * too: a message that goes without the file the person can see a chip for
 * is the silent drop the chip exists to prevent. They retry it or remove it,
 * then send.
 */
export function anyFailed(pending: readonly PendingAttachment[]): boolean {
  return pending.some((entry) => entry.status === "failed" || entry.status === "blocked");
}

/** Does this set include an image? The vision gate asks before the upload. */
export function anyImage(pending: readonly PendingAttachment[]): boolean {
  return pending.some((entry) =>
    entry.status === "ready" || entry.status === "scanning"
      ? isImageType(entry.attachment.content_type)
      : isImageType(entry.local_type),
  );
}

// --- the scan -----------------------------------------------------------------

/** The `scan_status` values the server writes (api/matterwave/attachments.py). */
export const SCAN_SCANNING = "scanning";
export const SCAN_CLEAN = "clean";
export const SCAN_INFECTED = "infected";
export const SCAN_FAILED = "scan_failed";

/**
 * How often the chip asks after its scan. A clamd scan of a 20 MB file is
 * under a second; the poll is for the queue's latency, not the scan's.
 */
export const SCAN_POLL_MS = 1500;
/** Give up asking after this many polls (90 s) and let the person retry. */
export const SCAN_POLL_LIMIT = 60;

/**
 * What the chip says for a file the scanner removed. One sentence and no
 * signature name: a name is a hint about which payload got through the door.
 */
export const SCAN_BLOCKED_REASON = "Removed by malware scan.";
/** For a scan that could not run (the scanner was unreachable): retryable. */
export const SCAN_FAILED_REASON = "This file could not be scanned. Try again.";
/**
 * For a scan the composer stopped waiting on. The server keeps retrying it
 * in the background; the row is swept later if nothing attaches it.
 */
export const SCAN_TIMEOUT_REASON = "Scanning is taking longer than expected. Try again.";

/** `GET /api/attachments/{id}/scan`: one word about one of the person's own uploads. */
export async function fetchScanStatus(attachmentId: string): Promise<string> {
  const body = await apiGet<{ scan_status: string }>(
    `/api/attachments/${encodeURIComponent(attachmentId)}/scan`,
  );
  return body.scan_status;
}

/**
 * The image types the server's allowlist accepts (`sniff.IMAGE_TYPES`).
 *
 * Duplicated from the server deliberately and narrowly: this decides which
 * icon to draw and whether to ask the vision question *before* uploading, and
 * both of those have to happen with no round trip. It is not the allowlist
 * that decides acceptance -- `ACCEPTED_TYPES` below is, and the server's copy
 * overrides both.
 */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const DOCUMENT_TYPES = ["application/pdf", "text/plain", "text/markdown"] as const;

/** Mirrors `sniff.ALLOWED`. See the note above on why a copy exists. */
export const ACCEPTED_TYPES: readonly string[] = [...IMAGE_TYPES, ...DOCUMENT_TYPES];

/**
 * The `accept` attribute for the file input.
 *
 * Extensions as well as types: a `.md` file has no registered MIME type on
 * Windows, so a types-only `accept` hides Markdown files from the picker
 * entirely -- the user sees an empty folder and concludes the app is broken.
 */
export const ACCEPT_ATTRIBUTE = [...ACCEPTED_TYPES, ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".txt", ".md", ".markdown"].join(",");

export function isImageType(contentType: string): boolean {
  return (IMAGE_TYPES as readonly string[]).includes(contentType.toLowerCase());
}

/**
 * `File.type`, patched for the cases the OS gets wrong.
 *
 * Markdown and some plain-text files arrive with `type: ""` on Windows (no
 * registry entry) or as `text/markdown` only on browsers that know the
 * extension. An empty type is not evidence of anything, so the extension is
 * consulted rather than treating "" as a refusal -- and the server re-decides
 * from the bytes either way.
 */
export function localTypeOf(file: File): string {
  const declared = (file.type || "").toLowerCase();
  if (declared !== "") return declared;
  const name = file.name.toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "text/markdown";
  if (name.endsWith(".txt")) return "text/plain";
  return "";
}

/** `1536` -> `1.5 KB`. Mirrors the server's `_human_size` wording. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10, none above: "9.4 MB" is useful, "943.7 MB" is noise.
  const shown = value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value).toString();
  return `${shown} ${units[unit]}`;
}

/**
 * The client-side refusal, or null if this file may be uploaded.
 *
 * `limits` is the API's answer, not a constant -- that is the whole reason
 * `/api/attachments/limits/me` exists ("the client and server cannot
 * disagree"). When the limits have not loaded yet, the size checks are
 * SKIPPED rather than guessed: refusing a file against a number we invented
 * would be the exact failure the endpoint exists to prevent, and the server
 * still answers 413.
 */
export function precheck(file: File, limits: AttachmentLimits | null): string | null {
  if (file.size === 0) {
    return `“${file.name}” is empty.`;
  }
  const type = localTypeOf(file);
  // An unknown type is NOT refused: `File.type` is the OS's guess and it is
  // empty for ordinary files on ordinary machines. Only a type the OS states
  // positively and that is not on the allowlist is refused here, because that
  // is the only case where the client knows something.
  if (type !== "" && !ACCEPTED_TYPES.includes(type)) {
    return `“${file.name}” is not a kind of file MatterWave accepts. Images (PNG, JPEG, GIF, WebP), PDF, plain text and Markdown are.`;
  }
  if (limits === null) return null;
  if (file.size > limits.max_upload_bytes) {
    return `“${file.name}” is ${humanSize(file.size)}, over the ${humanSize(limits.max_upload_bytes)} limit for one file.`;
  }
  if (file.size > limits.quota_remaining_bytes) {
    return `“${file.name}” is ${humanSize(file.size)} and you have ${humanSize(limits.quota_remaining_bytes)} left of your ${humanSize(limits.quota_bytes)} attachment quota.`;
  }
  return null;
}

export function loadLimits(): Promise<AttachmentLimits> {
  return apiGet<AttachmentLimits>("/api/attachments/limits/me");
}

async function apiGet<T>(path: string): Promise<T> {
  const { apiFetch } = await import("../../lib/api");
  return apiFetch<T>(path);
}

/**
 * Upload one file, reporting progress.
 *
 * `XMLHttpRequest`, not `fetch`. This is the one place in the SPA that does
 * not use `apiFetch`, and the reason is specific: `fetch` cannot report
 * upload progress. There is no `onprogress` for a request body -- the
 * Streams-based workaround needs `duplex: "half"`, which Safari does not
 * support and which several proxies reject outright. A 5 MB screenshot on a
 * slow link takes tens of seconds, and a UI with no progress during that is
 * indistinguishable from a frozen one, which is this step's requirement.
 * So: XHR, which has had `upload.onprogress` since 2008.
 *
 * The CSRF header and credentials are set the same way `apiFetch` sets them,
 * read from the same cookie, so this does not become a second auth story.
 */
export function uploadAttachment(options: {
  file: File;
  conversationId: string | null;
  csrfCookieName: string;
  bearerToken: string | null;
  onProgress: (percent: number) => void;
}): { promise: Promise<UploadedAttachment>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadedAttachment>((resolve, reject) => {
    const query =
      options.conversationId === null
        ? ""
        : `?conversation_id=${encodeURIComponent(options.conversationId)}`;
    xhr.open("POST", `/api/attachments${query}`, true);
    xhr.withCredentials = true;
    if (options.bearerToken) {
      xhr.setRequestHeader("Authorization", `Bearer ${options.bearerToken}`);
    }
    const csrf = readCookie(options.csrfCookieName);
    if (csrf) xhr.setRequestHeader("X-CSRF-Token", csrf);
    // No Content-Type header: the browser must set it, because only the
        // browser knows the multipart boundary it generated.

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      // Capped at 99: the bytes being on the wire is not the upload being
      // done. The server still has to sniff, scan, hash and write, and a bar
      // that sits at 100% for three seconds reads as a hang.
      const percent = Math.min(99, Math.round((event.loaded / event.total) * 100));
      options.onProgress(percent);
    };

    xhr.onload = () => {
      if (xhr.status === 201 || xhr.status === 200) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadedAttachment);
        } catch {
          reject(new ApiError(xhr.status, "The upload succeeded but its reply was unreadable."));
        }
        return;
      }
      reject(new ApiError(xhr.status, uploadFailureText(xhr.responseText, xhr.status)));
    };
    // A dropped connection and a blocked request are indistinguishable from
    // here by design (the browser withholds the detail), so both get the
    // wording that is true of each.
    xhr.onerror = () =>
      reject(new ApiError(0, "The upload could not reach the server. Your message is still here."));
    xhr.ontimeout = () => reject(new ApiError(0, "The upload timed out."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));

    const body = new FormData();
    body.append("file", options.file, options.file.name);
    xhr.send(body);
  });
  return { promise, abort: () => xhr.abort() };
}

/**
 * The server's `detail`, or a sentence for the status.
 *
 * The server's own strings are good here and are the ones to show: it is the
 * authority on why it refused and it names the real cap ("larger than the
 * 10 MB limit"). The fallbacks exist for a refusal from something that is not
 * the app -- a proxy's 413 HTML page, which has no `detail`.
 *
 * A server error's detail is not one of those: "Internal server error" is
 * the server describing itself, not the file, so a 5xx gets a sentence that
 * says what the person can do.
 */
export function uploadFailureText(responseText: string, status: number): string {
  if (status === 503) return "Attachments are not available on this deployment right now.";
  if (status >= 500) return "The server could not take that file. Try again in a moment.";
  try {
    const parsed = JSON.parse(responseText) as { detail?: unknown };
    if (typeof parsed.detail === "string" && parsed.detail !== "") return parsed.detail;
  } catch {
    // Not JSON: a proxy answered, not the API.
  }
  if (status === 413) return "That file is too large to upload.";
  if (status === 415) return "That file type is not accepted.";
  if (status === 403) return "You are not allowed to upload that.";
  return `The upload failed (${status}).`;
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const entry = document.cookie.split("; ").find((c) => c.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
}

/**
 * The files a paste carries, or an empty list.
 *
 * Paste is the path that matters most: a screenshot taken with
 * Win+Shift+S or Cmd+Ctrl+Shift+4 exists only on the clipboard, and pasting
 * it is the only way to attach it without saving it to disk first.
 *
 * The filter is the subtlety. A clipboard with text in it also carries
 * `text/plain` items, and reading those as files would turn every ordinary
 * Ctrl+V of copied text into a .txt attachment. Only items whose `kind` is
 * `"file"` are files; everything else is for the textarea, which must keep
 * its default behaviour.
 */
export function filesFromPaste(clipboard: DataTransfer | null): File[] {
  if (!clipboard) return [];
  const out: File[] = [];
  for (const item of Array.from(clipboard.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

/**
 * A screenshot pasted from the clipboard has no filename -- Chrome calls it
 * `image.png`, Safari calls it `image.png` too, and Firefox gives an empty
 * string. A timestamp makes the chips distinguishable when several are pasted.
 */
export function namedForPaste(file: File, now = new Date()): File {
  const generic = file.name === "" || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
  if (!generic) return file;
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const extension = extensionFor(file.type) ?? "png";
  return new File([file], `pasted-${stamp}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

function extensionFor(type: string): string | null {
  switch (type.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

/**
 * Does this drag carry files?
 *
 * Read from `types`, not from `items`: during `dragover` the browser
 * deliberately withholds the file list (it is not readable until drop, so a
 * page cannot inventory a user's files on hover), but `types` contains
 * `"Files"` throughout. A handler that waits for readable items never shows
 * a drop target at all.
 */
export function dragHasFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  return Array.from(transfer.types).includes("Files");
}

let keyCounter = 0;

/** A stable client-side key for one pending attachment. */
export function nextKey(): string {
  keyCounter += 1;
  return `pending-${keyCounter}`;
}
