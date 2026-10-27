/**
 * The composer's attachment state.
 *
 * Holds the list of pending attachments, runs their uploads, and owns the two
 * refusals that happen before a byte leaves the machine: the vision gate and
 * the client-side size/type pre-check.
 *
 * ## It cannot touch the draft
 *
 * This hook is given no access to the typed text and no callback that could
 * clear it. That is the structural half of "never lose the user's text": the
 * draft lives in `ThreadView`, is cleared on exactly one line in the send
 * handler, and that line is reached only after the ids are already in hand.
 * Every failure here ends as a `failed` entry or a `notice` string, both of
 * which render *beside* the textarea. There is no path from an upload failure
 * to the draft because there is no reference to it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  type AttachmentLimits,
  type PendingAttachment,
  SCAN_BLOCKED_REASON,
  SCAN_CLEAN,
  SCAN_FAILED,
  SCAN_FAILED_REASON,
  SCAN_INFECTED,
  SCAN_POLL_LIMIT,
  SCAN_POLL_MS,
  SCAN_SCANNING,
  SCAN_TIMEOUT_REASON,
  type UploadedAttachment,
  fetchScanStatus,
  isImageType,
  loadLimits,
  localTypeOf,
  namedForPaste,
  nextKey,
  precheck,
  uploadAttachment,
} from "./attachments";

/** How many attachments one message may carry; mirrors the API's `max_length=10`. */
export const MAX_ATTACHMENTS = 10;

export interface UseAttachmentsOptions {
  /** The conversation the uploads belong to; null before it is created. */
  conversationId: string | null;
  /** The CSRF cookie name, from auth-config. */
  csrfCookieName: string;
  /** The bearer token, when the deployment uses one. */
  bearerToken: string | null;
  /**
   * Asked before a file is accepted, so an image for a text-only model is
   * refused while choosing. Returns a refusal sentence, or null to allow.
   */
  guard?: (files: readonly File[]) => string | null;
}

export interface UseAttachments {
  pending: readonly PendingAttachment[];
  /** The caps, from the API. Null until loaded; never guessed. */
  limits: AttachmentLimits | null;
  /** False when this deployment has no attachment store: hide the control. */
  available: boolean;
  /** A refusal to show above the composer, or null. */
  notice: string | null;
  dismissNotice: () => void;
  /** Add files from the button, a drop or a paste. */
  add: (files: readonly File[], options?: { fromPaste?: boolean }) => void;
  /** Remove one entry, aborting its upload if it is still running. */
  remove: (key: string) => void;
  /** Re-run a failed upload with the file the user already chose. */
  retry: (key: string) => void;
  /** Called after a successful send: the ids are the message's now. */
  clear: () => void;
}

export function useAttachments(options: UseAttachmentsOptions): UseAttachments {
  const [pending, setPending] = useState<readonly PendingAttachment[]>([]);
  const [limits, setLimits] = useState<AttachmentLimits | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The options the async upload callbacks read. A ref rather than deps: an
  // upload started before the conversation existed must not be restarted
  // because `conversationId` changed under it mid-flight.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // Limits are loaded once per mount, and the load doubles as the feature
  // probe. A 503 means this deployment has no Postgres and therefore no
  // attachments at all (`require_attachment_store`), and a 404 means an API
  // that predates the route — in both cases the button is hidden rather than
  // offered and then failing, which is the one thing worse than its absence.
  //
  // Any other failure (a 500, a dropped connection) leaves `limits` null but
  // `available` true: the caps are unknown, so the pre-check skips the size
  // checks rather than guessing, and the server's 413 stays the authority. A
  // zero cap would refuse every file against a number nobody configured.
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    let alive = true;
    loadLimits()
      .then((loaded) => {
        if (alive) setLimits(loaded);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        const status = error instanceof ApiError ? error.status : 0;
        if (status === 503 || status === 404) setAvailable(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Object URLs are a real leak: one per image preview, held until revoked,
  // and a user who pastes twenty screenshots into one message holds twenty
  // decoded bitmaps. Revoked on remove, on clear and on unmount.
  const previewsRef = useRef(new Set<string>());
  const revoke = useCallback((url: string | undefined) => {
    if (url === undefined) return;
    previewsRef.current.delete(url);
    URL.revokeObjectURL(url);
  }, []);
  useEffect(() => {
    const urls = previewsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  // Aborts for the uploads in flight, so remove can cancel one.
  const abortsRef = useRef(new Map<string, () => void>());
  // The scan polls in flight, so remove, clear and unmount can stop one. A
  // poll that outlives its chip would set state on an entry that is gone.
  const scanTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const stopScanPoll = useCallback((key: string) => {
    const timer = scanTimersRef.current.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      scanTimersRef.current.delete(key);
    }
  }, []);
  useEffect(() => {
    const timers = scanTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /**
   * Ask the server about one upload's scan until it is decided.
   *
   * `scanning -> ready` on `clean`, `-> blocked` on `infected` (no retry: the
   * same bytes would be removed again), `-> failed` with a Retry when the
   * scan itself could not run or when this composer has waited long enough.
   * A poll that cannot reach the server is not a verdict and is simply
   * tried again; the limit is what ends it.
   */
  const pollScan = useCallback(
    (key: string, attachment: UploadedAttachment, file: File, preview: string | undefined) => {
      let polls = 0;
      const settle = (status: string) => {
        stopScanPoll(key);
        setPending((list) =>
          list.map((entry) => {
            if (entry.key !== key || entry.status !== "scanning") return entry;
            if (status === SCAN_CLEAN) {
              return { status: "ready" as const, key, attachment, preview };
            }
            if (status === SCAN_INFECTED) {
              return {
                status: "blocked" as const,
                key,
                filename: attachment.filename,
                size_bytes: attachment.size_bytes,
                local_type: attachment.content_type,
                reason: SCAN_BLOCKED_REASON,
                preview,
              };
            }
            return {
              status: "failed" as const,
              key,
              filename: attachment.filename,
              size_bytes: attachment.size_bytes,
              local_type: attachment.content_type,
              reason: status === SCAN_FAILED ? SCAN_FAILED_REASON : SCAN_TIMEOUT_REASON,
              file,
              preview,
            };
          }),
        );
      };
      const tick = () => {
        polls += 1;
        fetchScanStatus(attachment.id)
          .then((status) => {
            if (!scanTimersRef.current.has(key)) return; // removed meanwhile
            if (status !== SCAN_SCANNING) {
              settle(status);
            } else if (polls >= SCAN_POLL_LIMIT) {
              settle("timeout");
            } else {
              scanTimersRef.current.set(key, setTimeout(tick, SCAN_POLL_MS));
            }
          })
          .catch(() => {
            if (!scanTimersRef.current.has(key)) return;
            if (polls >= SCAN_POLL_LIMIT) settle("timeout");
            else scanTimersRef.current.set(key, setTimeout(tick, SCAN_POLL_MS));
          });
      };
      scanTimersRef.current.set(key, setTimeout(tick, SCAN_POLL_MS));
    },
    [stopScanPoll],
  );

  const previewFor = useCallback((file: File): string | undefined => {
    if (!isImageType(localTypeOf(file))) return undefined;
    try {
      const url = URL.createObjectURL(file);
      previewsRef.current.add(url);
      return url;
    } catch {
      // A browser that refuses the blob URL still gets a chip, just no image.
      return undefined;
    }
  }, []);

  /** Start one upload for an entry already in the list. */
  const startUpload = useCallback(
    (key: string, file: File, preview: string | undefined) => {
      const current = optionsRef.current;
      const { promise, abort } = uploadAttachment({
        file,
        conversationId: current.conversationId,
        csrfCookieName: current.csrfCookieName,
        bearerToken: current.bearerToken,
        onProgress: (percent) => {
          setPending((list) =>
            list.map((entry) =>
              entry.key === key && entry.status === "uploading"
                ? // Monotonic: a retried chunk can report a lower `loaded`,
                  // and a bar that goes backwards reads as a fault.
                  { ...entry, progress: Math.max(entry.progress, percent) }
                : entry,
            ),
          );
        },
      });
      abortsRef.current.set(key, abort);

      setPending((list) =>
        list.map((entry) =>
          entry.key === key && entry.status === "uploading" ? { ...entry, abort } : entry,
        ),
      );

      promise
        .then((attachment) => {
          abortsRef.current.delete(key);
          // A deployment that scans answers `scanning`; the chip waits on
          // the verdict. Any other status is final and the row is ready --
          // including an `infected` answered inline, which the send will
          // refuse and the chip reports as blocked below.
          const scanning = attachment.scan_status === SCAN_SCANNING;
          const infected = attachment.scan_status === SCAN_INFECTED;
          setPending((list) =>
            list.map((entry) => {
              if (entry.key !== key) return entry;
              if (scanning) return { status: "scanning" as const, key, attachment, file, preview };
              if (infected) {
                return {
                  status: "blocked" as const,
                  key,
                  filename: attachment.filename,
                  size_bytes: attachment.size_bytes,
                  local_type: attachment.content_type,
                  reason: SCAN_BLOCKED_REASON,
                  preview,
                };
              }
              if (attachment.scan_status === SCAN_FAILED) {
                return {
                  status: "failed" as const,
                  key,
                  filename: attachment.filename,
                  size_bytes: attachment.size_bytes,
                  local_type: attachment.content_type,
                  reason: SCAN_FAILED_REASON,
                  file,
                  preview,
                };
              }
              return { status: "ready" as const, key, attachment, preview };
            }),
          );
          if (scanning) pollScan(key, attachment, file, preview);
          // The quota moved. Re-reading it keeps the next pre-check honest
          // rather than letting the client's idea of "remaining" drift above
          // the server's for the rest of the session.
          setLimits((previous) =>
            previous === null
              ? previous
              : {
                  ...previous,
                  quota_used_bytes: previous.quota_used_bytes + attachment.size_bytes,
                  quota_remaining_bytes: Math.max(
                    previous.quota_remaining_bytes - attachment.size_bytes,
                    0,
                  ),
                },
          );
        })
        .catch((error: unknown) => {
          abortsRef.current.delete(key);
          if (error instanceof DOMException && error.name === "AbortError") {
            // The user removed it mid-upload; `remove` already dropped the
            // entry. Nothing to report — they know.
            return;
          }
          const reason =
            error instanceof Error && error.message !== ""
              ? error.message
              : "The upload failed.";
          setPending((list) =>
            list.map((entry) =>
              entry.key === key
                ? {
                    status: "failed" as const,
                    key,
                    filename: file.name,
                    size_bytes: file.size,
                    local_type: localTypeOf(file),
                    reason,
                    file,
                    preview,
                  }
                : entry,
            ),
          );
        });
    },
    [pollScan],
  );

  const add = useCallback(
    (files: readonly File[], addOptions?: { fromPaste?: boolean }) => {
      if (files.length === 0) return;
      const named = addOptions?.fromPaste === true ? files.map((f) => namedForPaste(f)) : files;

      // The vision gate runs FIRST and on the whole batch, before any
      // pre-check and before any upload. Step 6: a user who attaches an image
      // to a text-only model learns it while choosing.
      const refusal = optionsRef.current.guard?.(named);
      if (refusal !== null && refusal !== undefined) {
        setNotice(refusal);
        return;
      }

      setPending((list) => {
        const room = MAX_ATTACHMENTS - list.length;
        if (room <= 0) {
          setNotice(`A message can carry ${MAX_ATTACHMENTS} attachments. Send this one first.`);
          return list;
        }
        const accepted: PendingAttachment[] = [];
        const refusals: string[] = [];
        for (const file of named.slice(0, room)) {
          const problem = precheck(file, limits);
          if (problem !== null) {
            refusals.push(problem);
            continue;
          }
          const key = nextKey();
          const preview = previewFor(file);
          accepted.push({
            status: "uploading",
            key,
            filename: file.name,
            size_bytes: file.size,
            local_type: localTypeOf(file),
            progress: 0,
            abort: () => undefined,
            preview,
          });
          // Started outside the state updater's synchronous body would be
          // cleaner, but the upload has to be tied to the key just minted.
          // `startUpload` only calls setState asynchronously, so this is safe
          // under StrictMode's double-invoke: a second pass mints new keys and
          // the first pass's entries are discarded with the state it returned.
          queueMicrotask(() => startUpload(key, file, preview));
        }
        if (named.length > room) {
          refusals.push(
            `Only ${room} more attachment${room === 1 ? "" : "s"} fit on this message.`,
          );
        }
        setNotice(refusals.length > 0 ? refusals.join(" ") : null);
        return accepted.length > 0 ? [...list, ...accepted] : list;
      });
    },
    [limits, previewFor, startUpload],
  );

  const remove = useCallback(
    (key: string) => {
      const abort = abortsRef.current.get(key);
      if (abort) {
        abortsRef.current.delete(key);
        abort();
      }
      stopScanPoll(key);
      setPending((list) => {
        const entry = list.find((candidate) => candidate.key === key);
        revoke(entry?.preview);
        // A `ready` (or still-scanning) entry is deleted server-side too: it
        // is an uploaded blob the user has just said they do not want, and
        // leaving it to the sweeper would charge it against their quota in
        // the meantime. Fire-and-forget: the row is already out of this
        // message either way, and a failed DELETE is the sweeper's problem,
        // not the user's.
        if (entry?.status === "ready" || entry?.status === "scanning") {
          void deleteAttachment(entry.attachment.id);
        }
        return list.filter((candidate) => candidate.key !== key);
      });
    },
    [revoke, stopScanPoll],
  );

  const retry = useCallback(
    (key: string) => {
      setPending((list) => {
        const entry = list.find((candidate) => candidate.key === key);
        if (entry === undefined || entry.status !== "failed") return list;
        queueMicrotask(() => startUpload(key, entry.file, entry.preview));
        return list.map((candidate) =>
          candidate.key === key
            ? {
                status: "uploading" as const,
                key,
                filename: entry.filename,
                size_bytes: entry.size_bytes,
                local_type: entry.local_type,
                progress: 0,
                abort: () => undefined,
                preview: entry.preview,
              }
            : candidate,
        );
      });
      setNotice(null);
    },
    [startUpload],
  );

  const clear = useCallback(() => {
    // Previews are revoked, but the uploaded rows are NOT deleted: they belong
    // to the message that was just sent and the transcript renders them from
    // their ids.
    setPending((list) => {
      for (const entry of list) revoke(entry.preview);
      return [];
    });
    abortsRef.current.clear();
    for (const timer of scanTimersRef.current.values()) clearTimeout(timer);
    scanTimersRef.current.clear();
    setNotice(null);
  }, [revoke]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { pending, limits, available, notice, dismissNotice, add, remove, retry, clear };
}

async function deleteAttachment(id: string): Promise<void> {
  try {
    const { apiFetch } = await import("../../lib/api");
    await apiFetch(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    // The sweeper collects an unbound attachment on schedule. Reporting this
    // would tell the user about bookkeeping they did not ask about.
  }
}
