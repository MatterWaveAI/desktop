import { useCallback, useEffect, useId, useState } from "react";
import { DEVELOPERS_PATH } from "../../../shell/frontDoor";
import { KeyRoundIcon } from "lucide-react";
import { Alert } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { CopyButton } from "../../../components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { SimpleSelect } from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import { ApiError, apiFetch } from "../../../lib/api";
import {
  DestructiveConfirm,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  UpgradePrompt,
} from "../../../patterns";
import { LearnMore, PaneSection } from "../PaneSection";
import { PaneActions } from "../paneActions";
import { Row, RowList, activityLabel } from "../rows";

/** The hosted guide to the MCP endpoint: docs/mcp.md, as the public site renders it. */
const MCP_GUIDE_URL = "https://matterwave.dev/docs/reference/mcp";

/**
 * API keys: list, create, edit, rotate, revoke.
 *
 * The one rule the whole pane is shaped around: the key is shown once. The
 * create response and the rotate response are the only places the plaintext
 * ever exists, so each is rendered in the same box with the warning beside
 * it (`ShownOnceKey`), and the list below shows the prefix and nothing more.
 * Revoking keeps the row (audit evidence) and the list says so rather than
 * hiding it.
 *
 * A key's other settings -- its name and scopes, when it expires, where it
 * may be used from, how fast -- are chosen on the create form and shown on
 * the row. Edit opens the same form, minus the secret, pre-filled; Save
 * sends only what changed and the row updates in place. The secret never
 * changes on an edit, so tightening a network or a limit does not mean a
 * new value in every deploy.
 */

/** The closed scope set the API validates against (matterwave/keys.py). */
const SCOPES: readonly { id: string; label: string; hint: string }[] = [
  { id: "chat:read", label: "chat:read", hint: "List conversations and read messages." },
  { id: "chat:write", label: "chat:write", hint: "Create conversations and send messages." },
  { id: "keys:manage", label: "keys:manage", hint: "Create and revoke API keys. Off by default." },
  {
    id: "webhooks:manage",
    label: "webhooks:manage",
    hint: "Manage the org's webhook endpoints. Works only while you are an owner or admin. Off by default.",
  },
  {
    id: "usage:read",
    label: "usage:read",
    hint: "Read the org usage report: everyone's for an owner or admin, your own otherwise. Off by default.",
  },
];
const DEFAULT_SCOPES: readonly string[] = ["chat:read", "chat:write"];

/**
 * The expiry presets, as the API's `expires_in_days`; "date" switches to an
 * absolute date sent as `expires_at`. "never" is the default because it is
 * the one a script's owner expects; the week-ahead mail covers the others.
 */
const EXPIRY_PRESETS: readonly { id: string; label: string; days: number | null }[] = [
  { id: "never", label: "Never", days: null },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "365", label: "1 year", days: 365 },
  { id: "date", label: "On a date…", days: null },
];

/** Inside this many days the expiry badge turns red: the same window the
 * API's notice mail uses, so the pane and the inbox agree. */
const EXPIRY_WARNING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const LABEL_CLASS = "text-sm text-mw-text-muted";

export interface ApiKeyRecord {
  id: string;
  prefix: string;
  name: string;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  rotated_at: string | null;
  /** The retired prefix while its grace window is open, else null. */
  previous_prefix: string | null;
  previous_valid_until: string | null;
  /** Networks the key may be used from; null means anywhere. */
  allowed_cidrs: string[] | null;
  /** The key's own ceiling; null means the platform's. */
  rpm_limit: number | null;
}

/** The create and rotate responses: the row plus the one-time plaintext. */
type ShownKey = ApiKeyRecord & { key: string };

/** "23 Oct 2026" in the reader's locale -- the same shape Members and Billing use. */
function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * A key minted by a device sign-in is stored as "Device: <client> <ISO time>"
 * (device_login.py), which is a fine record and a poor label. Shown as the
 * client's name and the local date -- "VS Code e2e · 23 Oct 2026" -- with
 * the stored name kept on the row's title and in every dialog, so what the
 * API says and what the person sees never disagree about which key it is.
 * Any other name is shown as typed.
 */
const DEVICE_NAME = /^Device: (.+?)(?:\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z))?$/;
const CLIENT_LABELS: Record<string, string> = {
  vscode: "VS Code",
  "matterwave-tui": "MatterWave TUI",
  "matterwave-cli": "MatterWave CLI",
};

export interface KeyLabel {
  text: string;
  /** True for a device sign-in key, which the row then badges. */
  device: boolean;
}

export function keyLabel(name: string): KeyLabel {
  const match = DEVICE_NAME.exec(name);
  if (!match) return { text: name, device: false };
  const [first, ...rest] = match[1].split(/\s+/);
  const client = [CLIENT_LABELS[first.toLowerCase()] ?? first, ...rest].join(" ");
  const minted = match[2] ? new Date(match[2]) : null;
  const when = minted && !Number.isNaN(minted.getTime()) ? ` · ${formatDate(match[2]!)}` : "";
  return { text: `${client}${when}`, device: true };
}

/**
 * When a key was last used, in the words the other lists use for
 * activity: "Used today" (in the positive green), "Used yesterday",
 * "Last used <date>", and "Never used".
 */
function usedLabel(iso: string | null): { text: string; fresh: boolean } {
  if (!iso) return { text: "Never used", fresh: false };
  const { text, fresh } = activityLabel(iso);
  if (text === "Active today" || text === "Active yesterday") return { text: text.replace("Active", "Used"), fresh };
  return { text: text.replace(/^Active /, "Last used "), fresh };
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// --- client-side checks ------------------------------------------------------
//
// The API is the authority (keys.normalize_cidrs, the pydantic bounds); these
// exist so a typo is caught at the field rather than as a 422 after submit.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

function isIpv4(address: string): boolean {
  const match = IPV4.exec(address);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255);
}

function isIpv6(address: string): boolean {
  if (!address.includes(":")) return false;
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half === "" ? [] : half.split(":")));
  if (!groups.every((group) => IPV6_GROUP.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

/** Whether one line of the allow-list is an address or a CIDR range. */
function isCidr(entry: string): boolean {
  const parts = entry.split("/");
  if (parts.length > 2) return false;
  const [address, bits] = parts;
  const v4 = isIpv4(address);
  if (!v4 && !isIpv6(address)) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (v4 ? 32 : 128);
}

/** The allow-list as typed, one entry per line or comma, blanks dropped. */
function cidrEntries(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function ApiKeysPane() {
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The raw error beside its message: a 402 carries which plan has API keys
  // in its headers, and UpgradePrompt renders that; a string cannot.
  const [loadRefusal, setLoadRefusal] = useState<unknown>(null);
  // Bumping this re-runs the load effect: after a create, a rotate, a
  // revoke, or a retry. The effect owns the fetch (the ModelPicker shape,
  // with a cancelled flag) so an unmounted pane never sets state.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  // An edit answers with the row it changed, so the list is patched rather
  // than reloaded: the other rows did not move.
  const replace = useCallback(
    (record: ApiKeyRecord) =>
      setKeys((current) => current?.map((k) => (k.id === record.id ? record : k)) ?? current),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ data: ApiKeyRecord[] }>("/api/keys")
      .then((body) => {
        if (cancelled) return;
        setKeys(body.data);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setKeys(null);
        setLoadRefusal(err);
        setLoadError(messageOf(err, "Could not load the API keys."));
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ShownKey | null>(null);
  // Revoked keys stay on record but not in the way: a device that signs in
  // daily leaves a trail of them, and the live keys are what people came
  // for. One toggle shows the trail.
  const [showRevoked, setShowRevoked] = useState(false);
  const live = keys?.filter((k) => k.revoked_at === null) ?? [];
  const revoked = keys?.filter((k) => k.revoked_at !== null) ?? [];
  const listed = showRevoked ? keys ?? [] : live;

  return (
    <div className="flex flex-col gap-7">
      {/* The form is a one-off, so it waits behind the page's primary
          action rather than pushing the keys below the fold. */}
      {!loadError && (
        <PaneActions>
          <Button type="button" size="lg" onClick={() => setCreating(true)}>
            Create key
          </Button>
        </PaneActions>
      )}
      {created && (
        <ShownOnceKey
          value={created.key}
          lead="Copy your new key now. It will not be shown again."
          note="This is the only time the full key is visible. If you lose it, revoke it and create another."
          testId="new-key"
          onDone={() => setCreated(null)}
        />
      )}
      <PaneSection
        title="Your keys"
        flush
        description="Bearer tokens for scripts and other clients. Only the prefix is shown again."
        actions={
          revoked.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={showRevoked}
              onClick={() => setShowRevoked((on) => !on)}
            >
              {showRevoked ? "Hide revoked" : `Show ${revoked.length} revoked`}
            </Button>
          )
        }
      >
        {loadError ? (
          <div className="flex flex-col gap-3 px-5 py-4">
            <UpgradePrompt error={loadRefusal} />
            <ErrorState title="Could not load the keys" message={loadError} onRetry={reload} />
          </div>
        ) : keys === null ? (
          <div className="px-5 py-4">
            <LoadingSkeleton rows={3} />
          </div>
        ) : listed.length === 0 ? (
          <EmptyState
            title={revoked.length === 0 ? "No API keys yet" : "No active API keys"}
            description={
              revoked.length === 0
                ? "Create one to call the API from a script or another client."
                : "Every key here has been revoked. Create one to call the API again."
            }
          />
        ) : (
          <KeyList key={version} keys={listed} onChanged={reload} onUpdated={replace} />
        )}
        <LearnMore className="border-t border-border px-5 py-3">
          <p>
            Send a key as Authorization: Bearer. A key can be weaker than you, never stronger. Only the
            prefix is ever shown again, and a revoked key stays on record. How to call the API, and what it
            answers, is in the{" "}
            <a href={DEVELOPERS_PATH} className="text-mw-text underline underline-offset-2">
              developer portal
            </a>
            .
          </p>
        </LearnMore>
      </PaneSection>
      <PaneSection
        title="Connect to MCP clients"
        description={
          <>
            Use a key as the bearer for Claude, Cursor and other MCP clients. Setup is in the{" "}
            <a
              href={MCP_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-mw-link underline underline-offset-2 hover:text-mw-link-hover"
            >
              MCP guide
            </a>
            .
          </>
        }
      >
        <LearnMore>
          <p>
            Claude Desktop, Claude Code, Cursor and other Model Context Protocol clients can search and
            continue your conversations with one of these keys as their bearer. A key with only chat:read
            lets a client read and never send. The endpoint, the tools and the copy-paste setup for each
            client are in the guide.
          </p>
        </LearnMore>
      </PaneSection>
      <CreateKeyDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(key) => {
          setCreated(key);
          setCreating(false);
          reload();
        }}
      />
    </div>
  );
}

/**
 * The plaintext, once. Rendered by the create flow inline and by the rotate
 * dialog inside the modal; the words are the same because the promise is.
 */
function ShownOnceKey(props: {
  value: string;
  lead: string;
  note: string;
  testId: string;
  onDone: () => void;
}) {
  return (
    <Alert role="status" variant="success" title={props.lead}>
      <div className="flex flex-col gap-2">
        <p>{props.note}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code
            data-testid={props.testId}
            className="min-w-0 flex-1 basis-60 break-all rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm"
          >
            {props.value}
          </code>
          <CopyButton text={props.value} size="default" />
          <Button variant="outline" onClick={props.onDone}>
            Done
          </Button>
        </div>
      </div>
    </Alert>
  );
}

// --- the key form -------------------------------------------------------------
//
// One form for both minting and editing. The fields are the same five; what
// differs is the initial values and what Save sends: the whole body on
// create, only the fields that changed on edit.

interface KeyFormValues {
  name: string;
  scopes: Set<string>;
  expiry: string;
  expiryDate: string;
  cidrText: string;
  rpmText: string;
}

/** The local calendar day of an instant, as a date input holds it. */
function localDateOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A blank form for a new key, or the form pre-filled from an existing row. */
function formValuesOf(key: ApiKeyRecord | null): KeyFormValues {
  if (!key) {
    return {
      name: "",
      scopes: new Set(DEFAULT_SCOPES),
      expiry: "never",
      expiryDate: "",
      cidrText: "",
      rpmText: "",
    };
  }
  return {
    name: key.name,
    scopes: new Set(key.scopes),
    // An existing expiry is a date, whatever preset chose it: the presets
    // count from now, and "90 days" from the day it was minted is not that.
    expiry: key.expires_at ? "date" : "never",
    expiryDate: key.expires_at ? localDateOf(key.expires_at) : "",
    cidrText: key.allowed_cidrs?.join("\n") ?? "",
    rpmText: key.rpm_limit === null ? "" : String(key.rpm_limit),
  };
}

/** The create body: everything the form holds, defaults sent as absence. */
function createBody(values: KeyFormValues, expiresAt: Date | null): Record<string, unknown> {
  const preset = EXPIRY_PRESETS.find((p) => p.id === values.expiry);
  const cidrs = cidrEntries(values.cidrText);
  const rpm = rpmOf(values.rpmText);
  return {
    name: values.name.trim(),
    scopes: SCOPES.map((s) => s.id).filter((id) => values.scopes.has(id)),
    ...(preset?.days ? { expires_in_days: preset.days } : {}),
    ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
    ...(cidrs.length ? { allowed_cidrs: cidrs } : {}),
    ...(rpm !== null ? { rpm_limit: rpm } : {}),
  };
}

/** The PATCH body: only what differs from the row the form was opened on,
 * with null for "cleared" so the API can tell it from "left alone". */
function patchBody(
  initial: KeyFormValues,
  values: KeyFormValues,
  expiresAt: Date | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (values.name.trim() !== initial.name) body.name = values.name.trim();
  const scopes = SCOPES.map((s) => s.id).filter((id) => values.scopes.has(id));
  const initialScopes = SCOPES.map((s) => s.id).filter((id) => initial.scopes.has(id));
  if (scopes.join(",") !== initialScopes.join(",")) body.scopes = scopes;
  if (values.expiry !== initial.expiry || values.expiryDate !== initial.expiryDate) {
    const preset = EXPIRY_PRESETS.find((p) => p.id === values.expiry);
    if (preset?.days) body.expires_in_days = preset.days;
    else body.expires_at = expiresAt ? expiresAt.toISOString() : null;
  }
  if (values.cidrText !== initial.cidrText) {
    const cidrs = cidrEntries(values.cidrText);
    body.allowed_cidrs = cidrs.length ? cidrs : null;
  }
  if (values.rpmText.trim() !== initial.rpmText.trim()) body.rpm_limit = rpmOf(values.rpmText);
  return body;
}

function rpmOf(text: string): number | null {
  return text.trim() === "" ? null : Number(text);
}

/**
 * The form's state and its field-level checks, computed on every render so
 * the message and the disabled button can never disagree. The API is the
 * authority (keys.normalize_cidrs, the pydantic bounds); these catch a typo
 * at the field rather than as a 422 after submit.
 */
function useKeyForm(initial: KeyFormValues) {
  const [values, setValues] = useState<KeyFormValues>(initial);
  // Read once: a render must not consult the clock, and the API refuses a
  // date that has slipped into the past while the form sat open.
  const [mountedAt] = useState(() => Date.now());

  const update = (patch: Partial<KeyFormValues>) =>
    setValues((current) => ({ ...current, ...patch }));
  const toggleScope = (id: string) =>
    setValues((current) => {
      const next = new Set(current.scopes);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...current, scopes: next };
    });
  const reset = () => setValues(initial);

  const badCidrs = cidrEntries(values.cidrText).filter((entry) => !isCidr(entry));
  const rpm = rpmOf(values.rpmText);
  const badRpm = rpm !== null && (!Number.isInteger(rpm) || rpm < 1);
  // A date is the END of that day locally: "expires on the 30th" means the
  // 30th is still a working day, and the API receives the exact instant.
  const expiresAt =
    values.expiry === "date" && values.expiryDate !== ""
      ? new Date(`${values.expiryDate}T23:59:59`)
      : null;
  // A date the form was opened on is not checked against the clock: an
  // expired key's owner may rename it, or pick a new date, without being
  // told the old one has passed.
  const dateTouched =
    values.expiry !== initial.expiry || values.expiryDate !== initial.expiryDate;
  const badDate =
    values.expiry === "date" &&
    (values.expiryDate === "" ||
      expiresAt === null ||
      Number.isNaN(expiresAt.getTime()) ||
      (dateTouched && expiresAt.getTime() <= mountedAt));
  const fieldProblem = badCidrs.length
    ? `Not an IP address or CIDR range: ${badCidrs[0]}`
    : badRpm
      ? "The rate limit must be a whole number of requests per minute, at least 1."
      : values.expiry === "date" && values.expiryDate !== "" && badDate
        ? "The expiry date must be after today."
        : null;
  const valid =
    values.name.trim().length > 0 && values.scopes.size > 0 && fieldProblem === null && !badDate;

  return {
    values,
    update,
    toggleScope,
    reset,
    expiresAt,
    badCidrs,
    badRpm,
    badDate,
    fieldProblem,
    valid,
  };
}

type KeyForm = ReturnType<typeof useKeyForm>;

/** The five fields, the same on the create form and in the edit dialog. */
function KeyFormFields(props: { form: KeyForm }) {
  const { values, update, toggleScope, badCidrs, badRpm, badDate } = props.form;
  const expiryId = useId();
  const cidrId = useId();
  const rpmId = useId();
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className={LABEL_CLASS}>Name</span>
        <Input
          aria-label="Key name"
          value={values.name}
          maxLength={100}
          placeholder="e.g. laptop script"
          onChange={(event) => update({ name: event.target.value })}
        />
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className={`pb-1 ${LABEL_CLASS}`}>Scopes</legend>
        {SCOPES.map((scope) => (
          <label key={scope.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={values.scopes.has(scope.id)}
              onChange={() => toggleScope(scope.id)}
            />
            <span>
              <code className="font-mono">{scope.label}</code>
              <span className="ml-2 text-mw-text-muted">{scope.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {/* Two equal columns at one height, so Expires and the rate limit line
          up whatever the expiry choice; the date drops in under its select. */}
      <div data-testid="key-limits" className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={expiryId}>
              <span className={LABEL_CLASS}>Expires</span>
            </label>
            <SimpleSelect
              id={expiryId}
              value={values.expiry}
              className="w-full"
              onValueChange={(expiry) => update({ expiry })}
              options={EXPIRY_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
            />
          </div>
          {values.expiry === "date" && (
            <Input
              type="date"
              aria-label="Expiry date"
              value={values.expiryDate}
              aria-invalid={values.expiryDate !== "" && badDate ? true : undefined}
              className="h-9"
              onChange={(event) => update({ expiryDate: event.target.value })}
            />
          )}
        </div>
        <label htmlFor={rpmId} className="flex flex-col gap-1">
          <span className={LABEL_CLASS}>Requests per minute</span>
          <Input
            id={rpmId}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={values.rpmText}
            placeholder="Platform limit"
            aria-invalid={badRpm ? true : undefined}
            className="h-9"
            onChange={(event) => update({ rpmText: event.target.value })}
          />
        </label>
      </div>
      <label htmlFor={cidrId} className="flex flex-col gap-1">
        <span className={LABEL_CLASS}>Allowed IP ranges</span>
        <Textarea
          id={cidrId}
          value={values.cidrText}
          rows={3}
          placeholder={"Anywhere. One address or CIDR range per line, e.g.\n203.0.113.0/24\n2001:db8::/32"}
          aria-invalid={badCidrs.length ? true : undefined}
          className="font-mono"
          onChange={(event) => update({ cidrText: event.target.value })}
        />
        <span className="text-xs text-mw-text-muted">
          Requests from any other address are refused. Leave empty to allow the key from
          anywhere.
        </span>
      </label>
    </>
  );
}

/**
 * The create form in a modal. The form is mounted per opening, so a second
 * key never inherits the first one's scopes or networks. The new secret is
 * handed up and shown in the pane, not here: closing the dialog must not be
 * a way to lose it unseen.
 */
function CreateKeyDialog(props: {
  open: boolean;
  onClose: () => void;
  onCreated: (key: ShownKey) => void;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {props.open && <CreateKeyForm onClose={props.onClose} onCreated={props.onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyForm(props: { onClose: () => void; onCreated: (key: ShownKey) => void }) {
  const form = useKeyForm(formValuesOf(null));
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createRefusal, setCreateRefusal] = useState<unknown>(null);

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const body = await apiFetch<ShownKey>("/api/keys", {
        method: "POST",
        json: createBody(form.values, form.expiresAt),
      });
      props.onCreated(body);
    } catch (err) {
      setCreateRefusal(err);
      setCreateError(messageOf(err, "Could not create the key."));
      setCreating(false);
    }
  };

  const canCreate = form.valid && !creating;

  return (
    <form
      className="flex flex-col gap-3"
      aria-label="Create key"
      onSubmit={(event) => {
        event.preventDefault();
        if (canCreate) void create();
      }}
    >
      <DialogHeader>
        <DialogTitle>Create a key</DialogTitle>
        <DialogDescription>
          The full key is shown once, right after it is made. Copy it then.
        </DialogDescription>
      </DialogHeader>
      <KeyFormFields form={form} />
      <UpgradePrompt error={createRefusal} />
      {(form.fieldProblem ?? createError) && (
        <p role="alert" className="text-sm text-mw-danger">
          {form.fieldProblem ?? createError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={creating} onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canCreate}>
          {creating ? "Creating…" : "Create key"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The create form again, pre-filled from the row and minus the secret.
 * Save sends only the fields that changed; the answer is the row, which
 * replaces the one in the list. Mounted per target so the form state is
 * the target's own and nothing bleeds between edits.
 */
function EditKeyDialog(props: {
  target: ApiKeyRecord | null;
  onClose: () => void;
  onSaved: (record: ApiKeyRecord) => void;
}) {
  return (
    <Dialog
      open={props.target !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {props.target && (
          <EditKeyForm
            key={props.target.id}
            target={props.target}
            onClose={props.onClose}
            onSaved={props.onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditKeyForm(props: {
  target: ApiKeyRecord;
  onClose: () => void;
  onSaved: (record: ApiKeyRecord) => void;
}) {
  const [initial] = useState(() => formValuesOf(props.target));
  const form = useKeyForm(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changes = patchBody(initial, form.values, form.expiresAt);
  const canSave = form.valid && Object.keys(changes).length > 0 && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const record = await apiFetch<ApiKeyRecord>(`/api/keys/${props.target.id}`, {
        method: "PATCH",
        json: changes,
      });
      props.onSaved(record);
      props.onClose();
    } catch (err) {
      setError(messageOf(err, "Could not save the key."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      aria-label="Edit key"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{`Edit "${props.target.name}"`}</DialogTitle>
        <DialogDescription>
          The key itself does not change: whatever uses{" "}
          <code className="font-mono">{props.target.prefix}…</code> keeps working with the new
          settings from the next request.
        </DialogDescription>
      </DialogHeader>
      <KeyFormFields form={form} />
      {(form.fieldProblem ?? error) && (
        <p role="alert" className="text-sm text-mw-danger">
          {form.fieldProblem ?? error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The expiry as a badge, or null for a key that does not expire. Red inside
 * the notice window and once it has passed; a far-off date is just a date.
 */
function ExpiryBadge(props: { expiresAt: string | null; now: number }) {
  if (!props.expiresAt) return null;
  const at = new Date(props.expiresAt).getTime();
  if (Number.isNaN(at)) return null;
  if (at <= props.now) {
    return (
      <Badge variant="destructive" data-testid="expiry-badge">
        Expired {formatDate(props.expiresAt)}
      </Badge>
    );
  }
  const days = Math.ceil((at - props.now) / DAY_MS);
  if (days <= EXPIRY_WARNING_DAYS) {
    return (
      <Badge variant="destructive" data-testid="expiry-badge">
        Expires in {days} {days === 1 ? "day" : "days"}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" data-testid="expiry-badge">
      Expires {formatDate(props.expiresAt)}
    </Badge>
  );
}

function KeyList(props: {
  keys: ApiKeyRecord[];
  onChanged: () => void;
  onUpdated: (record: ApiKeyRecord) => void;
}) {
  const [pending, setPending] = useState<ApiKeyRecord | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [rotating, setRotating] = useState<ApiKeyRecord | null>(null);
  const [editing, setEditing] = useState<ApiKeyRecord | null>(null);
  // Keyed on the load version, so "now" is the moment the rows were asked
  // for; a render must not consult the clock itself.
  const [now] = useState(() => Date.now());

  const revoke = async () => {
    if (!pending) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      await apiFetch(`/api/keys/${pending.id}`, { method: "DELETE" });
      setPending(null);
      props.onChanged();
    } catch (err) {
      setRevokeError(messageOf(err, "Could not revoke the key."));
    } finally {
      setRevoking(false);
    }
  };

  return (
    <>
      <RowList aria-label="API keys">
        {props.keys.map((key) => {
          const revoked = key.revoked_at !== null;
          const expired = key.expires_at !== null && new Date(key.expires_at).getTime() <= now;
          const label = keyLabel(key.name);
          const used = usedLabel(key.last_used_at);
          return (
            <Row
              key={key.id}
              leading={
                <span
                  aria-hidden="true"
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-mw-surface-hover text-mw-text-muted"
                >
                  <KeyRoundIcon className="size-4" />
                </span>
              }
              title={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {/* dev-readonly.spec reads the key's name from the row's
                      first span.font-medium. */}
                  <span
                    className={`font-medium ${revoked ? "line-through" : ""}`}
                    title={label.device ? key.name : undefined}
                  >
                    {label.text}
                  </span>
                  {label.device && <Badge variant="outline">Device sign-in</Badge>}
                  {revoked ? (
                    <Badge variant="destructive">Revoked {formatDate(key.revoked_at)}</Badge>
                  ) : (
                    <ExpiryBadge expiresAt={key.expires_at} now={now} />
                  )}
                </span>
              }
              meta={
                <>
                  <code className="font-mono text-xs">{key.prefix}…</code>
                  {" · "}Created {formatDate(key.created_at)}
                  {" · "}
                  <span className={used.fresh ? "text-mw-positive" : undefined}>{used.text}</span>
                </>
              }
              extra={
                <div className="mt-1.5 flex flex-col gap-1">
                  <div className="flex flex-wrap gap-1">
                    {key.scopes.map((scope) => (
                      <Badge key={scope} variant="outline">
                        {scope}
                      </Badge>
                    ))}
                    {key.rpm_limit !== null && (
                      <Badge variant="outline">{key.rpm_limit} req/min</Badge>
                    )}
                  </div>
                  {key.allowed_cidrs && (
                    <p className="text-xs text-mw-text-muted">
                      Only from <code className="font-mono">{key.allowed_cidrs.join(", ")}</code>
                    </p>
                  )}
                  {key.previous_prefix && key.previous_valid_until && (
                    <p className="text-xs text-mw-text-muted">
                      Rotated {formatDate(key.rotated_at)} · the old key{" "}
                      <code className="font-mono">{key.previous_prefix}…</code> works until{" "}
                      {formatDateTime(key.previous_valid_until)}
                    </p>
                  )}
                </div>
              }
              trailing={
                !revoked && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setEditing(key)}>
                      Edit…
                    </Button>
                    {!expired && (
                      <Button variant="outline" size="sm" onClick={() => setRotating(key)}>
                        Rotate…
                      </Button>
                    )}
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        setRevokeError(null);
                        setPending(key);
                      }}
                    >
                      Revoke…
                    </Button>
                  </>
                )
              }
            />
          );
        })}
      </RowList>
      {revokeError && (
        <p role="alert" className="border-t border-border px-5 py-3 text-sm text-mw-danger">
          {revokeError}
        </p>
      )}
      <DestructiveConfirm
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending ? `Revoke "${pending.name}"?` : "Revoke this key?"}
        description="Every request using this key fails from now on. The key stays listed as revoked; it cannot be restored, only replaced."
        confirmLabel="Revoke key"
        onConfirm={() => void revoke()}
        inFlight={revoking}
      />
      <RotateDialog
        target={rotating}
        onClose={(changed) => {
          setRotating(null);
          if (changed) props.onChanged();
        }}
      />
      <EditKeyDialog target={editing} onClose={() => setEditing(null)} onSaved={props.onUpdated} />
    </>
  );
}

/**
 * Rotate in two steps inside one modal: confirm, then the new key shown
 * once with the deadline for the old one. The modal cannot be dismissed by
 * clicking outside while the key is on screen -- the only way past it is
 * Done, so nobody loses the value to a stray click.
 */
function RotateDialog(props: { target: ApiKeyRecord | null; onClose: (changed: boolean) => void }) {
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotated, setRotated] = useState<ShownKey | null>(null);

  const rotate = async () => {
    if (!props.target) return;
    setInFlight(true);
    setError(null);
    try {
      setRotated(await apiFetch<ShownKey>(`/api/keys/${props.target.id}/rotate`, { method: "POST" }));
    } catch (err) {
      setError(messageOf(err, "Could not rotate the key."));
    } finally {
      setInFlight(false);
    }
  };

  const close = (changed: boolean) => {
    setRotated(null);
    setError(null);
    props.onClose(changed);
  };

  const name = props.target?.name ?? "";
  return (
    <Dialog
      open={props.target !== null}
      onOpenChange={(open) => {
        if (!open && !inFlight && rotated === null) close(false);
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{rotated ? `"${name}" has a new key` : `Rotate "${name}"?`}</DialogTitle>
          <DialogDescription>
            {rotated
              ? `The old key keeps working until ${rotated.previous_valid_until ? formatDateTime(rotated.previous_valid_until) : "now"}, so you can swap it in everywhere first. Revoke the key if the old value may have leaked.`
              : "A new secret for the same key: the name, scopes, expiry and limits stay. The current value keeps working for a grace period so a deploy can swap it; after that only the new one does."}
          </DialogDescription>
        </DialogHeader>
        {rotated ? (
          <ShownOnceKey
            value={rotated.key}
            lead="Copy the new key now. It will not be shown again."
            note="This is the only time the full key is visible. If you lose it, rotate again."
            testId="rotated-key"
            onDone={() => close(true)}
          />
        ) : (
          <>
            {error && (
              <p role="alert" className="text-sm text-mw-danger">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={inFlight} onClick={() => close(false)}>
                Cancel
              </Button>
              <Button variant="default" disabled={inFlight} onClick={() => void rotate()}>
                {inFlight ? "Rotating…" : "Rotate key"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
