import { useCallback, useEffect, useId, useRef, useState, type DragEvent } from "react";
import { FileJsonIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Meter } from "../../../components/ui/alert";
import { StatusDot } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { LearnMore, PaneSection } from "../PaneSection";
import { Row, RowList } from "../rows";
import {
  IMPORT_ACCEPT,
  IMPORT_MAX_BYTES,
  IMPORT_POLL_MS,
  fetchImport,
  formatBytes,
  importFailureMessage,
  isActive,
  leftBehind,
  listImports,
  percentDone,
  startImport,
  summarize,
  SOURCE_NAMES,
  type ImportRecord,
} from "../importApi";

/**
 * Settings -> Data: bring conversations in from ChatGPT or Claude.
 *
 * Drop the export (or pick it), and the API says what it found and starts
 * the import in the background; this card polls the row and shows the
 * progress, then the result: how many conversations and messages came in,
 * what was already here, what was skipped, and what the import could not
 * carry (other branches, attachments). An import that is still running
 * when the page opens is picked up and followed, so leaving and coming
 * back loses nothing.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; filename: string }
  | { kind: "following"; record: ImportRecord }
  | { kind: "done"; record: ImportRecord }
  | { kind: "failed"; message: string };

export function ImportSection() {
  const { t } = useLingui();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [history, setHistory] = useState<ImportRecord[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const statusId = useId();

  // What ran before, and anything still running: the list is the record,
  // and a running row is followed from here.
  useEffect(() => {
    let alive = true;
    listImports()
      .then((rows) => {
        if (!alive) return;
        setHistory(rows);
        const running = rows.find(isActive);
        if (running) setPhase({ kind: "following", record: running });
      })
      .catch(() => {
        if (alive) setHistory([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Follow a running import until it ends.
  useEffect(() => {
    if (phase.kind !== "following") return;
    let alive = true;
    const timer = setTimeout(() => {
      fetchImport(phase.record.id)
        .then((record) => {
          if (!alive) return;
          if (isActive(record)) setPhase({ kind: "following", record });
          else {
            setPhase(
              record.status === "done"
                ? { kind: "done", record }
                : { kind: "failed", message: record.error ?? t`The import failed.` },
            );
            setHistory((rows) => [record, ...(rows ?? []).filter((r) => r.id !== record.id)]);
          }
        })
        .catch(() => {
          // A missed poll is not a failed import; ask again next tick.
          if (alive) setPhase({ kind: "following", record: phase.record });
        });
    }, IMPORT_POLL_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [phase, t]);

  const upload = useCallback(async (file: File) => {
    if (file.size > IMPORT_MAX_BYTES) {
      setPhase({ kind: "failed", message: t`That file is larger than the 100 MB limit.` });
      return;
    }
    setPhase({ kind: "uploading", filename: file.name });
    try {
      const record = await startImport(file);
      setHistory((rows) => [record, ...(rows ?? [])]);
      if (isActive(record)) setPhase({ kind: "following", record });
      else if (record.status === "done") setPhase({ kind: "done", record });
      else setPhase({ kind: "failed", message: record.error ?? t`The import failed.` });
    } catch (err) {
      setPhase({ kind: "failed", message: importFailureMessage(err) });
    }
  }, [t]);

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void upload(file);
  }

  const busy = phase.kind === "uploading" || phase.kind === "following";
  const maxSize = formatBytes(IMPORT_MAX_BYTES);

  return (
    <PaneSection
      title={t`Import conversations`}
      description={t`Bring your conversations here from ChatGPT or Claude.`}
      flush
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <LearnMore>
          <p>
            <Trans>
              Upload the conversations.json (or the whole zip) from ChatGPT's data export, or the
              JSON file from Claude's.
            </Trans>
          </p>
          <p>
            <Trans>
              Titles, timestamps and who said what are kept; a conversation with edits or
              regenerations comes in as the thread it last showed, with a note saying so;
              attachments are not in the exports and are counted, not copied. Importing the same
              file again adds nothing twice.
            </Trans>
          </p>
        </LearnMore>
        <div
          data-mw-import-drop={dragging ? "over" : "idle"}
          onDragOver={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={busy ? undefined : onDrop}
          // A dashed drop target, not a panel: the one edge inside the card
          // that says "a file can land here".
          className={`flex flex-col items-start gap-3 rounded-lg border border-dashed p-4 ${
            dragging ? "border-ring bg-mw-surface-hover" : "border-border-emphasis"
          }`}
        >
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={IMPORT_ACCEPT}
            className="sr-only"
            disabled={busy}
            aria-describedby={statusId}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}>
              {phase.kind === "uploading" ? t`Uploading…` : t`Choose export file`}
            </Button>
            <label htmlFor={inputId} className="text-sm text-mw-text-muted">
              <Trans>or drop it here. JSON or zip, up to {maxSize}.</Trans>
            </label>
          </div>

          {/* One polite live region for every state the import moves through. */}
          <div id={statusId} role="status" aria-live="polite" className="w-full text-sm">
            {phase.kind === "uploading" && <UploadingLine filename={phase.filename} />}
            {phase.kind === "following" && <Progress record={phase.record} />}
            {phase.kind === "done" && <Result record={phase.record} />}
          </div>
          {phase.kind === "failed" && (
            <p role="alert" data-mw-import-error="" className="text-sm text-mw-danger">
              {phase.message}
            </p>
          )}
        </div>
      </div>

      {history !== null && history.length > 0 && (
        <RowList aria-label={t`Previous imports`} className="border-t border-border">
          {history.slice(0, 5).map((record) => (
            <Row
              key={record.id}
              className="py-3"
              leading={<FileJsonIcon aria-hidden className="size-4 shrink-0 text-mw-text-muted" />}
              title={<span className="block truncate text-sm">{record.filename}</span>}
              meta={`${SOURCE_NAMES[record.source] ?? record.source} · ${formatBytes(record.size_bytes)}`}
              trailing={
                <span
                  data-mw-import-status={record.status}
                  className="inline-flex items-center gap-2 text-sm text-mw-text-secondary"
                >
                  <StatusDot tone={record.status === "failed" ? "danger" : isActive(record) ? "info" : "positive"} />
                  {record.status === "done" && <ImportedCount count={record.conversations_created} />}
                  {record.status === "failed" && t`Failed`}
                  {isActive(record) && t`Running`}
                </span>
              }
            />
          ))}
        </RowList>
      )}
    </PaneSection>
  );
}

function UploadingLine(props: { filename: string }) {
  const filename = props.filename;
  return (
    <span>
      <Trans>Uploading {filename}…</Trans>
    </span>
  );
}

function ImportedCount(props: { count: number }) {
  const count = props.count;
  return <Trans>{count} imported</Trans>;
}

function Progress(props: { record: ImportRecord }) {
  const { t } = useLingui();
  const { record } = props;
  const percent = percentDone(record);
  const total = record.conversations_total;
  const done = record.conversations_done;
  const source = SOURCE_NAMES[record.source] ?? record.source;
  const label =
    record.status === "pending"
      ? t`Found ${total} conversations in ${source}'s export. Waiting to start…`
      : t`Importing ${done} of ${total} conversations…`;
  return (
    <div data-mw-import-progress={record.status} className="flex flex-col gap-1">
      <span>{label}</span>
      {/* The meter is drawn, the progressbar role carries the number. */}
      <div
        role="progressbar"
        aria-label={t`Import progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="w-full max-w-md py-1"
      >
        <Meter value={percent} tone="brand" />
      </div>
    </div>
  );
}

function Result(props: { record: ImportRecord }) {
  const { record } = props;
  const notes = leftBehind(record);
  return (
    <div data-mw-import-result="" className="flex flex-col gap-1">
      <span className="font-medium">{summarize(record)}</span>
      {notes && <span className="text-mw-text-muted">{notes}</span>}
      {record.error && (
        <span data-mw-import-note="" className="text-mw-text-muted">
          {record.error}
        </span>
      )}
      <span className="text-mw-text-muted">
        <Trans>The conversations are in your list, each carrying a note of where it came from.</Trans>
      </span>
    </div>
  );
}
