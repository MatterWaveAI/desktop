import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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
  const { t } = useLingui();
  const [state, reload] = useLoad(fetchHealth, "health");
  if (state.phase === "loading") return <LoadingSkeleton rows={6} />;
  if (state.phase === "error") {
    return <ErrorState title={t`Could not load system health`} message={state.message} onRetry={reload} />;
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
  const { t } = useLingui();
  const [state] = useLoad(fetchAttachmentScans, "attachment-scans");
  if (state.phase !== "ready") return null;
  const { scanner, counts } = state.data;
  const on = scanner !== "none";
  const scanning = counts.scanning;
  const failed = counts.scan_failed;
  const clean = counts.clean;
  const quarantined = counts.infected;
  return (
    <section aria-labelledby="health-scanning">
      <h3 id="health-scanning" className="text-sm font-medium text-mw-text">
        <Trans>Attachment scanning</Trans>
      </h3>
      <ul className="mt-3 space-y-2" aria-label={t`Attachment scanning`}>
        <Check
          ok={on}
          label={t`Malware scanner`}
          detail={
            on
              ? t`Uploads are scanned by ${scanner} before they can be read.`
              : t`MW_ATTACHMENT_SCANNER is none: uploads are served without being scanned.`
          }
          offLabel={t`off`}
        />
        <Check
          ok={counts.scan_failed === 0}
          label={t`Scans waiting on a verdict`}
          detail={t`${scanning} scanning, ${failed} could not be scanned and will be retried.`}
          offLabel={t`retrying`}
        />
        <Check
          ok={true}
          label={t`Decided`}
          detail={t`${clean} clean, ${quarantined} quarantined (never served).`}
        />
      </ul>
    </section>
  );
}

function Build({ health }: { health: AdminHealth }) {
  const { t } = useLingui();
  return (
    <section aria-labelledby="health-build">
      <h3 id="health-build" className="text-sm font-medium text-mw-text">
        <Trans>Build</Trans>
      </h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-label={t`Build`}>
        <dt className="text-mw-text-muted">
          <Trans>Version</Trans>
        </dt>
        <dd>{health.version}</dd>
        <dt className="text-mw-text-muted">
          <Trans>Revision</Trans>
        </dt>
        <dd className="font-mono text-xs">{health.revision}</dd>
        <dt className="text-mw-text-muted">
          <Trans>Release</Trans>
        </dt>
        <dd className="font-mono text-xs">{health.release}</dd>
      </dl>
    </section>
  );
}

function Dependencies({ health }: { health: AdminHealth }) {
  const { t } = useLingui();
  const { database, upstream } = health;
  const migrated = database.configured && database.pending_migrations.length === 0;
  const modelCount = upstream.models ?? 0;
  const migration = database.migration ?? t`none`;
  const latestMigration = database.latest_migration;
  // Migration file names are identifiers, listed as they are.
  const pending = database.pending_migrations.join(", ");
  return (
    <section aria-labelledby="health-dependencies">
      <h3 id="health-dependencies" className="text-sm font-medium text-mw-text">
        <Trans>Dependencies</Trans>
      </h3>
      <ul className="mt-3 space-y-2" aria-label={t`Dependencies`}>
        <Check
          ok={upstream.status === "ok"}
          label={t`Model gateway`}
          detail={
            upstream.status === "ok"
              ? plural(modelCount, { one: "Reachable, # model listed.", other: "Reachable, # models listed." })
              : (upstream.detail ?? t`Not reachable. History and settings still work; chat does not.`)
          }
        />
        <Check
          ok={database.configured}
          label={t`Database`}
          detail={
            database.configured
              ? t`Postgres is configured; migration ${migration} applied.`
              : t`MW_DATABASE_URL is not set. Keys, budgets, members and moderation all answer 503.`
          }
        />
        {database.configured && (
          <Check
            ok={migrated}
            label={t`Migrations`}
            detail={
              migrated
                ? t`Up to date at ${latestMigration}.`
                : t`Pending: ${pending}. The image carries ${latestMigration}; run the migrate step.`
            }
          />
        )}
      </ul>
    </section>
  );
}

function Capabilities({ health }: { health: AdminHealth }) {
  const { t } = useLingui();
  return (
    <section aria-labelledby="health-capabilities">
      <h3 id="health-capabilities" className="text-sm font-medium text-mw-text">
        <Trans>Capabilities</Trans>
      </h3>
      <p className="mt-1 text-sm text-mw-text-muted">
        <Trans>Off is the shipped state for each of these. On means a credential exists, not that it works.</Trans>
      </p>
      <ul className="mt-3 space-y-2" aria-label={t`Capabilities`}>
        <Check
          ok={health.billing_enabled}
          label={t`Billing`}
          detail={
            health.billing_enabled
              ? t`Stripe is configured; Checkout and the webhook are live.`
              : t`Off until both MW_STRIPE_API_KEY and MW_STRIPE_WEBHOOK_SECRET are set. The Billing tab has the detail.`
          }
          offLabel={t`off`}
        />
        <Check
          ok={health.moderation}
          label={t`Content moderation`}
          detail={
            health.moderation
              ? t`Prompts are screened before they are sent.`
              : t`No MW_MODERATION_API_KEY: nothing is screened, and the Moderation tab's flags stay empty.`
          }
          offLabel={t`off`}
        />
        <Check
          ok={health.web_search}
          label={t`Web search`}
          detail={
            health.web_search
              ? t`The web_search tool can reach its provider.`
              : t`No MW_SEARCH_API_KEY: the tool is registered but every search reports unavailable.`
          }
          offLabel={t`off`}
        />
        <Check
          ok={health.upstream_enforcement}
          label={t`Upstream limit enforcement`}
          detail={
            health.upstream_enforcement
              ? t`Virtual keys are on; the gateway enforces each org's limit as a backstop.`
              : t`MW_LITELLM_VIRTUAL_KEYS is off, so the app's own gate is the only enforcement.`
          }
          offLabel={t`off`}
        />
      </ul>
    </section>
  );
}

function Check({ ok, label, detail, offLabel }: { ok: boolean; label: string; detail: string; offLabel?: string }) {
  const { t } = useLingui();
  return (
    <li className="flex items-start gap-2 text-sm">
      <Badge variant={ok ? "positive" : "destructive"} className="mt-0.5 shrink-0">
        <StatusDot tone={ok ? "positive" : "danger"} />
        {ok ? t`ok` : (offLabel ?? t`down`)}
      </Badge>
      <span>
        <span className={ok ? "text-mw-text" : "font-medium text-mw-text"}>{label}</span>
        <span className="block text-mw-text-muted">{detail}</span>
      </span>
    </li>
  );
}
