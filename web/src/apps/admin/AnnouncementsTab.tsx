import { useId, useState, type FormEvent } from "react";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SimpleSelect } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { DestructiveConfirm, EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
import { failureMessage } from "../../shell/authForms";
import {
  MAX_ANNOUNCEMENT_LENGTH,
  createAnnouncement,
  deleteAnnouncement,
  endAnnouncement,
  fetchAnnouncements,
  fromLocalInput,
  toLocalInput,
  updateAnnouncement,
  type AdminAnnouncement,
  type AnnouncementDraft,
  type AnnouncementSeverity,
} from "./announcementsApi";
import { useLoad } from "./useLoad";

/**
 * Announcements every signed-in user sees as a banner while they are inside
 * their window: post one, edit it, end it now. Ending keeps the row, so the
 * table still says what was announced and when; delete removes it.
 *
 * A critical announcement cannot be dismissed by the people who see it --
 * the API forces that, and the form says so rather than offering a switch
 * that would be ignored.
 */
export function AnnouncementsTab() {
  const [state, reload] = useLoad(fetchAnnouncements, "announcements");
  return (
    <div className="space-y-6">
      <p className="text-sm text-mw-text-muted">
        Shown above the app to everyone signed in, most severe first, from its start until its end. Users see a change
        within two minutes.
      </p>
      <AnnouncementForm onSaved={reload} />
      {state.phase === "loading" ? (
        <LoadingSkeleton rows={3} />
      ) : state.phase === "error" ? (
        <ErrorState title="Could not load announcements" message={state.message} onRetry={reload} />
      ) : state.data.length === 0 ? (
        <EmptyState title="No announcements yet" description="Post one above." />
      ) : (
        <ul className="space-y-3" aria-label="Announcements">
          {state.data.map((row) => (
            <AnnouncementRow key={row.id} row={row} onChanged={reload} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Date and time: a maintenance window is hours, not days. */
function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

const STATE_VARIANT = {
  active: "positive",
  scheduled: "info",
  ended: "secondary",
} as const;

const SEVERITY_VARIANT = {
  info: "info",
  warning: "warning",
  critical: "destructive",
} as const;

function AnnouncementRow({ row, onChanged }: { row: AdminAnnouncement; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setConfirmDelete(false);
      onChanged();
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={SEVERITY_VARIANT[row.severity]}>{row.severity}</Badge>
        <Badge variant={STATE_VARIANT[row.state]}>{row.state}</Badge>
        {!row.dismissible && <span className="text-xs text-mw-text-muted">not dismissible</span>}
        <span className="ml-auto text-xs text-mw-text-muted">
          {when(row.starts_at)} – {row.ends_at ? when(row.ends_at) : "until ended"} · by {row.updated_by}
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm text-mw-text">{row.message}</p>
      {row.link && <p className="break-all font-mono text-xs text-mw-text-muted">{row.link}</p>}
      {error && (
        <Alert role="alert" variant="danger">
          {error}
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing((v) => !v)}>
          {editing ? "Close editor" : "Edit"}
        </Button>
        {row.state !== "ended" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => endAnnouncement(row.id))}>
            End now
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </Button>
      </div>
      {editing && (
        <AnnouncementForm
          existing={row}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
      <DestructiveConfirm
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmDelete(false);
        }}
        title="Delete this announcement?"
        description="It disappears from every banner and from this list. End it instead to keep the record."
        confirmLabel="Delete"
        inFlight={busy}
        onConfirm={() => void run(() => deleteAnnouncement(row.id))}
      />
    </li>
  );
}

function draftOf(row: AdminAnnouncement | undefined): AnnouncementDraft {
  return {
    message: row?.message ?? "",
    severity: row?.severity ?? "info",
    link: row?.link ?? null,
    starts_at: row?.starts_at ?? null,
    ends_at: row?.ends_at ?? null,
    dismissible: row?.dismissible ?? true,
  };
}

const SEVERITY_OPTIONS: { value: AnnouncementSeverity; label: string }[] = [
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "critical", label: "Critical" },
];

function AnnouncementForm({ existing, onSaved }: { existing?: AdminAnnouncement; onSaved: () => void }) {
  const id = useId();
  const [draft, setDraft] = useState<AnnouncementDraft>(() => draftOf(existing));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const critical = draft.severity === "critical";

  function update(patch: Partial<AnnouncementDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setStatus(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.message.trim()) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const body = { ...draft, link: draft.link?.trim() || null, dismissible: draft.dismissible && !critical };
      if (existing) {
        await updateAnnouncement(existing.id, body);
      } else {
        await createAnnouncement(body);
        setDraft(draftOf(undefined));
        setStatus("Announcement posted.");
      }
      onSaved();
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      aria-label={existing ? "Edit announcement" : "New announcement"}
      className="space-y-3 rounded-xl border border-border bg-card p-5"
    >
      {!existing && <h3 className="text-sm font-medium text-mw-text">New announcement</h3>}
      <label htmlFor={`${id}-message`} className="flex flex-col gap-1 text-sm">
        Message
        <Textarea
          id={`${id}-message`}
          value={draft.message}
          maxLength={MAX_ANNOUNCEMENT_LENGTH}
          required
          disabled={busy}
          onChange={(e) => update({ message: e.target.value })}
        />
        <span className="text-xs text-mw-text-muted">
          Plain text, {draft.message.length}/{MAX_ANNOUNCEMENT_LENGTH}
        </span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${id}-severity`}>Severity</label>
          <SimpleSelect<AnnouncementSeverity>
            id={`${id}-severity`}
            value={draft.severity}
            disabled={busy}
            onValueChange={(severity) => update({ severity })}
            options={SEVERITY_OPTIONS}
            className="w-full"
          />
        </div>
        <label htmlFor={`${id}-link`} className="flex flex-col gap-1 text-sm">
          Link (optional)
          <Input
            id={`${id}-link`}
            value={draft.link ?? ""}
            placeholder="https://status.example.com or /help"
            maxLength={2000}
            disabled={busy}
            onChange={(e) => update({ link: e.target.value })}
          />
        </label>
        <label htmlFor={`${id}-starts`} className="flex flex-col gap-1 text-sm">
          Starts
          <Input
            id={`${id}-starts`}
            type="datetime-local"
            value={toLocalInput(draft.starts_at)}
            disabled={busy}
            onChange={(e) => update({ starts_at: fromLocalInput(e.target.value) })}
          />
          {!existing && <span className="text-xs text-mw-text-muted">Empty: now.</span>}
        </label>
        <label htmlFor={`${id}-ends`} className="flex flex-col gap-1 text-sm">
          Ends
          <Input
            id={`${id}-ends`}
            type="datetime-local"
            value={toLocalInput(draft.ends_at)}
            disabled={busy}
            onChange={(e) => update({ ends_at: fromLocalInput(e.target.value) })}
          />
          <span className="text-xs text-mw-text-muted">Empty: until someone ends it.</span>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.dismissible && !critical}
          disabled={busy || critical}
          onChange={(e) => update({ dismissible: e.target.checked })}
        />
        People can dismiss it on their device
        {critical && <span className="text-xs text-mw-text-muted">(never, for a critical one)</span>}
      </label>
      {error && (
        <Alert role="alert" variant="danger">
          {error}
        </Alert>
      )}
      {status && (
        <p role="status" className="text-sm text-mw-text-muted">
          {status}
        </p>
      )}
      <Button type="submit" size="sm" disabled={busy || !draft.message.trim()}>
        {existing ? "Save" : "Post announcement"}
      </Button>
    </form>
  );
}
