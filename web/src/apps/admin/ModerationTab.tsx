import { useId, useState, type FormEvent } from "react";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../components/ui/table";
import { Input } from "../../components/ui/input";
import { SimpleSelect } from "../../components/ui/select";
import { formatNumber } from "../../i18n/format";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
import { failureMessage } from "../../shell/authForms";
import {
  fetchModerationFlags,
  fetchModerationUser,
  formatDate,
  type ModerationFlag,
  type ModerationUserRecord,
} from "./adminApi";
import {
  fetchReviewQueue,
  REVIEW_ACTIONS,
  reviewReport,
  type ReportStatus,
  type ReportedMessage,
  type ReviewAction,
  type ReviewRow,
} from "./enforcementApi";
import { shortId, useLoad } from "./useLoad";

/**
 * The operator's view of moderation: the report queue, the recent flags,
 * and one account's violation count.
 *
 * Message text appears in one place: the single message a reporter chose
 * to report, under a line saying why it is shown. A flag is a category and
 * a score, and shows none. The queue is oldest first on purpose -- the
 * escalation runbook states a time to first review, and the report that has
 * waited longest is the one that matters.
 *
 * Every review ends in a written note: the API requires the reviewer's own
 * words, so a report cannot be closed with nothing anyone can audit later.
 * The actions that touch an account -- warn, rate limit, suspend -- go
 * through the enforcement ladder, which writes the audit row and shows the
 * note to the person as the reason.
 */
export function ModerationTab() {
  const [subject, setSubject] = useState<string | null>(null);
  return (
    <div className="space-y-8">
      <ReportsQueue />
      <FlagsList onLookup={setSubject} />
      <UserLookup subject={subject} onSubjectChange={setSubject} />
    </div>
  );
}

const REPORT_VARIANT: Record<ReportStatus, "info" | "secondary" | "destructive"> = {
  open: "info",
  reviewed: "secondary",
  actioned: "destructive",
  dismissed: "secondary",
};

/** The status as a badge shows it. */
const STATUS_LABEL: Record<ReportStatus, MessageDescriptor> = {
  open: msg`open`,
  reviewed: msg`reviewed`,
  actioned: msg`actioned`,
  dismissed: msg`dismissed`,
};

/** The queue's list name and empty-state title, per status filter. */
const LIST_LABEL: Record<ReportStatus, MessageDescriptor> = {
  open: msg`Open reports`,
  reviewed: msg`Reviewed reports`,
  actioned: msg`Actioned reports`,
  dismissed: msg`Dismissed reports`,
};

const EMPTY_TITLE: Record<ReportStatus, MessageDescriptor> = {
  open: msg`No open reports`,
  reviewed: msg`No reviewed reports`,
  actioned: msg`No actioned reports`,
  dismissed: msg`No dismissed reports`,
};

/** The flag action as the provider recorded it. */
const FLAG_ACTION_LABEL: Record<string, MessageDescriptor> = {
  blocked: msg`blocked`,
  flagged: msg`flagged`,
};

function ReportsQueue() {
  const { t, i18n } = useLingui();
  const [status, setStatus] = useState<ReportStatus>("open");
  const [state, reload] = useLoad(() => fetchReviewQueue(status), status);
  const statusId = useId();
  const listLabel = i18n._(LIST_LABEL[status]);
  return (
    <section aria-labelledby="moderation-reports">
      <h3 id="moderation-reports" className="text-sm font-medium text-mw-text">
        <Trans>Review queue</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>
          Reports marked unsafe by the people who made them, oldest first. Each shows the one message the reporter
          chose to report and nothing around it, and closes with a written note. Warn, rate limit and suspend act on
          the account the conversation belongs to, through the ladder.
        </Trans>
      </p>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <label htmlFor={statusId}>
          <Trans>Status</Trans>
        </label>
        <SimpleSelect<ReportStatus>
          id={statusId}
          value={status}
          onValueChange={setStatus}
          options={[
            { value: "open", label: t({ message: "Open", context: "report status" }) },
            { value: "reviewed", label: t`Reviewed` },
            { value: "actioned", label: t`Actioned` },
            { value: "dismissed", label: t`Dismissed` },
          ]}
        />
      </div>
      <div className="mt-3">
        {state.phase === "loading" ? (
          <LoadingSkeleton rows={3} />
        ) : state.phase === "error" ? (
          <ErrorState title={t`Could not load reports`} message={state.message} onRetry={reload} />
        ) : state.data.length === 0 ? (
          <EmptyState
            title={i18n._(EMPTY_TITLE[status])}
            description={t`A report a user files appears here until a reviewer closes it.`}
          />
        ) : (
          <ul aria-label={listLabel} className="space-y-4">
            {state.data.map((report) => (
              <ReportCard key={report.id} report={report} onReviewed={reload} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ReportCard({ report, onReviewed }: { report: ReviewRow; onReviewed: () => void }) {
  const { t, i18n } = useLingui();
  const id = useId();
  const [action, setAction] = useState<ReviewAction>("dismiss");
  const [note, setNote] = useState("");
  const [hours, setHours] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = report.status === "open";
  const chosen = REVIEW_ACTIONS.find((a) => a.action === action)!;
  const timed = action === "limit" || action === "warn";
  const reportId = shortId(report.id);
  const filed = formatDate(report.created_at);
  const reporter = report.reporter_subject;
  const messageId = report.message_id ? shortId(report.message_id) : "";
  const reviewedOn = report.reviewed_at ? formatDate(report.reviewed_at) : "";
  const reviewer = report.reviewed_by ?? "—";
  const actionId = report.action_id ? shortId(report.action_id) : "";
  const actionLabel = i18n._(chosen.label);

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = note.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = Number(hours);
      await reviewReport(report.id, {
        action,
        note: text,
        ...(timed && hours.trim() && parsed > 0 ? { expires_in_hours: parsed } : {}),
      });
      onReviewed();
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className="rounded-xl border border-border bg-card p-5"
      aria-label={t`Report ${reportId}`}
      data-report-status={report.status}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-mw-text-muted">
          <Trans>Filed</Trans>
        </dt>
        <dd>
          <Trans>
            {filed} by <span className="font-mono text-xs">{reporter}</span>
          </Trans>
        </dd>
        <dt className="text-mw-text-muted">
          <Trans>Account</Trans>
        </dt>
        <dd className="font-mono text-xs">
          {report.owner_subject}
          {report.owner_subject === report.reporter_subject && (
            <span className="ml-2 font-sans text-mw-text-muted">
              <Trans>(their own conversation)</Trans>
            </span>
          )}
        </dd>
        <dt className="text-mw-text-muted">
          <Trans>Conversation</Trans>
        </dt>
        <dd className="font-mono text-xs text-mw-text-muted">
          {shortId(report.conversation_id)}
          {report.message_id && (
            <>
              {" · "}
              <Trans>msg {messageId}</Trans>
            </>
          )}
        </dd>
        <dt className="text-mw-text-muted">
          <Trans>Reporter&apos;s note</Trans>
        </dt>
        <dd className="whitespace-normal">
          {report.note ?? (
            <span className="text-mw-text-muted">
              <Trans>No note</Trans>
            </span>
          )}
        </dd>
        {!open && (
          <>
            <dt className="text-mw-text-muted">
              <Trans>Closed</Trans>
            </dt>
            <dd className="whitespace-normal">
              <Badge variant={REPORT_VARIANT[report.status]}>{i18n._(STATUS_LABEL[report.status])}</Badge>{" "}
              <Trans>
                {reviewedOn} by <span className="font-mono text-xs">{reviewer}</span>
              </Trans>
              {report.resolution && <>: {report.resolution}</>}
              {report.action_id && (
                <span className="ml-2 font-mono text-xs">
                  <Trans>action {actionId}</Trans>
                </span>
              )}
            </dd>
          </>
        )}
      </dl>
      <ReportedMessageView message={report.message} />
      {open && (
        <form onSubmit={review} className="mt-3 space-y-2" aria-label={t`Review report ${reportId}`}>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor={`${id}-action`}>
                <Trans>Decision</Trans>
              </label>
              <SimpleSelect<ReviewAction>
                id={`${id}-action`}
                value={action}
                disabled={busy}
                onValueChange={setAction}
                options={REVIEW_ACTIONS.map((a) => ({ value: a.action, label: i18n._(a.label) }))}
              />
            </div>
            {timed && (
              <label htmlFor={`${id}-hours`} className="flex flex-col gap-1 text-sm">
                <Trans>Ends in hours (optional)</Trans>
                <Input
                  id={`${id}-hours`}
                  type="number"
                  min={1}
                  step={1}
                  value={hours}
                  disabled={busy}
                  onChange={(event) => setHours(event.target.value)}
                  className="w-32"
                />
              </label>
            )}
          </div>
          <p className="text-xs text-mw-text-muted">{i18n._(chosen.description)}</p>
          <Input
            aria-label={t`Note for report ${reportId}`}
            placeholder={
              action === "dismiss" || action === "note"
                ? t`What was decided, in your words`
                : t`The reason the account will read`
            }
            value={note}
            maxLength={2000}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              variant={action === "suspend" ? "destructive" : "outline"}
              disabled={busy || !note.trim()}
            >
              <Trans>
                {actionLabel} {reportId}
              </Trans>
            </Button>
            {error && (
              <p role="alert" className="text-xs text-mw-danger">
                {error}
              </p>
            )}
          </div>
        </form>
      )}
    </li>
  );
}

/**
 * The one reported message, with the consent line that explains why a
 * reviewer is seeing text at all. Null for a report of a whole conversation,
 * and an explicit "purged" state for a message that has since gone -- the
 * report outlives the content on purpose.
 */
function ReportedMessageView({ message }: { message: ReportedMessage | null }) {
  if (message === null) {
    return (
      <p className="mt-3 text-xs text-mw-text-muted">
        <Trans>The whole conversation was reported, not one message. No text is shown: nothing was singled out.</Trans>
      </p>
    );
  }
  if (!message.available) {
    return (
      <p className="mt-3 text-xs text-mw-text-muted">
        <Trans>The reported message has since been deleted or purged. The report stands; its text does not.</Trans>
      </p>
    );
  }
  return (
    <figure className="mt-3 rounded-md border border-mw-border bg-mw-surface-raised p-3" data-testid="reported-message">
      <figcaption className="text-xs text-mw-text-muted">
        <Trans>
          The one message the reporter chose to report, shown because they reported it. The rest of the
          conversation is not shown to anyone.
        </Trans>{" "}
        <span className="font-mono">
          {message.role}
          {message.model ? ` · ${message.model}` : ""}
        </span>
      </figcaption>
      <blockquote className="mt-2 whitespace-pre-wrap text-sm text-mw-text">{message.text}</blockquote>
    </figure>
  );
}

function FlagsList({ onLookup }: { onLookup: (subject: string) => void }) {
  const { t, i18n } = useLingui();
  const [state, reload] = useLoad(fetchModerationFlags, "flags");
  return (
    <section aria-labelledby="moderation-flags">
      <h3 id="moderation-flags" className="text-sm font-medium text-mw-text">
        <Trans>Recent flags</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>
          What the screening provider flagged, newest first: the category and score, and whether the prompt was
          blocked or only counted. No text is stored, so none is shown.
        </Trans>
      </p>
      <div className="mt-3">
        {state.phase === "loading" ? (
          <LoadingSkeleton rows={3} />
        ) : state.phase === "error" ? (
          <ErrorState
            title={t({ message: "Could not load flags", context: "moderation" })}
            message={state.message}
            onRetry={reload}
          />
        ) : state.data.length === 0 ? (
          <EmptyState
            title={t`Nothing flagged`}
            description={t`Either nothing has tripped the screen, or screening is off; the Health tab says which.`}
          />
        ) : (
          <Table className="bg-card" aria-label={t`Recent flags`}>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Trans>When</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Account</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Category</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Score</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Action</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Provider</Trans>
                </TableHead>
                <TableHead>
                  <span className="sr-only">
                    <Trans>Lookup</Trans>
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data.map((flag: ModerationFlag) => {
                const owner = flag.owner_subject;
                const actionLabel = FLAG_ACTION_LABEL[flag.action];
                return (
                <TableRow key={flag.id} className="border-b border-mw-border">
                  <TableCell>{formatDate(flag.created_at)}</TableCell>
                  <TableCell className="font-mono text-xs">{flag.owner_subject}</TableCell>
                  <TableCell>{flag.category}</TableCell>
                  <TableCell>{flag.score === null
                      ? "—"
                      : formatNumber(flag.score, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</TableCell>
                  <TableCell>
                    <Badge variant={flag.action === "blocked" ? "destructive" : "warning"}>
                      {actionLabel ? i18n._(actionLabel) : flag.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-mw-text-muted">{flag.provider}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => onLookup(flag.owner_subject)}>
                      <Trans>Violations for {owner}</Trans>
                    </Button>
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

function UserLookup({
  subject,
  onSubjectChange,
}: {
  subject: string | null;
  onSubjectChange: (subject: string) => void;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [state, reload] = useLoad(
    () => (subject ? fetchModerationUser(subject) : Promise.resolve(null)),
    subject,
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.trim()) onSubjectChange(draft.trim());
  }

  return (
    <section aria-labelledby="moderation-user">
      <h3 id="moderation-user" className="text-sm font-medium text-mw-text">
        <Trans>Violations by account</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>
          Flags inside the decay window for one subject. The threshold is advisory: suspension is a human decision
          with a written reason, made on the Users tab.
        </Trans>
      </p>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2" role="search">
        <label htmlFor={inputId} className="sr-only">
          <Trans>Subject</Trans>
        </label>
        <Input
          id={inputId}
          name="subject"
          placeholder={t`Subject`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="max-w-sm font-mono text-xs"
        />
        <Button type="submit" variant="outline">
          <Trans>Look up</Trans>
        </Button>
      </form>
      {subject && (
        <div className="mt-3">
          {state.phase === "loading" ? (
            <LoadingSkeleton rows={1} />
          ) : state.phase === "error" ? (
            <ErrorState title={t`Could not look up ${subject}`} message={state.message} onRetry={reload} />
          ) : state.data ? (
            <ViolationSummary record={state.data} />
          ) : null}
        </div>
      )}
    </section>
  );
}

function ViolationSummary({ record }: { record: ModerationUserRecord }) {
  const { t } = useLingui();
  const subject = record.subject;
  const violations = record.violations;
  const threshold = record.threshold;
  const days = record.window_days;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-label={t`Violations for ${subject}`}>
      <dt className="text-mw-text-muted">
        <Trans>Subject</Trans>
      </dt>
      <dd className="font-mono text-xs">{record.subject}</dd>
      <dt className="text-mw-text-muted">
        <Trans>Violations</Trans>
      </dt>
      <dd>
        {plural(days, {
          one: `${violations} in the last # day`,
          other: `${violations} in the last # days`,
        })}
        {record.over_threshold ? (
          <Badge variant="destructive" className="ml-2">
            <Trans>over threshold of {threshold}</Trans>
          </Badge>
        ) : (
          <span className="ml-2 text-mw-text-muted">
            <Trans>threshold {threshold}</Trans>
          </span>
        )}
      </dd>
    </dl>
  );
}
