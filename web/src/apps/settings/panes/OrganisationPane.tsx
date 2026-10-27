import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { RequestReference } from "../../chat/ChatStates";
import { Alert } from "../../../components/ui/alert";
import { StatusDot } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { SimpleSelect } from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { ApiError, apiFetch } from "../../../lib/api";
import { managesOrg } from "../../../lib/auth";
import { PARTNER_MODELS_HEADING, PARTNER_MODELS_NOTE, splitPartners } from "../../../lib/billing";
import {
  MFA_REQUIRED_EXPLANATION,
  fetchMfaSettings,
  mfaStatusLine,
  setMfaRequired,
  type MfaSettings,
} from "../../../lib/orgMfa";
import {
  blockerHeadline,
  fetchDomainChallenge,
  fetchSsoSettings,
  mintRecoveryCode,
  setSsoRequired,
  ssoRefusalOf,
  verifyDomain,
  type DomainChallenge,
  type RecoveryCode,
  type SsoSettings,
  type VerifyOutcome,
} from "../../../lib/orgSso";
import {
  allowListAfter,
  auditCsvPath,
  downloadCsv,
  fetchAuditPage,
  fetchOrgModels,
  setOrgModels,
  type AuditFilters,
  type AuditRow,
  type OrgModel,
  type OrgModelPolicy,
} from "../../../lib/orgPolicy";
import { DestructiveConfirm, EmptyState, ErrorState, LoadingSkeleton } from "../../../patterns";
import {
  describeExpiry,
  fetchOrgSharing,
  formatDate,
  listOrgShares,
  revokeOrgShare,
  setOrgSharing,
  sharingStatusLine,
  type OrgShareRecord,
} from "../../share/share";
import { failureMessage } from "../../../shell/authForms";
import { useShell } from "../../../shell/shellContext";
import type { OrgDomain, OrgIdp, OrgSummary } from "../../../types";
import { LearnMore, PaneSection } from "../PaneSection";
import { Row, RowList } from "../rows";
import { FieldError, FormSummary, SavedStatus, Switch } from "./organisation/formParts";
import {
  IDP_FIELD_NAMES,
  sortFailure,
  validateDomain,
  validateIdp,
  type IdpField,
} from "./organisation/fieldChecks";
import { SectionTabs } from "./organisation/SectionTabs";

/**
 * Organisation: its name, its email domains, its identity provider, and
 * whether members must sign in through it. An admin names the org, claims
 * a domain, proves it by publishing the DNS record the API hands out, and
 * attaches the company IdP; from then on /login offers "Sign in with
 * <name>" to anyone whose address is on that domain, and an owner may make
 * that the only way in. For owners and admins by membership -- `org_role`,
 * the organization_members row, never the platform `roles` claim -- and
 * enforced the same way by the API (every /api/org route reads that row),
 * so a member sees what the pane is for and nothing to press.
 */
export function OrganisationPane() {
  const { principal } = useShell();
  if (!managesOrg(principal)) {
    return (
      <EmptyState
        title="Organisation settings are for admins"
        description="Domains and single sign-on are set up by an administrator of your organisation. Ask one to make changes here."
      />
    );
  }
  return <OrgAdmin />;
}

interface OrgState {
  org: OrgSummary;
  domains: OrgDomain[];
  idps: OrgIdp[];
  /** The instructions every conversation in this org starts with. */
  instructions: string;
  sso: SsoSettings;
  mfa: MfaSettings;
}

async function fetchOrg(): Promise<OrgState> {
  const [org, domains, idps, instructions, sso, mfa] = await Promise.all([
    apiFetch<OrgSummary>("/api/org"),
    apiFetch<{ data: OrgDomain[] }>("/api/org/domains"),
    apiFetch<{ data: OrgIdp[] }>("/api/org/idp"),
    apiFetch<{ text: string }>("/api/org/instructions"),
    fetchSsoSettings(),
    fetchMfaSettings(),
  ]);
  return {
    org,
    domains: domains.data,
    idps: idps.data,
    instructions: instructions.text,
    sso,
    mfa,
  };
}

function OrgAdmin() {
  const [state, setState] = useState<
    { phase: "loading" } | { phase: "error"; message: string } | ({ phase: "ready" } & OrgState)
  >({ phase: "loading" });
  // Bumped after every action: the lists are re-read from the API rather
  // than patched locally, so what the pane shows is what the API holds.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchOrg()
      .then((org) => {
        if (alive) setState({ phase: "ready", ...org });
      })
      .catch((err: unknown) => {
        if (alive) setState({ phase: "error", message: failureMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [generation]);

  if (state.phase === "loading") return <LoadingSkeleton rows={4} />;
  if (state.phase === "error") {
    return <ErrorState title="Could not load organisation settings" message={state.message} />;
  }
  const reload = () => setGeneration((n) => n + 1);
  // Nine cards in one column was a page nobody could find anything on.
  // Grouped by the question an admin arrives with: what is this org and
  // what may members use; how do people get in; who changed what.
  return (
    <SectionTabs
      label="Organisation settings"
      tabs={[
        {
          id: "general",
          label: "General",
          content: (
            <>
              <NameSection org={state.org} onChanged={reload} />
              <DomainsSection domains={state.domains} onChanged={reload} />
              <OrgInstructionsSection text={state.instructions} onChanged={reload} />
              {/* Loads its own data: a gateway that cannot list models
                  must not blank the name and domain sections beside it. */}
              <ModelsSection />
              {/* Loads its own data too, for the same reason. */}
              <SharingSection />
              <CloseOrgSection org={state.org} />
            </>
          ),
        },
        {
          id: "sign-in",
          label: "Sign-in & security",
          content: (
            <>
              <SignInSummary domains={state.domains} idps={state.idps} sso={state.sso} />
              <ProvidersSection idps={state.idps} onChanged={reload} />
              <SsoEnforcementSection sso={state.sso} role={state.org.role} onChanged={reload} />
              <SecuritySection mfa={state.mfa} role={state.org.role} />
            </>
          ),
        },
        { id: "audit", label: "Audit log", content: <AuditSection /> },
      ]}
    />
  );
}

/** One line of what went wrong with the last action, announced as it appears. */
function ActionError(props: { message: string | null }) {
  if (!props.message) return null;
  return (
    <p role="alert" className="text-sm text-mw-danger">
      {props.message}
    </p>
  );
}

/**
 * Copy one value to the clipboard and say so. Without a clipboard (an
 * insecure context, a denied permission) the value is still selectable
 * where it is shown, and the button simply did not help.
 */
function CopyButton(props: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={props.label}
      onClick={() => void copy()}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

// --- the name -------------------------------------------------------------------

/** The API's cap, mirrored so the field refuses before the 422 would. */
const ORG_NAME_MAX_LEN = 120;

/**
 * What the organisation is called. Signup names a new org after the person
 * who created it ("Ada Lovelace (ada@example.com)") because the identity
 * backend needs the name unique; this is where that placeholder becomes
 * the organisation's real name, which invites and the shell then show.
 */
function NameSection(props: { org: OrgSummary; onChanged: () => void }) {
  // The name the API holds, as this section last heard it: the PATCH
  // response updates it directly, so "saved" does not wait on the reload.
  const [current, setCurrent] = useState(props.org.name);
  const [draft, setDraft] = useState(props.org.name);
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | undefined>(undefined);
  const [summary, setSummary] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const fieldId = useId();
  const errorId = `${fieldId}-error`;

  const trimmed = draft.trim();
  const invalid = trimmed.length === 0 || trimmed.length > ORG_NAME_MAX_LEN;
  const dirty = trimmed !== current;
  const fieldError = trimmed.length === 0 ? "Enter a name." : apiError;

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || invalid) return;
    setBusy(true);
    setApiError(undefined);
    setSummary([]);
    setSaved(false);
    try {
      const updated = await apiFetch<OrgSummary>("/api/org", {
        method: "PATCH",
        json: { name: trimmed },
      });
      setCurrent(updated.name);
      setDraft(updated.name);
      setSaved(true);
      props.onChanged();
    } catch (err) {
      const sorted = sortFailure(err, ["name"]);
      setApiError(sorted.fields.name);
      setSummary(sorted.other);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PaneSection title="Name" description="Shown on invitations and in the account menu.">
      <form
        noValidate
        aria-busy={busy}
        onSubmit={(event) => void handleSave(event)}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
          <label htmlFor={fieldId} className="text-sm text-mw-text-muted">
            Name
          </label>
          <Input
            id={fieldId}
            name="org_name"
            type="text"
            autoComplete="organization"
            maxLength={ORG_NAME_MAX_LEN}
            value={draft}
            aria-invalid={fieldError !== undefined || undefined}
            aria-describedby={fieldError ? errorId : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setApiError(undefined);
              setSaved(false);
            }}
          />
        </div>
        <Button type="submit" disabled={busy || !dirty || invalid}>
          {busy ? "Saving…" : "Save name"}
        </Button>
        <div className="basis-full">
          <FieldError id={errorId} message={fieldError} />
        </div>
        <SavedStatus shown={saved && !dirty} className="basis-full" />
        <div className="basis-full">
          <FormSummary name="name" messages={summary} />
        </div>
      </form>
    </PaneSection>
  );
}

// --- domains ------------------------------------------------------------------

function DomainsSection(props: { domains: OrgDomain[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  /** What a verify or remove press on a row said, if it failed. */
  const [rowError, setRowError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [summary, setSummary] = useState<string[]>([]);
  /** The unverified domain whose DNS record is open under its row, if any. */
  const [proving, setProving] = useState<string | null>(null);
  const domainId = useId();
  const errorId = `${domainId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);

  async function removeDomain(domain: string) {
    setBusy(true);
    setRowError(null);
    try {
      await apiFetch(`/api/org/domains/${encodeURIComponent(domain)}`, { method: "DELETE" });
      props.onChanged();
    } catch (err) {
      setRowError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const domain = String(new FormData(form).get("domain") ?? "").trim();
    setSummary([]);
    const problem = validateDomain(domain);
    setFieldError(problem);
    if (problem) {
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await apiFetch("/api/org/domains", { method: "POST", json: { domain } });
      // Cleared only once the claim exists: a refused domain stays in the
      // field to be corrected, not retyped.
      form.reset();
      props.onChanged();
    } catch (err) {
      const sorted = sortFailure(err, ["domain"]);
      setFieldError(sorted.fields.domain);
      setSummary(sorted.other);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PaneSection
      title="Email domains"
      flush
      description={
        <>
          Addresses on a verified domain are offered your organisation&apos;s sign-in.
          <LearnMore className="mt-1">
            <p>
              A domain is verified by publishing a DNS TXT record we give you, which proves the
              domain is yours.
            </p>
          </LearnMore>
        </>
      }
    >
      {props.domains.length === 0 ? (
        <p className="px-5 pt-4 text-sm text-mw-text-muted">No domains claimed yet.</p>
      ) : (
        <RowList aria-label="Claimed domains" className="border-b border-border">
          {props.domains.map((d) => (
            // Row's layout by hand: the DNS record opens under the whole
            // row, not squeezed into the name column beside the buttons.
            <li key={d.domain} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
              <div className="flex min-w-0 flex-1 basis-56 flex-col leading-snug">
                <div className="min-w-0 font-medium break-all">{d.domain}</div>
                <div className="inline-flex items-center gap-1.5 text-sm text-mw-text-muted">
                  <StatusDot tone={d.verified ? "positive" : "warning"} />
                  {d.verified ? `Verified by ${d.verified_by ?? "an admin"}` : "Not verified"}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!d.verified && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-expanded={proving === d.domain}
                    onClick={() => setProving(proving === d.domain ? null : d.domain)}
                  >
                    Verify {d.domain}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void removeDomain(d.domain)}
                >
                  Remove {d.domain}
                  </Button>
              </div>
              {!d.verified && proving === d.domain && (
                <div className="basis-full">
                  <DomainProof domain={d.domain} onVerified={props.onChanged} />
                </div>
              )}
            </li>
          ))}
        </RowList>
      )}
      <div className="flex flex-col gap-3 px-5 py-4">
        <ActionError message={rowError} />

        <form
          noValidate
          aria-busy={busy}
          onSubmit={(event) => void handleAdd(event)}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
            <label htmlFor={domainId} className="text-sm text-mw-text-muted">
              Domain
            </label>
            <Input
              ref={inputRef}
              id={domainId}
              name="domain"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="example.com"
              aria-invalid={fieldError !== undefined || undefined}
              aria-describedby={fieldError ? errorId : undefined}
              onChange={() => setFieldError(undefined)}
            />
          </div>
          <Button type="submit" disabled={busy}>
            Add domain
          </Button>
          <div className="basis-full">
            <FieldError id={errorId} message={fieldError} />
          </div>
        </form>
        <FormSummary name="domain" messages={summary} />
      </div>
    </PaneSection>
  );
}

/**
 * The DNS record for one unverified domain, and the check that proves it.
 *
 * The record is fetched when the row is opened, never minted here: the API
 * keeps the token stable per claim, so an admin who published it yesterday
 * and comes back mid-propagation sees the same name and value. The check
 * has three honest answers and each gets its own copy, because "not found
 * yet" means wait, "found but wrong" means fix the record, and "could not
 * look" means try again -- advice that is useless if the three are blurred.
 */
function DomainProof(props: { domain: string; onVerified: () => void }) {
  const [record, setRecord] = useState<
    { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; record: DomainChallenge }
  >({ phase: "loading" });
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<
    VerifyOutcome | { kind: "failed"; message: string; requestId: string | null } | null
  >(null);

  // Mounted per open row, so the initial "loading" is the only one needed.
  useEffect(() => {
    let alive = true;
    fetchDomainChallenge(props.domain)
      .then((record) => {
        if (alive) setRecord({ phase: "ready", record });
      })
      .catch((err: unknown) => {
        if (alive) setRecord({ phase: "error", message: failureMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [props.domain]);

  async function check() {
    setChecking(true);
    setOutcome(null);
    try {
      const result = await verifyDomain(props.domain);
      setOutcome(result);
      if (result.kind === "verified") props.onVerified();
    } catch (err) {
      setOutcome({
        kind: "failed",
        message: failureMessage(err),
        requestId: err instanceof ApiError ? err.requestId : null,
      });
    } finally {
      setChecking(false);
    }
  }

  if (record.phase === "loading") return <LoadingSkeleton rows={2} />;
  if (record.phase === "error") {
    return (
      <p role="alert" className="text-sm text-mw-danger">
        Could not fetch the DNS record for {props.domain}: {record.message}
      </p>
    );
  }
  const { name, value } = record.record;
  return (
    <div
      data-domain-proof={props.domain}
      className="flex flex-col gap-3 border-t border-border pt-3"
    >
      <p className="text-sm">
        Add this TXT record at your DNS provider, under {props.domain}. Once it has propagated,
        check it here; the record stays the same however many times you check.
      </p>
      <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 text-sm">
        <dt className="text-mw-text-muted">Type</dt>
        <dd className="font-mono">TXT</dd>
        <dd />
        <dt className="text-mw-text-muted">Name</dt>
        <dd>
          <code data-testid="txt-name" className="select-all break-all font-mono">
            {name}
          </code>
        </dd>
        <dd>
          <CopyButton value={name} label={`Copy the record name for ${props.domain}`} />
        </dd>
        <dt className="text-mw-text-muted">Value</dt>
        <dd>
          <code data-testid="txt-value" className="select-all break-all font-mono">
            {value}
          </code>
        </dd>
        <dd>
          <CopyButton value={value} label={`Copy the record value for ${props.domain}`} />
        </dd>
      </dl>
      <div>
        <Button type="button" disabled={checking} onClick={() => void check()}>
          {checking ? "Checking…" : `Check ${props.domain} now`}
        </Button>
      </div>
      {outcome && <VerifyResult domain={props.domain} outcome={outcome} />}
    </div>
  );
}

function VerifyResult(props: {
  domain: string;
  outcome: VerifyOutcome | { kind: "failed"; message: string; requestId: string | null };
}) {
  const { outcome } = props;
  switch (outcome.kind) {
    case "verified":
      return (
        <p role="status" data-verify-outcome="verified" className="text-sm">
          {props.domain} is verified. Anyone with an address on it is now offered your
          organisation&apos;s sign-in.
        </p>
      );
    case "missing":
      return (
        <p role="status" data-verify-outcome="missing" className="text-sm text-mw-text-muted">
          {outcome.detail} Keep the record published and check again in a while; nothing here
          needs changing.
        </p>
      );
    case "mismatch":
      return (
        <div role="status" data-verify-outcome="mismatch" className="text-sm text-mw-text-muted">
          <p>
            {outcome.detail} Replace it with the value above, or add the value as a second record.
          </p>
          <p className="mt-1">
            Found at {outcome.record.name}:{" "}
            {outcome.found.map((v, i) => (
              <code key={i} className="mr-1 break-all font-mono">
                {v}
              </code>
            ))}
          </p>
        </div>
      );
    case "failed":
      return (
        <div role="alert" data-verify-outcome="failed" className="text-sm text-mw-danger">
          <p>{outcome.message}</p>
          <p className="mt-1 font-mono text-xs text-mw-text-muted">
            <RequestReference requestId={outcome.requestId} />
          </p>
        </div>
      );
  }
}

// --- identity providers -----------------------------------------------------------

const IDP_FIELDS = [
  { name: "name", label: "Name", hint: "Shown on the sign-in button.", type: "text" },
  { name: "issuer", label: "Issuer URL", hint: "The https:// issuer of your provider.", type: "url" },
  { name: "client_id", label: "Client ID", type: "text" },
  { name: "client_secret", label: "Client secret", type: "password" },
  { name: "scopes", label: "Scopes (optional)", hint: "Space-separated; openid profile email by default.", type: "text" },
] as const;

/**
 * What a member of this organisation sees on /login, said in one place:
 * which addresses get the organisation's sign-in, through which provider,
 * and whether a password still works beside it. Each step that is not
 * done names the section below that does it, so an admin setting SSO up
 * reads this card, does the next thing, and comes back. The link opens the
 * login page's organisation entry for the first verified domain, which is
 * how an admin checks the whole path without signing out.
 */
function SignInSummary(props: { domains: OrgDomain[]; idps: OrgIdp[]; sso: SsoSettings }) {
  const verified = props.domains.filter((d) => d.verified).map((d) => d.domain);
  const unverified = props.domains.filter((d) => !d.verified).map((d) => d.domain);
  const provider = props.idps[0] ?? null;
  const ready = verified.length > 0 && provider !== null;
  const steps: { done: boolean; text: string }[] = [
    {
      done: verified.length > 0,
      text:
        verified.length > 0
          ? `Verified ${verified.length === 1 ? "domain" : "domains"}: ${verified.join(", ")}.`
          : unverified.length > 0
            ? `Domain claimed but not yet verified: ${unverified.join(", ")}. Publish the DNS record under General > Domains.`
            : "No domain yet. Claim and verify one under General > Domains.",
    },
    {
      done: provider !== null,
      text: provider
        ? `Identity provider: ${provider.name}${provider.issuer ? ` (${provider.issuer})` : ""}.`
        : "No identity provider attached. Attach one below.",
    },
    {
      done: props.sso.sso_required,
      text: props.sso.sso_required
        ? "Single sign-on is required: passwords no longer work for members."
        : "Passwords still work beside single sign-on. Require it below once everyone can sign in through the provider.",
    },
  ];
  const testHref = verified.length > 0 ? `/login?org=${encodeURIComponent(verified[0])}` : null;
  return (
    <PaneSection
      title="How members sign in"
      description={
        <>
          What a member on a verified domain meets on the login page.
          <LearnMore className="mt-1">
            <p>
              Members whose email is on a verified domain see Sign in with your organisation on
              the login page and are sent to your identity provider.
            </p>
          </LearnMore>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-mw-signin-summary={ready ? "ready" : "pending"}>
        <p role="status" className="text-sm">
          {ready
            ? `Members at ${verified.join(", ")} sign in with ${provider?.name}.`
            : "Single sign-on is not offered to anyone yet."}
        </p>
        <ol className="flex flex-col gap-1 text-sm">
          {steps.map((step) => (
            <li key={step.text} className="flex gap-2">
              <span
                aria-label={step.done ? "Done" : "To do"}
                className={step.done ? "text-mw-positive" : "text-mw-text-muted"}
              >
                {step.done ? "\u2713" : "\u25CB"}
              </span>
              <span className={step.done ? "" : "text-mw-text-muted"}>{step.text}</span>
            </li>
          ))}
        </ol>
        {testHref && (
          <p className="text-sm">
            <a
              href={testHref}
              target="_blank"
              rel="noreferrer"
              className="text-mw-link underline underline-offset-2 hover:text-mw-link-hover"
            >
              Try the organisation sign-in
            </a>{" "}
            <span className="text-mw-text-muted">
              (opens the login page's organisation entry in a new tab; your own session stays
              signed in)
            </span>
          </p>
        )}
      </div>
    </PaneSection>
  );
}

function ProvidersSection(props: { idps: OrgIdp[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  /** What a remove press said, if it failed. */
  const [rowError, setRowError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<IdpField, string>>>({});
  const [summary, setSummary] = useState<string[]>([]);
  const baseId = useId();
  const formRef = useRef<HTMLFormElement>(null);

  async function removeProvider(provider: string) {
    setBusy(true);
    setRowError(null);
    try {
      await apiFetch(`/api/org/idp/${encodeURIComponent(provider)}`, { method: "DELETE" });
      props.onChanged();
    } catch (err) {
      setRowError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /** Put the cursor in the first field that needs attention. */
  function focusFirst(errors: Partial<Record<IdpField, string>>) {
    const first = IDP_FIELD_NAMES.find((name) => errors[name] !== undefined);
    if (first) formRef.current?.querySelector<HTMLInputElement>(`[name='${first}']`)?.focus();
  }

  async function handleAttach(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const field = (name: string) => String(data.get(name) ?? "").trim();
    const values = {
      name: field("name"),
      issuer: field("issuer"),
      client_id: field("client_id"),
      // Not trimmed beyond the ends: a secret is whatever was issued.
      client_secret: field("client_secret"),
      scopes: field("scopes"),
    };
    setSummary([]);
    const problems = validateIdp(values);
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) {
      focusFirst(problems);
      return;
    }
    const scopes = values.scopes.split(/\s+/).filter(Boolean);
    setBusy(true);
    try {
      await apiFetch("/api/org/idp", {
        method: "POST",
        json: {
          kind: "oidc",
          name: values.name,
          issuer: values.issuer,
          client_id: values.client_id,
          client_secret: values.client_secret,
          ...(scopes.length > 0 ? { scopes } : {}),
        },
      });
      // Cleared only once attached: a refusal leaves every field as typed.
      form.reset();
      props.onChanged();
    } catch (err) {
      const sorted = sortFailure(err, IDP_FIELD_NAMES);
      setFieldErrors(sorted.fields);
      setSummary(sorted.other);
      focusFirst(sorted.fields);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PaneSection
      title="Single sign-on"
      flush
      description={
        <>
          Attach your organisation&apos;s OpenID Connect provider.
          <LearnMore className="mt-1">
            <p>The client secret goes to the identity backend and is not stored here.</p>
          </LearnMore>
        </>
      }
    >
      {props.idps.length === 0 ? (
        <p className="px-5 pt-4 text-sm text-mw-text-muted">No provider attached.</p>
      ) : (
        <RowList aria-label="Identity providers" className="border-b border-border">
          {props.idps.map((idp) => (
            <Row
              key={idp.provider}
              leading={<StatusDot tone="positive" />}
              title={idp.name}
              meta={
                <span className="break-all">
                  {idp.kind.toUpperCase()} · {idp.issuer ?? "no issuer"} · handle {idp.provider}
                </span>
              }
              trailing={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void removeProvider(idp.provider)}
                >
                  Remove {idp.name}
                </Button>
              }
            />
          ))}
        </RowList>
      )}
      <div className="flex flex-col gap-3 px-5 py-4">
        <ActionError message={rowError} />

        <form
          ref={formRef}
          noValidate
          aria-busy={busy}
          onSubmit={(event) => void handleAttach(event)}
          className="flex flex-col gap-3"
        >
          {IDP_FIELDS.map((f) => {
            const id = `${baseId}-${f.name}`;
            const error = fieldErrors[f.name];
            const describedBy = [
              "hint" in f ? `${id}-hint` : null,
              error ? `${id}-error` : null,
            ].filter(Boolean);
            return (
              <div key={f.name} className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor={id} className="text-sm text-mw-text-muted">
                  {f.label}
                </label>
                <Input
                  id={id}
                  name={f.name}
                  type={f.type}
                  autoComplete="off"
                  aria-invalid={error !== undefined || undefined}
                  aria-describedby={describedBy.length > 0 ? describedBy.join(" ") : undefined}
                  onChange={() =>
                    setFieldErrors((errors) => (errors[f.name] ? { ...errors, [f.name]: undefined } : errors))
                  }
                />
                {"hint" in f && (
                  <p id={`${id}-hint`} className="text-xs text-mw-text-muted">
                    {f.hint}
                  </p>
                )}
                <FieldError id={`${id}-error`} message={error} />
              </div>
            );
          })}
          <FormSummary name="idp" messages={summary} />
          <div>
            <Button type="submit" disabled={busy}>
              Attach provider
            </Button>
          </div>
        </form>
      </div>
    </PaneSection>
  );
}

// --- single sign-on enforcement and the way back in ------------------------------

/**
 * Whether members must sign in through the identity provider.
 *
 * The switch is the one setting on this pane that can lock an organisation
 * out of its own account, which shapes everything here: the API's reasons
 * it would refuse are shown BEFORE the switch rather than after a 409;
 * turning it on is for owners, and an admin is told so instead of offered
 * a button that fails; and the enforced state is only ever reached while
 * handing over a recovery code, shown once, that gets an owner back in
 * through the password route when the provider breaks. Minting a new code
 * retires the previous unused one, so the copy says that too.
 */
function SsoEnforcementSection(props: { sso: SsoSettings; role: string; onChanged: () => void }) {
  const [confirming, setConfirming] = useState<"enable" | "disable" | "mint" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<RecoveryCode | null>(null);

  const isOwner = props.role === "owner";
  const { sso_required: required, blockers } = props.sso;
  const canEnable = isOwner && blockers.length === 0;

  async function run(action: () => Promise<RecoveryCode | undefined>) {
    setBusy(true);
    setError(null);
    try {
      const code = await action();
      setConfirming(null);
      if (code) setMinted(code);
      props.onChanged();
    } catch (err) {
      const refused = ssoRefusalOf(err);
      setError(refused ? refused.message : failureMessage(err));
      setConfirming(null);
      // A 409 means the preflight found something since the pane loaded (a
      // domain released, a member added); re-reading the policy lists it
      // the same way the initial load would, rather than keeping a second
      // copy of the blockers here.
      if (refused) props.onChanged();
    } finally {
      setBusy(false);
    }
  }

  const enable = () => run(async () => (await setSsoRequired(true)).recovery);
  const disable = () =>
    run(async () => {
      await setSsoRequired(false);
      return undefined;
    });
  const mint = () => run(mintRecoveryCode);

  return (
    <PaneSection
      title="Require single sign-on"
      description="When required, passwords stop working and members sign in through the provider only."
    >
      <div className="flex flex-col gap-3">
        <p role="status" data-sso-required={required} className="text-sm">
          {required
            ? "Single sign-on is required. Members sign in through your identity provider only."
            : "Single sign-on is not required. Members may sign in with a password or through your identity provider."}
        </p>

        {!required && blockers.length > 0 && (
          <Alert
            variant="warning"
            title="It cannot be required yet, because enforcing it now would lock people out"
          >
            <ul aria-label="Why single sign-on cannot be required" className="mt-1 flex flex-col gap-1.5">
              {blockers.map((blocker) => (
                <li key={blocker}>
                  <span className="font-medium">{blockerHeadline(blocker)}</span>
                  <span className="block text-xs">{blocker}</span>
                </li>
              ))}
            </ul>
          </Alert>
        )}

        {!required && !isOwner && (
          <p className="text-sm text-mw-text-muted">
            Only an organisation owner can turn this on; an admin can turn it off.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {required ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming("disable")}
            >
              Stop requiring single sign-on…
            </Button>
          ) : (
            <Button
              type="button"
              disabled={busy || !canEnable}
              onClick={() => setConfirming("enable")}
            >
              Require single sign-on…
            </Button>
          )}
          {isOwner && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming("mint")}
            >
              Generate a new recovery code…
            </Button>
          )}
        </div>
        {isOwner && (
          <LearnMore label="About recovery codes">
            <p>
              A recovery code lets an owner sign in with a password once while single sign-on is
              required, for when the provider is broken. Generating a new one retires the previous
              unused code.
            </p>
          </LearnMore>
        )}
        <ActionError message={error} />
      </div>

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirming(null);
        }}
      >
        <DialogContent showCloseButton={false} data-sso-confirm={confirming ?? undefined}>
          {confirming === "enable" && (
            <>
              <DialogHeader>
                <DialogTitle>Require single sign-on?</DialogTitle>
                <DialogDescription>
                  From now on every member of this organisation can only sign in through your
                  identity provider. Their passwords stop working here. You will be shown a
                  recovery code once, which gets you back in with a password if the provider
                  breaks; store it before you close that window.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button disabled={busy} onClick={() => void enable()}>
                  {busy ? "Turning on…" : "Require single sign-on"}
                </Button>
              </DialogFooter>
            </>
          )}
          {confirming === "disable" && (
            <>
              <DialogHeader>
                <DialogTitle>Stop requiring single sign-on?</DialogTitle>
                <DialogDescription>
                  Members will be able to sign in with a password again, as well as through your
                  identity provider.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button disabled={busy} onClick={() => void disable()}>
                  {busy ? "Turning off…" : "Stop requiring"}
                </Button>
              </DialogFooter>
            </>
          )}
          {confirming === "mint" && (
            <>
              <DialogHeader>
                <DialogTitle>Generate a new recovery code?</DialogTitle>
                <DialogDescription>
                  The previous code, if it has not been used, stops working the moment the new
                  one is made. The new code is shown once.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button disabled={busy} onClick={() => void mint()}>
                  {busy ? "Generating…" : "Generate code"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <RecoveryCodeDialog code={minted} onDone={() => setMinted(null)} />
    </PaneSection>
  );
}

/**
 * The second-factor requirement, as a switch. Turning it on changes what
 * every member meets at their next sign-in, so it is asked about first;
 * turning it off takes nothing from anyone and saves at once. On a refusal
 * the switch goes back to where the API still has it, with the reason
 * beside it. Nothing is re-read on success, because the PUT answers with
 * the policy it now holds. Owner only in both directions, as the route
 * is -- an admin sees the state and why they cannot change it.
 */
function SecuritySection(props: { mfa: MfaSettings; role: string }) {
  const [required, setRequired] = useState(props.mfa.mfa_required);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const switchId = useId();
  const isOwner = props.role === "owner";

  // The pane re-reads everything after other sections' actions; what the
  // API then reports wins over what this section last set. Adjusted during
  // render rather than in an effect, so the stale value never paints.
  const [reported, setReported] = useState(props.mfa.mfa_required);
  if (reported !== props.mfa.mfa_required) {
    setReported(props.mfa.mfa_required);
    setRequired(props.mfa.mfa_required);
  }

  function request(on: boolean) {
    // Ignored rather than disabled while the PUT is out: a disabled control
    // loses focus, and a keyboard user would have to find the switch again.
    if (busy) return;
    setSaved(false);
    setError(null);
    if (on) setConfirming(true);
    else void save(false);
  }

  async function save(on: boolean) {
    const before = required;
    setRequired(on);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const after = await setMfaRequired(on);
      setRequired(after.mfa_required);
      setSaved(true);
    } catch (err) {
      setRequired(before);
      setError(failureMessage(err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <PaneSection
      title="Two-factor authentication"
      description="Whether every member of this organisation must sign in with a second factor."
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={switchId} className="min-w-0 text-sm font-medium">
            Require two-factor authentication
          </label>
          <Switch
            id={switchId}
            checked={required}
            busy={busy}
            disabled={!isOwner}
            onCheckedChange={request}
          />
        </div>
        <SavedStatus shown={saved} marker="mfa" />
        <ActionError message={error} />
        <p data-mfa-required={required} className="text-sm">
          {mfaStatusLine(required)}
        </p>
        <LearnMore label="What requiring it does">
          <ul aria-label="What requiring two-factor authentication does" className="flex flex-col gap-1">
            {MFA_REQUIRED_EXPLANATION.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </LearnMore>
        {!isOwner && (
          <p className="text-sm text-mw-text-muted">
            Only an organisation owner can change this, in either direction.
          </p>
        )}
      </div>

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirming(false);
        }}
      >
        <DialogContent showCloseButton={false} data-mfa-confirm="">
          <DialogHeader>
            <DialogTitle>Require two-factor authentication?</DialogTitle>
            <DialogDescription>
              Members without an authenticator app will be asked to set one up at their next
              password sign-in, before they can carry on. Members who already have one keep
              using it, and sessions that are already open stay open.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void save(true)}>
              {busy ? "Saving…" : "Require two-factor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PaneSection>
  );
}

/**
 * The one showing of a recovery code. Only the hash is stored, so there is
 * no second look: the dialog refuses to close -- by button, backdrop or
 * Escape -- until the owner has said they stored it.
 */
function RecoveryCodeDialog(props: { code: RecoveryCode | null; onDone: () => void }) {
  const [stored, setStored] = useState(false);
  const checkId = useId();
  const code = props.code;
  return (
    <Dialog
      open={code !== null}
      onOpenChange={(open) => {
        if (!open && stored) {
          setStored(false);
          props.onDone();
        }
      }}
    >
      <DialogContent showCloseButton={false} data-recovery-code-dialog="">
        <DialogHeader>
          <DialogTitle>Your recovery code</DialogTitle>
          <DialogDescription>
            This is the only time it is shown. It signs an owner in with a password once while
            single sign-on is required
            {code?.expires_at ? `, until ${formatWhen(code.expires_at)}` : ""}. Store it
            somewhere you can reach without this provider.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <code
            data-testid="recovery-code"
            className="min-w-0 flex-1 break-all rounded bg-mw-surface px-2 py-1 font-mono text-sm"
          >
            {code?.code ?? ""}
          </code>
          {code?.code && <CopyButton value={code.code} label="Copy the recovery code" />}
        </div>
        <label htmlFor={checkId} className="flex items-start gap-2 text-sm">
          <input
            id={checkId}
            type="checkbox"
            checked={stored}
            onChange={(event) => setStored(event.target.checked)}
            className="mt-1"
          />
          <span>I have stored this code somewhere safe.</span>
        </label>
        <DialogFooter>
          <Button
            disabled={!stored}
            onClick={() => {
              setStored(false);
              props.onDone();
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A timestamp as a short local date and time; the raw string if it does not parse. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// --- custom instructions ----------------------------------------------

/** The org level's cap, mirrored from the API to render the counter. */
export const ORG_INSTRUCTIONS_MAX_LEN = 4000;

/**
 * Instructions every conversation in the org starts with.
 *
 * Policy, not preference: this text is always in force and a member cannot
 * switch it off by writing their own, which is why it sits in the admin pane
 * and the copy says so. A user's own instructions are added after it, and a
 * single conversation can replace the user's — but never this.
 */
function OrgInstructionsSection(props: { text: string; onChanged: () => void }) {
  const [draft, setDraft] = useState(props.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fieldId = useId();

  const over = draft.length > ORG_INSTRUCTIONS_MAX_LEN;
  const dirty = draft !== props.text;

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || over) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await apiFetch("/api/org/instructions", { method: "PUT", json: { text: draft } });
      setSaved(true);
      props.onChanged();
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PaneSection
      title="Instructions"
      description={
        <>
          Text every conversation in this organisation starts with.
          <LearnMore className="mt-1">
            <p>
              It always applies: a member&apos;s own custom instructions are added to it, never in
              place of it.
            </p>
          </LearnMore>
        </>
      }
    >
      <form className="flex flex-col gap-3" onSubmit={(event) => void handleSave(event)}>
        <label className="sr-only" htmlFor={fieldId}>
          Organisation instructions
        </label>
        <Textarea
          id={fieldId}
          rows={4}
          value={draft}
          placeholder="Answer in British English. Never give legal or financial advice."
          aria-describedby={`${fieldId}-count`}
          aria-invalid={over || undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
          className="min-h-24"
        />
        <p
          id={`${fieldId}-count`}
          className={`text-right text-xs ${over ? "text-mw-danger" : "text-mw-text-muted"}`}
        >
          {draft.length} / {ORG_INSTRUCTIONS_MAX_LEN}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || !dirty || over}>
            {busy ? "Saving…" : "Save instructions"}
          </Button>
          <SavedStatus shown={saved && !dirty} text="Saved. Every conversation here will use these." />
        </div>
        <ActionError message={error} />
      </form>
    </PaneSection>
  );
}

// --- the model allow-list ------------------------------------------------------

/**
 * Which of the plan's models members may pick. The list is what the plan
 * permits and the gateway serves -- nothing is named here -- and each row
 * is a switch. The house model's switch is on and cannot move: every plan
 * allows it and the free plan allows nothing else, so it is the model a
 * member falls back to when a conversation's pinned model is refused; an
 * organisation that could switch it off would leave those members with a
 * picker whose "Default" entry is refused and nothing to pick instead.
 * Flipping a switch saves at once; the picker and the turn gate both read
 * the stored list, so the API's answer is what the section then shows.
 *
 * Models go by the names the picker and the pricing page use, and partner
 * models sit apart under the same heading and note those pages give them,
 * so a switch here reads as the same model a member sees there.
 */
function ModelsSection() {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "ready"; policy: OrgModelPolicy }
  >({ phase: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchOrgModels()
      .then((policy) => {
        if (alive) setState({ phase: "ready", policy });
      })
      .catch((err: unknown) => {
        if (alive) setState({ phase: "error", message: failureMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(models: readonly OrgModel[], model: OrgModel, on: boolean) {
    setBusy(model.id);
    setError(null);
    try {
      const policy = await setOrgModels(allowListAfter(models, model.id, on));
      setState({ phase: "ready", policy });
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <PaneSection
      title="Models"
      description={
        <>
          Which of the models your plan includes members may use.
          <LearnMore className="mt-1">
            <p>
              A model switched off disappears from everyone&apos;s picker and is refused if asked
              for by name.
            </p>
          </LearnMore>
        </>
      }
    >
      {state.phase === "loading" && <LoadingSkeleton rows={3} />}
      {state.phase === "error" && (
        <p role="alert" className="text-sm text-mw-danger">
          Could not load the model list: {state.message}
        </p>
      )}
      {state.phase === "ready" && (
        <div className="flex flex-col gap-3">
          {state.policy.data.length === 0 ? (
            <p className="text-sm text-mw-text-muted">Your plan includes no models to choose between.</p>
          ) : (
            <>
              {splitPartners(state.policy.data).own.length > 0 && (
                <ModelSwitches
                  name="Models"
                  models={splitPartners(state.policy.data).own}
                  busy={busy !== null}
                  onToggle={(model, on) => void toggle(state.policy.data, model, on)}
                />
              )}
              {splitPartners(state.policy.data).partners.length > 0 && (
                <div className="flex flex-col gap-1 border-t border-border pt-3">
                  <h3 className="text-sm font-medium">{PARTNER_MODELS_HEADING}</h3>
                  <p className="text-xs text-mw-text-muted">{PARTNER_MODELS_NOTE}</p>
                  <ModelSwitches
                    name={PARTNER_MODELS_HEADING}
                    models={splitPartners(state.policy.data).partners}
                    busy={busy !== null}
                    onToggle={(model, on) => void toggle(state.policy.data, model, on)}
                  />
                </div>
              )}
            </>
          )}
          <p role="status" className="text-xs text-mw-text-muted">
            {state.policy.restricted
              ? "Members may use only the models switched on above."
              : "Every model your plan includes is available to members."}
          </p>
          {state.policy.unlisted.length > 0 && (
            <p className="text-xs text-mw-text-muted">
              Also allowed, but no longer offered by your plan or the gateway:{" "}
              {state.policy.unlisted.join(", ")}.
            </p>
          )}
          <ActionError message={error} />
        </div>
      )}
    </PaneSection>
  );
}

/** What stands beside a model's name: why it cannot be switched, or what it is. */
function modelNote(model: OrgModel): string {
  if (model.locked) return "Always on: the model this deployment serves to everyone.";
  if (model.research_preview) return "Research preview.";
  return model.context_window ? `${model.context_window.toLocaleString()} context` : "";
}

/** One list of the org's model switches; the house model's is locked on. */
function ModelSwitches(props: {
  name: string;
  models: readonly OrgModel[];
  busy: boolean;
  onToggle: (model: OrgModel, on: boolean) => void;
}) {
  return (
    <ul className="divide-y divide-border" aria-label={props.name}>
      {props.models.map((model) => {
        const switchId = `mw-model-${model.id}`;
        return (
          <li key={model.id} data-model={model.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <label htmlFor={switchId} className="text-sm font-medium break-all">
                {model.label}
              </label>
              {/* The note follows the name on one line; the separator is text, so
                  it survives wrapping and reads aloud as a pause. */}
              {modelNote(model) && (
                <span className="ml-2 text-xs text-mw-text-muted">
                  <span aria-hidden="true">· </span>
                  {modelNote(model)}
                </span>
              )}
            </div>
            <input
              id={switchId}
              type="checkbox"
              role="switch"
              aria-checked={model.allowed}
              aria-label={`Allow ${model.label}`}
              checked={model.allowed}
              disabled={model.locked || props.busy}
              onChange={(event) => props.onToggle(model, event.target.checked)}
              className="size-4"
            />
          </li>
        );
      })}
    </ul>
  );
}

// --- sharing by link ---------------------------------------------------------------

/**
 * Whether members may share conversations by public link, and every link
 * they have made. Switching it off stops every link opening at once
 * without revoking any; revoking is permanent, and an admin may revoke
 * any member's link from here.
 */
function SharingSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [links, setLinks] = useState<OrgShareRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const switchId = useId();

  useEffect(() => {
    let alive = true;
    Promise.all([fetchOrgSharing(), listOrgShares()])
      .then(([policy, rows]) => {
        if (!alive) return;
        setEnabled(policy.enabled);
        setLinks(rows);
      })
      .catch((err: unknown) => {
        if (alive) setError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  async function save(on: boolean) {
    if (busy || enabled === null) return;
    const before = enabled;
    setEnabled(on);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const after = await setOrgSharing(on);
      setEnabled(after.enabled);
      setSaved(true);
    } catch (err) {
      setEnabled(before);
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(share: OrgShareRecord) {
    setRevoking(share.id);
    setError(null);
    try {
      await revokeOrgShare(share.id);
      setLinks((rows) =>
        (rows ?? []).map((row) =>
          row.id === share.id
            ? { ...row, status: "revoked", revoked_at: new Date().toISOString() }
            : row,
        ),
      );
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? "That link was already revoked."
          : failureMessage(err),
      );
    } finally {
      setRevoking(null);
    }
  }

  return (
    <PaneSection
      title="Sharing by link"
      flush
      description={
        <>
          Public, read-only snapshots of a conversation, open to anyone with the link.
          <LearnMore className="mt-1">
            <p>
              Members can share a conversation as a public, read-only link: a snapshot of the
              conversation at that moment, open to anyone holding the link. Switch it off to stop
              every link in this organisation, or revoke single links below.
            </p>
          </LearnMore>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={switchId} className="min-w-0 text-sm font-medium">
            Allow sharing by link
          </label>
          <Switch
            id={switchId}
            checked={enabled ?? true}
            busy={busy}
            disabled={enabled === null}
            onCheckedChange={(next) => void save(next)}
          />
        </div>
        <SavedStatus shown={saved} marker="sharing" />
        <ActionError message={error} />
        {enabled !== null && (
          <p data-sharing-enabled={enabled} className="text-sm">
            {sharingStatusLine(enabled)}
          </p>
        )}

      </div>

      <div className="border-t border-border px-5 pt-4 pb-1">
        <h3 className="text-sm font-medium">Links members have made</h3>
        {links === null && !error && <p className="py-3 text-sm text-mw-text-muted">Loading…</p>}
        {links !== null && links.length === 0 && (
          <p className="py-3 text-sm text-mw-text-muted">No conversation has been shared by link.</p>
        )}
      </div>
      {links !== null && links.length > 0 && (
        <ul aria-label="Shared links in this organisation" className="m-0 list-none divide-y divide-border p-0">
          {links.map((share) => (
            // Row's layout by hand, so the row itself carries its status.
            <li
              key={share.id}
              data-org-share-status={share.status}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4"
            >
              <div className="flex min-w-0 flex-1 basis-56 flex-col leading-snug">
                <span className="truncate font-medium">{share.title || "Untitled"}</span>
                <span className="text-sm text-mw-text-muted">
                  By {share.created_by} · {formatDate(share.created_at)} · {share.view_count}{" "}
                  {share.view_count === 1 ? "view" : "views"} · {describeExpiry(share)}
                  {share.include_attachments && " · with attachments"}
                </span>
              </div>
              {share.status === "active" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revoking === share.id}
                  onClick={() => void revoke(share)}
                >
                  {revoking === share.id ? "Revoking…" : "Revoke"}
                </Button>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-sm text-mw-text-muted">
                  <StatusDot tone="neutral" />
                  {share.status === "revoked" ? "Revoked" : "Expired"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </PaneSection>
  );
}


// --- the audit log -------------------------------------------------------------

/** "3 Oct 2026, 10:00" -- when a row happened, in the reader's locale. */
function formatOccurred(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Who did it, as a person when the API could name one. */
function actorLabel(row: AuditRow): string {
  return row.actor_email ?? row.actor;
}

/** The detail as one short line; an empty object is nothing to show. */
function detailLine(detail: Record<string, unknown>): string {
  const entries = Object.entries(detail ?? {});
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

/**
 * The event filter's "no filter" choice. Not "": the styled select keeps
 * an empty value for "nothing chosen", and audit actions are dotted names,
 * so this cannot collide with one.
 */
const ALL_EVENTS = "*";

/**
 * Who changed what, newest first. The filters are the API's -- an action
 * (exact or as a prefix), a person by email or subject, a day range -- and
 * every page comes from the API with a cursor, so a trail that grows while
 * it is being read never shows a row twice. The CSV is the same query as a
 * file, fetched with the session rather than linked, because the session
 * may not be a cookie.
 */
function AuditSection() {
  const [draft, setDraft] = useState<AuditFilters>({});
  const [filters, setFilters] = useState<AuditFilters>({});
  // What the API answered for a filter set. Keyed on the filters object
  // itself: a page for another set is stale, and "stale or absent" is what
  // loading means, so the effect never has to set a loading flag.
  const [loaded, setLoaded] = useState<
    | { filters: AuditFilters; rows: AuditRow[]; cursor: string | null }
    | { filters: AuditFilters; error: string }
    | null
  >(null);
  const [actions, setActions] = useState<string[]>([]);
  const [moreBusy, setMoreBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const baseId = useId();

  const current = loaded !== null && loaded.filters === filters ? loaded : null;
  const loading = current === null || moreBusy;
  const rows = current !== null && "rows" in current ? current.rows : null;
  const cursor = current !== null && "rows" in current ? current.cursor : null;
  const error = actionError ?? (current !== null && "error" in current ? current.error : null);

  // A new filter set replaces the rows; "load more" appends the next page
  // under the same filters.
  useEffect(() => {
    let alive = true;
    fetchAuditPage(filters)
      .then((page) => {
        if (!alive) return;
        setLoaded({ filters, rows: page.data, cursor: page.next_cursor });
        // The action list is the whole trail's, not the filtered page's,
        // so a filter that empties the page still offers the way back.
        setActions((known) => (page.actions.length > 0 ? page.actions : known));
      })
      .catch((err: unknown) => {
        if (alive) setLoaded({ filters, error: failureMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [filters]);

  async function loadMore() {
    if (cursor === null || rows === null) return;
    setMoreBusy(true);
    setActionError(null);
    try {
      const page = await fetchAuditPage(filters, cursor);
      setLoaded({ filters, rows: [...rows, ...page.data], cursor: page.next_cursor });
    } catch (err) {
      setActionError(failureMessage(err));
    } finally {
      setMoreBusy(false);
    }
  }

  async function exportCsv() {
    setExporting(true);
    setActionError(null);
    try {
      await downloadCsv(auditCsvPath(filters), "audit-log.csv");
    } catch (err) {
      setActionError(failureMessage(err));
    } finally {
      setExporting(false);
    }
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    // A fresh object even for the same values: the page is keyed on it.
    setFilters({ ...draft });
  }

  return (
    <PaneSection
      title="Audit log"
      description={
        <>
          Who changed what in this organisation, newest first.
          <LearnMore className="mt-1">
            <p>
              The trail covers the name, domains, provider, single sign-on, instructions, models,
              members, budget and plan.
            </p>
          </LearnMore>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <form
          noValidate
          aria-label="Filter the audit log"
          onSubmit={apply}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
            <label htmlFor={`${baseId}-event`} className="text-sm text-mw-text-muted">
              Event
            </label>
            <SimpleSelect
              id={`${baseId}-event`}
              value={draft.event ?? ALL_EVENTS}
              onValueChange={(value) =>
                setDraft({ ...draft, event: value === ALL_EVENTS ? undefined : value })
              }
              options={[
                { value: ALL_EVENTS, label: "All events" },
                ...actions.map((action) => ({ value: action, label: action })),
              ]}
              className="w-full"
            />
          </div>
          <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
            <label htmlFor={`${baseId}-actor`} className="text-sm text-mw-text-muted">
              Who
            </label>
            <Input
              id={`${baseId}-actor`}
              name="actor"
              type="text"
              autoComplete="off"
              placeholder="email or subject"
              value={draft.actor ?? ""}
              onChange={(event) => setDraft({ ...draft, actor: event.target.value || undefined })}
            />
          </div>
          <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
            <label htmlFor={`${baseId}-since`} className="text-sm text-mw-text-muted">
              From
            </label>
            <Input
              id={`${baseId}-since`}
              name="since"
              type="date"
              value={draft.since ?? ""}
              onChange={(event) => setDraft({ ...draft, since: event.target.value || undefined })}
            />
          </div>
          <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
            <label htmlFor={`${baseId}-until`} className="text-sm text-mw-text-muted">
              To
            </label>
            <Input
              id={`${baseId}-until`}
              name="until"
              type="date"
              value={draft.until ?? ""}
              onChange={(event) => setDraft({ ...draft, until: event.target.value || undefined })}
            />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Button type="submit" disabled={loading}>
              Apply filters
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={exporting}
              onClick={() => void exportCsv()}
            >
              {exporting ? "Preparing…" : "Download CSV"}
            </Button>
          </div>
        </form>

        {rows === null && loading && <LoadingSkeleton rows={3} />}
        {rows !== null && rows.length === 0 && !loading && (
          <p className="text-sm text-mw-text-muted">Nothing recorded for these filters.</p>
        )}
        {rows !== null && rows.length > 0 && (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-160 text-sm" aria-label="Audit events">
              <thead>
                <tr className="text-left text-xs text-mw-text-muted">
                  <th scope="col" className="py-2 pr-3 font-normal">When</th>
                  <th scope="col" className="py-2 pr-3 font-normal">Who</th>
                  <th scope="col" className="py-2 pr-3 font-normal">Event</th>
                  <th scope="col" className="py-2 pr-3 font-normal">Target</th>
                  <th scope="col" className="py-2 font-normal">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-audit-action={row.action} className="border-t border-border">
                    <td className="py-2 pr-3 whitespace-nowrap tabular-nums">
                      <time dateTime={row.occurred_at}>{formatOccurred(row.occurred_at)}</time>
                    </td>
                    <td className="py-2 pr-3 break-all">{actorLabel(row)}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{row.action}</td>
                    <td className="py-2 pr-3 break-all">{row.target ?? ""}</td>
                    <td className="py-2 text-xs break-all text-mw-text-muted">
                      {detailLine(row.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor !== null && (
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => void loadMore()}
            >
              {loading ? "Loading…" : "Load older events"}
            </Button>
          </div>
        )}
        <ActionError message={error} />
      </div>
    </PaneSection>
  );
}

// --- closing the organisation ----------------------------------------------------

/** How long the API keeps a closed org's conversations restorable. */
const CLOSE_RETENTION_DAYS = 30;

/**
 * The danger card, owners only (the API refuses everyone else the same
 * way). Closing ends the workspace for every member: the conversations stop
 * being readable, keys and invite links stop working, the subscription ends
 * and nobody can sign in to it again. The confirmation is the org's own
 * name, typed, which the API checks as well; on success the session goes,
 * because every request from a closed org is refused.
 */
export function CloseOrgSection(props: { org: OrgSummary }) {
  const shell = useShell();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (props.org.role !== "owner") return null;

  async function runClose() {
    setClosing(true);
    setError(null);
    try {
      await apiFetch("/api/org/close", { method: "POST", json: { confirm: typed.trim() } });
      setOpen(false);
      await shell.signOut();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not close the organisation.");
    } finally {
      setClosing(false);
    }
  }

  return (
    <PaneSection
      title="Close organisation"
      tone="danger"
      description="Ends this workspace for everyone in it. This cannot be undone from here."
      actions={
        <Button
          variant="destructive"
          onClick={() => {
            setTyped("");
            setError(null);
            setOpen(true);
          }}
        >
          Close organisation…
        </Button>
      }
    >
      <LearnMore label="What closing does">
        <p>
          Members are signed out and mailed, API keys and invite links stop working, the
          subscription is cancelled now, and conversations are erased {CLOSE_RETENTION_DAYS} days
          later.
        </p>
      </LearnMore>
      {!open && <ActionError message={error} />}
      <DestructiveConfirm
        open={open}
        onOpenChange={(next) => {
          if (!next) setTyped("");
          setOpen(next);
        }}
        title={`Close ${props.org.name}?`}
        description={
          error ??
          `Every member loses access at once and cannot sign in again. Conversations are erased after ${CLOSE_RETENTION_DAYS} days.`
        }
        confirmLabel="Close organisation"
        confirmPhrase={props.org.name}
        typedValue={typed}
        onTypedValueChange={setTyped}
        onConfirm={() => void runClose()}
        inFlight={closing}
      />
    </PaneSection>
  );
}
