import { Badge, StatusDot } from "../../components/ui/badge";
import { ErrorState, LoadingSkeleton } from "../../patterns";
import { fetchAttachmentScans, fetchHealth, type AdminHealth } from "./adminApi";
import { useLoad } from "./useLoad";

/**
 * What is deployed and whether it can do its job, on one page.
 *
 * The questions after a deploy, in the order they get asked: is this the
 * build I think it is (version, revision, release), did the migration
 * step run (the applied level against the latest file in the image), can
 * the gateway be reached, and which optional capabilities are actually
 * switched on. Every row states the fix when it is off, because "false"
 * on its own sends the operator to the config to find out which variable.
 */
export function HealthTab() {
  const [state, reload] = useLoad(fetchHealth, "health");
  if (state.phase === "loading") return <LoadingSkeleton rows={6} />;
  if (state.phase === "error") {
    return <ErrorState title="Could not load system health" message={state.message} onRetry={reload} />;
  }
  const health = state.data;
  return (
    <div className="space-y-8">
      <Build health={health} />
      <Dependencies health={health} />
      <Capabilities health={health} />
      <AttachmentScanning />
    </div>
  );
}

/**
 * The malware scanner and what it has decided. Its own load: the counts come
 * from the attachments table, which an environment without Postgres does
 * not have, and that must not take the rest of the page down with it.
 */
function AttachmentScanning() {
  const [state] = useLoad(fetchAttachmentScans, "attachment-scans");
  if (state.phase !== "ready") return null;
  const { scanner, counts } = state.data;
  const on = scanner !== "none";
  return (
    <section aria-labelledby="health-scanning">
      <h3 id="health-scanning" className="text-sm font-medium text-mw-text">
        Attachment scanning
      </h3>
      <ul className="mt-3 space-y-2" aria-label="Attachment scanning">
        <Check
          ok={on}
          label="Malware scanner"
          detail={
            on
              ? `Uploads are scanned by ${scanner} before they can be read.`
              : "MW_ATTACHMENT_SCANNER is none: uploads are served without being scanned."
          }
          offLabel="off"
        />
        <Check
          ok={counts.scan_failed === 0}
          label="Scans waiting on a verdict"
          detail={`${counts.scanning} scanning, ${counts.scan_failed} could not be scanned and will be retried.`}
          offLabel="retrying"
        />
        <Check
          ok={true}
          label="Decided"
          detail={`${counts.clean} clean, ${counts.infected} quarantined (never served).`}
        />
      </ul>
    </section>
  );
}

function Build({ health }: { health: AdminHealth }) {
  return (
    <section aria-labelledby="health-build">
      <h3 id="health-build" className="text-sm font-medium text-mw-text">
        Build
      </h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-label="Build">
        <dt className="text-mw-text-muted">Version</dt>
        <dd>{health.version}</dd>
        <dt className="text-mw-text-muted">Revision</dt>
        <dd className="font-mono text-xs">{health.revision}</dd>
        <dt className="text-mw-text-muted">Release</dt>
        <dd className="font-mono text-xs">{health.release}</dd>
      </dl>
    </section>
  );
}

function Dependencies({ health }: { health: AdminHealth }) {
  const { database, upstream } = health;
  const migrated = database.configured && database.pending_migrations.length === 0;
  return (
    <section aria-labelledby="health-dependencies">
      <h3 id="health-dependencies" className="text-sm font-medium text-mw-text">
        Dependencies
      </h3>
      <ul className="mt-3 space-y-2" aria-label="Dependencies">
        <Check
          ok={upstream.status === "ok"}
          label="Model gateway"
          detail={
            upstream.status === "ok"
              ? `Reachable, ${upstream.models ?? 0} models listed.`
              : (upstream.detail ?? "Not reachable. History and settings still work; chat does not.")
          }
        />
        <Check
          ok={database.configured}
          label="Database"
          detail={
            database.configured
              ? `Postgres is configured; migration ${database.migration ?? "none"} applied.`
              : "MW_DATABASE_URL is not set. Keys, budgets, members and moderation all answer 503."
          }
        />
        {database.configured && (
          <Check
            ok={migrated}
            label="Migrations"
            detail={
              migrated
                ? `Up to date at ${database.latest_migration}.`
                : `Pending: ${database.pending_migrations.join(", ")}. The image carries ${database.latest_migration}; run the migrate step.`
            }
          />
        )}
      </ul>
    </section>
  );
}

function Capabilities({ health }: { health: AdminHealth }) {
  return (
    <section aria-labelledby="health-capabilities">
      <h3 id="health-capabilities" className="text-sm font-medium text-mw-text">
        Capabilities
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        Off is the shipped state for each of these. On means a credential exists, not that it works.
      </p>
      <ul className="mt-3 space-y-2" aria-label="Capabilities">
        <Check
          ok={health.billing_enabled}
          label="Billing"
          detail={
            health.billing_enabled
              ? "Stripe is configured; Checkout and the webhook are live."
              : "Off until both MW_STRIPE_API_KEY and MW_STRIPE_WEBHOOK_SECRET are set. The Billing tab has the detail."
          }
          offLabel="off"
        />
        <Check
          ok={health.moderation}
          label="Content moderation"
          detail={
            health.moderation
              ? "Prompts are screened before they are sent."
              : "No MW_MODERATION_API_KEY: nothing is screened, and the Moderation tab's flags stay empty."
          }
          offLabel="off"
        />
        <Check
          ok={health.web_search}
          label="Web search"
          detail={
            health.web_search
              ? "The web_search tool can reach its provider."
              : "No MW_SEARCH_API_KEY: the tool is registered but every search reports unavailable."
          }
          offLabel="off"
        />
        <Check
          ok={health.upstream_enforcement}
          label="Upstream limit enforcement"
          detail={
            health.upstream_enforcement
              ? "Virtual keys are on; the gateway enforces each org's limit as a backstop."
              : "MW_LITELLM_VIRTUAL_KEYS is off, so the app's own gate is the only enforcement."
          }
          offLabel="off"
        />
      </ul>
    </section>
  );
}

function Check({ ok, label, detail, offLabel = "down" }: { ok: boolean; label: string; detail: string; offLabel?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <Badge variant={ok ? "positive" : "destructive"} className="mt-0.5 shrink-0">
        <StatusDot tone={ok ? "positive" : "danger"} />
        {ok ? "ok" : offLabel}
      </Badge>
      <span>
        <span className={ok ? "text-mw-text" : "font-medium text-mw-text"}>{label}</span>
        <span className="block text-mw-text-muted">{detail}</span>
      </span>
    </li>
  );
}
