import { useId, useState, type FormEvent } from "react";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../components/ui/table";
import { Input } from "../../components/ui/input";
import { SimpleSelect } from "../../components/ui/select";
import { DestructiveConfirm, ErrorState, LoadingSkeleton } from "../../patterns";
import { MICROS_PER_USD, formatMicros } from "../../lib/billing";
import { failureMessage } from "../../shell/authForms";
import {
  fetchOrgFeatures,
  fetchOrgInvites,
  fetchOrgKeys,
  fetchOrgRetention,
  formatDate,
  revokeOrgKey,
  setOrgBudget,
  setOrgFeature,
  setOrgRetention,
  type AdminInvite,
  type AdminKey,
  type AdminOrg,
  type OrgFeature,
  type OrgFeatures,
} from "./adminApi";
import { OrgBillingPanel } from "./OrgBilling";
import { OrgPlanHeader } from "./OrgPlan";
import { useLoad } from "./useLoad";

/**
 * One organisation, opened from the Orgs table: its overage cap, its API
 * keys and its open invites, with the two actions an operator needs inside
 * a tenant -- set the cap, revoke a key. Its billing -- late payment,
 * policy, card or invoice, invoices -- is the same panel the Overdue tab
 * opens, so an org can be put on invoices before it is ever late.
 *
 * Both do exactly what the org's own admin would do from Settings, and
 * both are audited because the org's admin did not ask. Revoking goes
 * through the confirmation dialog every destructive action here uses;
 * the budget does not, because a wrong number is undone by typing the
 * right one. The feature overrides do not either, for the same reason:
 * choosing "inherit" undoes any of them.
 */
export function OrgDetails({ org, onBudgetSaved }: { org: AdminOrg; onBudgetSaved: () => void }) {
  return (
    <div className="space-y-6 rounded-xl border border-border bg-card p-5" aria-label={`${org.name} details`}>
      <OrgPlanHeader org={org} />
      <BudgetEditor org={org} onSaved={onBudgetSaved} />
      <FeatureOverrides org={org} />
      <OrgBillingPanel orgId={org.id} orgName={org.name} />
      <RetentionEditor org={org} />
      <KeysList org={org} />
      <InvitesList org={org} />
    </div>
  );
}

/**
 * The org's conversation retention window. Blank is keep, which is the
 * default and what most orgs want; a number is the days a conversation
 * may go untouched before the nightly job soft-deletes it as if its owner
 * had. Saved by an operator, audited with the previous value, and no
 * confirmation dialog: the deletion happens tonight, not on this click,
 * and the Retention tab shows what it would be before it does.
 */
function RetentionEditor({ org }: { org: AdminOrg }) {
  const inputId = useId();
  const [state, reload] = useLoad(() => fetchOrgRetention(org.id), org.id);
  const [days, setDays] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const current = state.phase === "ready" ? state.data : null;
  const draft = days ?? (current === null ? "" : String(current));
  const parsed = draft.trim() === "" ? null : /^\d+$/.test(draft.trim()) ? Number(draft.trim()) : undefined;
  const valid = parsed === null || (parsed !== undefined && parsed >= 1 && parsed <= 3650);
  const dirty = state.phase === "ready" && valid && parsed !== current;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || parsed === undefined) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const result = await setOrgRetention(org.id, parsed);
      setSaved(
        result === null
          ? "Retention cleared: conversations are kept until their owner deletes them."
          : `Retention saved: conversations untouched for ${result} days are deleted nightly.`,
      );
      setDays(null);
      reload();
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={`${inputId}-heading`}>
      <h4 id={`${inputId}-heading`} className="text-sm font-medium text-mw-text">
        Conversation retention
      </h4>
      <p className="mt-1 text-sm text-mw-text-muted">
        Days a conversation may go untouched before the nightly job deletes it for this organisation. Blank keeps
        everything. Deleted conversations are purged for good 30 days later; a legal hold exempts a conversation
        from both.
      </p>
      {state.phase === "error" ? (
        <ErrorState title="Could not load retention" message={state.message} onRetry={reload} />
      ) : (
        <form onSubmit={save} className="mt-2 flex flex-wrap items-end gap-2">
          <label htmlFor={inputId} className="sr-only">
            Retention days for {org.name}
          </label>
          <Input
            id={inputId}
            inputMode="numeric"
            placeholder="keep"
            value={draft}
            disabled={saving || state.phase !== "ready"}
            onChange={(event) => {
              setDays(event.target.value);
              setSaved(null);
            }}
            className="max-w-40"
          />
          <Button type="submit" size="sm" variant="outline" disabled={saving || !dirty}>
            Save retention for {org.name}
          </Button>
        </form>
      )}
      {!valid && (
        <p role="alert" className="mt-1 text-sm text-mw-danger">
          Between 1 and 3650 days, or blank to keep.
        </p>
      )}
      {saved && (
        <p role="status" className="mt-1 text-sm text-mw-text-muted">
          {saved}
        </p>
      )}
      {error && (
        <Alert role="alert" variant="danger" className="mt-1">
          {error}
        </Alert>
      )}
    </section>
  );
}

type OverrideChoice = "inherit" | "on" | "off";

function choiceOf(feature: OrgFeature): OverrideChoice {
  return feature.override === null ? "inherit" : feature.override ? "on" : "off";
}

const OVERRIDE_VALUE: Record<OverrideChoice, boolean | null> = { inherit: null, on: true, off: false };

/**
 * The org's plan features: what its plan says, the org's own override and
 * what its next request gets. Changing an override saves at once and is
 * audited; "inherit" returns the feature to the plan, so a later switch on
 * Admin, Plans reaches this org again.
 */
function FeatureOverrides({ org }: { org: AdminOrg }) {
  const headingId = useId();
  const [state, reload] = useLoad(() => fetchOrgFeatures(org.id), org.id);
  // The answer to the last save, shown until the next load replaces it.
  const [latest, setLatest] = useState<OrgFeatures | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const data = latest ?? (state.phase === "ready" ? state.data : null);

  async function choose(feature: OrgFeature, choice: OverrideChoice) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const after = await setOrgFeature(org.id, feature.name, OVERRIDE_VALUE[choice]);
      setLatest(after);
      const now = after.features.find((f) => f.name === feature.name);
      setSaved(
        choice === "inherit"
          ? `${feature.label} follows the plan again: ${now?.effective ? "on" : "off"}.`
          : `${feature.label} is ${choice} for ${org.name}, whatever the plan says.`,
      );
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-medium text-mw-text">
        Features
      </h4>
      <p className="mt-1 text-sm text-mw-text-muted">
        {data ? `On the ${data.plan_name} plan. ` : ""}An override wins over the plan until it is set back to
        inherit; each change is recorded in the audit trail under your name.
      </p>
      <div className="mt-2">
        {data === null && state.phase === "error" ? (
          <ErrorState title="Could not load features" message={state.message} onRetry={reload} />
        ) : data === null ? (
          <LoadingSkeleton rows={2} />
        ) : (
          <Table className="bg-card" aria-label={`${org.name} features`}>
            <TableHeader>
              <TableRow>
                <TableHead>Feature</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Override</TableHead>
                <TableHead>In force</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.features.map((feature) => (
                <TableRow key={feature.name} className="border-b border-mw-border" data-org-feature={feature.name}>
                  <TableCell className="whitespace-normal">
                    <span className="font-medium">{feature.label}</span>
                    <p className="text-xs text-mw-text-muted">{feature.description}</p>
                  </TableCell>
                  <TableCell>{feature.plan ? "on" : "off"}</TableCell>
                  <TableCell>
                    <SimpleSelect<OverrideChoice>
                      aria-label={`${feature.label} override for ${org.name}`}
                      size="sm"
                      value={choiceOf(feature)}
                      disabled={busy}
                      onValueChange={(choice) => void choose(feature, choice)}
                      options={[
                        { value: "inherit", label: `Inherit (${feature.plan ? "on" : "off"})` },
                        { value: "on", label: "On" },
                        { value: "off", label: "Off" },
                      ]}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant={feature.effective ? "positive" : "secondary"}>
                      {feature.effective ? "on" : "off"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {saved && (
        <p role="status" className="mt-1 text-sm text-mw-text-muted">
          {saved}
        </p>
      )}
      {error && (
        <Alert role="alert" variant="danger" className="mt-1">
          {error}
        </Alert>
      )}
    </section>
  );
}

const MICROS_PER_CENT = MICROS_PER_USD / 100;

function BudgetEditor({ org, onSaved }: { org: AdminOrg; onSaved: () => void }) {
  const inputId = useId();
  const [dollars, setDollars] = useState((org.overage_cap_micros / MICROS_PER_USD).toFixed(2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Whole cents, as the org's own admin enters it in Settings > Budget.
  const micros = Math.round(Number(dollars) * 100) * MICROS_PER_CENT;
  const valid = dollars.trim() !== "" && Number.isFinite(micros) && micros >= 0;
  const dirty = valid && micros !== org.overage_cap_micros;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const budget = await setOrgBudget(org.id, micros);
      // The answer is the cap in force, so a reset reads back as the default's amount.
      setSaved(
        micros === 0
          ? `Overage cap reset to the plan default: ${formatMicros(budget.overage_cap_micros)} a month.`
          : `Overage cap saved: ${formatMicros(budget.overage_cap_micros)} a month.`,
      );
      onSaved();
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={`${inputId}-heading`}>
      <h4 id={`${inputId}-heading`} className="text-sm font-medium text-mw-text">
        Overage cap
      </h4>
      <p className="mt-1 text-sm text-mw-text-muted">
        {org.tokens_used.toLocaleString()} weighted tokens and {formatMicros(org.overage_micros)} of overage
        this month. The cap is the most usage past the plan's included tokens may cost; 0 uses the plan's
        default, its monthly price. It applies only on a plan with overage. The gateway's copy follows
        when upstream enforcement is on.
      </p>
      <form onSubmit={save} className="mt-2 flex flex-wrap items-end gap-2">
        <label htmlFor={inputId} className="sr-only">
          Overage cap for {org.name} in US dollars
        </label>
        <Input
          id={inputId}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={dollars}
          disabled={saving}
          onChange={(event) => setDollars(event.target.value)}
          className="max-w-40"
        />
        <Button type="submit" size="sm" variant="outline" disabled={saving || !dirty}>
          Save overage cap for {org.name}
        </Button>
      </form>
      {saved && (
        <p role="status" className="mt-1 text-sm text-mw-text-muted">
          {saved}
        </p>
      )}
      {error && (
        <Alert role="alert" variant="danger" className="mt-1">
          {error}
        </Alert>
      )}
    </section>
  );
}

function KeysList({ org }: { org: AdminOrg }) {
  const [state, reload] = useLoad(() => fetchOrgKeys(org.id), org.id);
  const [pending, setPending] = useState<AdminKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read once per mount: "expired" is a coarse label, not a ticking clock.
  const [now] = useState(() => Date.now());

  async function revoke() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await revokeOrgKey(org.id, pending.id);
      setPending(null);
      reload();
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`keys-${org.id}`}>
      <h4 id={`keys-${org.id}`} className="text-sm font-medium text-mw-text">
        API keys
      </h4>
      {error && (
        <Alert role="alert" variant="danger" className="mt-1">
          {error}
        </Alert>
      )}
      <div className="mt-2">
        {state.phase === "loading" ? (
          <LoadingSkeleton rows={2} />
        ) : state.phase === "error" ? (
          <ErrorState title="Could not load keys" message={state.message} onRetry={reload} />
        ) : state.data.length === 0 ? (
          <p className="text-sm text-mw-text-muted">No API keys.</p>
        ) : (
          <Table className="bg-card" aria-label={`${org.name} API keys`}>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data.map((key: AdminKey) => {
                // An expired key is already refused: nothing left to revoke.
                const expired = !key.revoked_at && key.expires_at !== null && Date.parse(key.expires_at) <= now;
                return (
                  <TableRow key={key.id} className="border-b border-mw-border">
                    <TableCell>
                      <span className="font-medium">{key.name}</span>
                      <code className="ml-2 font-mono text-xs text-mw-text-muted">{key.prefix}…</code>
                      {key.revoked_at && (
                        <Badge variant="destructive" className="ml-2">
                          Revoked {formatDate(key.revoked_at)}
                        </Badge>
                      )}
                      {expired && (
                        <Badge variant="outline" className="ml-2">
                          Expired {formatDate(key.expires_at)}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{key.scopes.join(" ")}</TableCell>
                    <TableCell>{formatDate(key.created_at)}</TableCell>
                    <TableCell>{formatDate(key.last_used_at)}</TableCell>
                    <TableCell className="text-right">
                      {!key.revoked_at && !expired && (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => {
                            setError(null);
                            setPending(key);
                          }}
                        >
                          Revoke {key.name}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      <DestructiveConfirm
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
        title={pending ? `Revoke ${pending.name}?` : "Revoke this key?"}
        description={`The key's next request is refused. ${org.name}'s admins were not asked; the revocation is recorded in the audit trail under your name.`}
        confirmLabel="Revoke"
        inFlight={busy}
        onConfirm={() => void revoke()}
      />
    </section>
  );
}

function InvitesList({ org }: { org: AdminOrg }) {
  const [state, reload] = useLoad(() => fetchOrgInvites(org.id), org.id);
  return (
    <section aria-labelledby={`invites-${org.id}`}>
      <h4 id={`invites-${org.id}`} className="text-sm font-medium text-mw-text">
        Open invites
      </h4>
      <div className="mt-2">
        {state.phase === "loading" ? (
          <LoadingSkeleton rows={2} />
        ) : state.phase === "error" ? (
          <ErrorState title="Could not load invites" message={state.message} onRetry={reload} />
        ) : state.data.length === 0 ? (
          <p className="text-sm text-mw-text-muted">No open invites.</p>
        ) : (
          <Table className="bg-card" aria-label={`${org.name} invites`}>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Invited by</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data.map((invite: AdminInvite) => (
                <TableRow key={invite.id} className="border-b border-mw-border">
                  <TableCell>{invite.email}</TableCell>
                  <TableCell>{invite.role}</TableCell>
                  <TableCell className="font-mono text-xs">{invite.invited_by}</TableCell>
                  <TableCell>{formatDate(invite.expires_at)}</TableCell>
                  <TableCell>
                    <Badge variant={invite.status === "pending" ? "info" : "secondary"}>{invite.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
