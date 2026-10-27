import { useId, useState, type FormEvent } from "react";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SimpleSelect } from "../../components/ui/select";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../patterns";
import { failureMessage } from "../../shell/authForms";
import {
  fetchFlags,
  fetchOrgs,
  resetFlag,
  saveFlag,
  type AdminFlag,
  type AdminOrg,
  type FlagEdit,
} from "./adminApi";
import { useLoad } from "./useLoad";

/**
 * Feature flags as the operator sees them: the shipped defaults and every
 * row, each saying which layer decided it. A flag is on for everyone
 * (enabled), for the orgs named, or for a stable percentage of orgs; the
 * per-org override is the orgs list, picked by name from the orgs the
 * deployment has rather than typed as an id.
 *
 * Reset removes the row and the key goes back to what the environment
 * says, which is the way to undo a trial without knowing what the
 * environment said.
 */
export function FlagsTab() {
  const [flags, reloadFlags] = useLoad(fetchFlags, "flags");
  const [orgs, reloadOrgs] = useLoad(fetchOrgs, "flag-orgs");
  if (flags.phase === "loading" || orgs.phase === "loading") return <LoadingSkeleton rows={4} />;
  if (flags.phase === "error") {
    return <ErrorState title="Could not load flags" message={flags.message} onRetry={reloadFlags} />;
  }
  if (orgs.phase === "error") {
    return <ErrorState title="Could not load organisations" message={orgs.message} onRetry={reloadOrgs} />;
  }
  return (
    <div className="space-y-6">
      <p className="text-sm text-mw-text-muted">
        A row decides its flag; a flag without one keeps its MW_FLAG_* default. Changes reach every API process
        within fifteen seconds and the SPA at its next load.
      </p>
      {flags.data.length === 0 ? (
        <EmptyState title="No flags" description="Define one below." />
      ) : (
        flags.data.map((flag) => <FlagForm key={flag.key} flag={flag} orgs={orgs.data} onChanged={reloadFlags} />)
      )}
      <NewFlag existing={flags.data.map((f) => f.key)} onCreated={reloadFlags} />
    </div>
  );
}

function FlagForm({ flag, orgs, onChanged }: { flag: AdminFlag; orgs: AdminOrg[]; onChanged: () => void }) {
  const id = useId();
  const [edit, setEdit] = useState<FlagEdit>({
    enabled: flag.enabled,
    description: flag.description,
    rollout: { orgs: [...flag.rollout.orgs], percent: flag.rollout.percent },
  });
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const dirty =
    edit.enabled !== flag.enabled ||
    edit.description !== flag.description ||
    edit.rollout.percent !== flag.rollout.percent ||
    edit.rollout.orgs.join(",") !== flag.rollout.orgs.join(",");

  function update(patch: Partial<FlagEdit>) {
    setEdit((current) => ({ ...current, ...patch }));
    setStatus(null);
  }

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
      setStatus(done);
      onChanged();
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty) return;
    void run(() => saveFlag(flag.key, edit), `${flag.key} saved.`);
  }

  const nameOf = (orgId: string) => orgs.find((o) => o.id === orgId)?.name ?? orgId.slice(0, 8);
  const addable = orgs.filter((o) => !edit.rollout.orgs.includes(o.id));
  return (
    <form
      onSubmit={save}
      aria-label={`Flag ${flag.key}`}
      className="space-y-3 rounded-xl border border-border bg-card p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-sm font-medium text-mw-text">{flag.key}</h3>
        <Badge variant={flag.defined ? "secondary" : "outline"}>{flag.defined ? "row" : "default"}</Badge>
        <span className="text-xs text-mw-text-muted">environment default: {flag.default ? "on" : "off"}</span>
        {flag.updated_by && (
          <span className="ml-auto text-xs text-mw-text-muted">
            by {flag.updated_by}
            {flag.updated_at && ` on ${new Date(flag.updated_at).toLocaleDateString()}`}
          </span>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={edit.enabled}
            disabled={busy}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          On for everyone
        </label>
        <label htmlFor={`${id}-percent`} className="flex items-center gap-2 text-sm">
          Or for
          <Input
            id={`${id}-percent`}
            inputMode="numeric"
            className="w-20"
            value={String(edit.rollout.percent)}
            disabled={busy || edit.enabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 0 && n <= 100) {
                update({ rollout: { ...edit.rollout, percent: n } });
              }
            }}
          />
          % of organisations
        </label>
        <label htmlFor={`${id}-description`} className="flex flex-col gap-1 text-sm sm:col-span-2">
          Description
          <Input
            id={`${id}-description`}
            value={edit.description}
            maxLength={500}
            disabled={busy}
            placeholder="What this flag turns on, and when it can be removed"
            onChange={(e) => update({ description: e.target.value })}
          />
        </label>
      </div>
      <div className="text-sm">
        <span className="text-xs font-medium uppercase tracking-wide text-mw-text-muted">Also on for</span>
        <ul className="mt-1 flex flex-wrap gap-2" aria-label={`Organisations with ${flag.key}`}>
          {edit.rollout.orgs.length === 0 && <li className="text-mw-text-muted">no organisation in particular</li>}
          {edit.rollout.orgs.map((orgId) => (
            <li key={orgId} className="flex items-center gap-1 rounded-full border border-mw-border px-2 py-0.5">
              {nameOf(orgId)}
              <button
                type="button"
                aria-label={`Remove ${nameOf(orgId)} from ${flag.key}`}
                disabled={busy}
                className="text-mw-text-muted hover:text-mw-text"
                onClick={() =>
                  update({ rollout: { ...edit.rollout, orgs: edit.rollout.orgs.filter((o) => o !== orgId) } })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        {addable.length > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor={`${id}-org`} className="sr-only">
              Organisation to add to {flag.key}
            </label>
            <SimpleSelect
              id={`${id}-org`}
              size="sm"
              value={pick || null}
              disabled={busy}
              onValueChange={setPick}
              placeholder="Choose an organisation"
              options={addable.map((org) => ({ value: org.id, label: org.name }))}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || pick === ""}
              onClick={() => {
                update({ rollout: { ...edit.rollout, orgs: [...edit.rollout.orgs, pick] } });
                setPick("");
              }}
            >
              Add to {flag.key}
            </Button>
          </div>
        )}
      </div>
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
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="outline" disabled={busy || !dirty}>
          Save {flag.key}
        </Button>
        {flag.defined && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => resetFlag(flag.key), `${flag.key} is back at its default.`)}
          >
            Reset {flag.key} to default
          </Button>
        )}
      </div>
    </form>
  );
}

function NewFlag({ existing, onCreated }: { existing: string[]; onCreated: () => void }) {
  const id = useId();
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[a-z][a-z0-9_]{0,63}$/.test(key) && !existing.includes(key);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await saveFlag(key, { enabled: false, description, rollout: { orgs: [], percent: 0 } });
      setKey("");
      setDescription("");
      onCreated();
    } catch (err: unknown) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create} aria-label="New flag" className="flex flex-wrap items-end gap-2">
      <label htmlFor={`${id}-key`} className="flex flex-col gap-1 text-sm">
        New flag key
        <Input
          id={`${id}-key`}
          value={key}
          placeholder="snake_case"
          disabled={busy}
          className="font-mono"
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <label htmlFor={`${id}-description`} className="flex flex-col gap-1 text-sm">
        Description
        <Input
          id={`${id}-description`}
          value={description}
          disabled={busy}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={busy || !valid}>
        Define flag
      </Button>
      {error && (
        <Alert role="alert" variant="danger" className="w-full">
          {error}
        </Alert>
      )}
    </form>
  );
}
