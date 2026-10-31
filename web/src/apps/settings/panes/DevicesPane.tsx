import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { ServerIcon } from "lucide-react";
import { Alert } from "../../../components/ui/alert";
import { Badge, StatusDot } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { CopyButton } from "../../../components/ui/copy-button";
import { Input } from "../../../components/ui/input";
import { ApiError, apiFetch } from "../../../lib/api";
import { managesOrg } from "../../../lib/auth";
import {
  ago,
  fetchSyncStatus,
  SYNC_CHANGED_EVENT,
  syncLine,
  type SyncStatus,
} from "../../../lib/edgeSync";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../../patterns";
import {
  desktopAppInfo,
  desktopDevicePairing,
  desktopPairDevice,
  desktopUnpairDevice,
  isDesktop,
  type DesktopDevicePairing,
} from "../../../lib/desktopAuth";
import { useShell } from "../../../shell/shellContext";
import { LearnMore, PaneSection } from "../PaneSection";
import { PaneActions } from "../paneActions";
import { Row, RowList } from "../rows";

/**
 * Devices: edge boxes that mirror their conversations to this organisation
 * (deploy/edge/sync-design.md). The same pane is two things, decided by the
 * API it is served from:
 *
 * - On the platform, an owner or admin makes a pairing code for a box and
 *   sees the boxes already paired, each one an API key that can only add
 *   conversations (`conversations:import`), and unpairs them.
 * - On a box (`/api/sync/status` says `box: true`), it takes the platform's
 *   address and that code, and shows how the sync is going.
 *
 * Desktop (clients/desktop): this page ships inside the webview, whose
 * origin is the app's own (`http://tauri.localhost`), so the address a code
 * is shown against is the API base the app was built with
 * (`desktopAppInfo`), not `window.location.origin`. Everything else -- the
 * gating, the routes, the requests -- is the SPA's own: `apiFetch` rides
 * the desktop bearer exactly as it rides the browser cookie.
 */

export interface EdgeDevice {
  id: string;
  prefix: string;
  name: string;
  box_name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface MintedCode {
  code: string;
  name: string;
  expires_in: number;
  expires_at: string;
}

const LABEL_CLASS = "text-sm text-mw-text-muted";

/** Where the "Pair a box" action at the top of the page takes focus. */
const BOX_NAME_ID = "devices-box-name";

function messageOf(err: unknown, fallback: string): string {
  // A bridge refusal is the native side's own wording, a bare string.
  if (typeof err === "string" && err) return err;
  return err instanceof ApiError ? err.message : fallback;
}

function announce(): void {
  window.dispatchEvent(new Event(SYNC_CHANGED_EVENT));
}

export function DevicesPane() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchSyncStatus()
      .then((next) => !cancelled && setStatus(next))
      // An API without the route is a platform: offer the platform view.
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);
  if (status === null && !failed) return <LoadingSkeleton rows={2} />;
  if (status?.box) return <ThisBox initial={status} />;
  return (
    <>
      {/* Desktop: this machine can itself be paired as a device, redeemed
          straight at the platform's anonymous route. A box deploys pair
          through ThisBox's own route above. */}
      {isDesktop() && <MachinePairing />}
      <PlatformDevices />
    </>
  );
}

// --- the platform -------------------------------------------------------------

function PlatformDevices() {
  const { principal } = useShell();
  if (!managesOrg(principal)) {
    return (
      <EmptyState
        title="Devices are for admins"
        description="Edge boxes are paired with this organisation by an owner or administrator. Ask one to pair a box or to unpair one."
      />
    );
  }
  return <PlatformAdmin />;
}

function PlatformAdmin() {
  const [devices, setDevices] = useState<EdgeDevice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const [minted, setMinted] = useState<MintedCode | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ data: EdgeDevice[] }>("/api/sync/devices")
      .then((body) => {
        if (cancelled) return;
        setDevices(body.data);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDevices(null);
        setLoadError(messageOf(err, "Could not load the paired boxes."));
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  return (
    <div className="flex flex-col gap-7">
      {/* A code on screen is shown once: the action waits until Done rather
          than replacing it. */}
      <PaneActions>
        <Button
          type="button"
          size="lg"
          disabled={minted !== null}
          onClick={() => {
            const field = document.getElementById(BOX_NAME_ID);
            field?.scrollIntoView({ block: "center", behavior: "smooth" });
            field?.focus({ preventScroll: true });
          }}
        >
          Pair a box
        </Button>
      </PaneActions>
      <PaneSection
        title="Pair an edge box"
        description="Name the box, make a code, and enter it on the box within ten minutes."
      >
        {minted ? (
          <CodeReveal
            // Keyed on the code, so a renewed one starts its own countdown.
            key={minted.code}
            minted={minted}
            onDone={() => setMinted(null)}
            onRenewed={(next) => {
              setMinted(next);
              reload();
            }}
          />
        ) : (
          <MintForm
            onMinted={(next) => {
              setMinted(next);
              reload();
            }}
          />
        )}
        <LearnMore className="mt-4">
          <p>
            A box on your network keeps working with no connection and mirrors its conversations here when
            it has one. The code is entered on the box under Settings → Devices. The box gets a key that can
            only add conversations: it cannot read your threads, chat as you, or reach billing.
          </p>
        </LearnMore>
      </PaneSection>
      <PaneSection
        title="Paired boxes"
        flush
        description="Unpairing revokes the box's key; what it already mirrored stays here."
      >
        {loadError ? (
          <div className="px-5 py-4">
            <ErrorState title="Could not load the boxes" message={loadError} onRetry={reload} />
          </div>
        ) : devices === null ? (
          <div className="px-5 py-4">
            <LoadingSkeleton rows={2} />
          </div>
        ) : devices.length === 0 ? (
          <EmptyState title="No boxes yet" description="Pair one above." />
        ) : (
          <RowList aria-label="Paired boxes">
            {devices.map((device) => (
              <DeviceRow key={device.id} device={device} onChanged={reload} />
            ))}
          </RowList>
        )}
        <LearnMore className="border-t border-border px-5 py-3">
          <p>
            An unpaired box stops at its next sync and asks to be paired again. Conversations it already
            mirrored stay in this organisation.
          </p>
        </LearnMore>
      </PaneSection>
    </div>
  );
}

function MintForm(props: { onMinted: (minted: MintedCode) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Name the box, so you can tell it apart later.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      props.onMinted(
        await apiFetch<MintedCode>("/api/sync/pairings", {
          method: "POST",
          json: { name: name.trim() },
        }),
      );
      setName("");
    } catch (err) {
      setError(messageOf(err, "Could not make a pairing code."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => void submit(e)} aria-label="Pair an edge box">
      <label className="flex min-w-48 flex-1 flex-col gap-1" htmlFor={BOX_NAME_ID}>
        <span className={LABEL_CLASS}>Box name</span>
        <Input
          id={BOX_NAME_ID}
          value={name}
          maxLength={64}
          placeholder="e.g. Kitchen Pi"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <Button type="submit" disabled={busy}>
        Make a pairing code
      </Button>
      {error && (
        <p role="alert" className="basis-full text-sm text-mw-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * Milliseconds the code has left as of receipt. `expires_in` is relative, so
 * it is right even when this machine's clock is not; the absolute
 * `expires_at` is the fallback for an answer without it.
 */
function lifetimeMs(minted: MintedCode): number {
  if (Number.isFinite(minted.expires_in) && minted.expires_in > 0) return minted.expires_in * 1000;
  const at = Date.parse(minted.expires_at);
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now());
}

/** "9:59": minutes and zero-padded seconds. */
function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function CodeReveal(props: {
  minted: MintedCode;
  onDone: () => void;
  onRenewed: (minted: MintedCode) => void;
}) {
  const { minted } = props;
  // Fixed on arrival: the deadline is when the code dies, not when it rendered.
  const [deadline] = useState(() => Date.now() + lifetimeMs(minted));
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  const expired = left === 0;
  const [renewing, setRenewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The platform's address, named in the instructions. A browser IS the
  // platform (`window.location.origin`); the desktop webview's origin is
  // the app's own, so the address is the API base the app was built with.
  const [origin, setOrigin] = useState(() => window.location.origin);
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    desktopAppInfo()
      .then((info) => {
        if (!cancelled && info?.api_base_url) setOrigin(info.api_base_url);
      })
      .catch(() => {
        // No bridge answer: the webview origin stands, wrong only in that
        // a paired box would be pointed at the app instead of the API.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expired]);

  async function renew() {
    setRenewing(true);
    setError(null);
    try {
      props.onRenewed(
        await apiFetch<MintedCode>("/api/sync/pairings", { method: "POST", json: { name: minted.name } }),
      );
    } catch (err) {
      setError(messageOf(err, "Could not make a new pairing code."));
      setRenewing(false);
    }
  }

  return (
    // Success while the code works; a warning once it has lapsed.
    <Alert
      data-testid="pairing-code-reveal"
      variant={expired ? "warning" : "success"}
      title={
        <>
          The pairing code for {minted.name}. It works once, until{" "}
          {new Date(deadline).toLocaleTimeString()}, and is not shown again.
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <code
            data-testid="pairing-code"
            className={`w-fit rounded-md border border-border bg-background px-3 py-2 font-mono text-lg tracking-widest text-foreground ${
              expired ? "text-mw-text-muted line-through" : ""
            }`}
          >
            {minted.code}
          </code>
          {/* Without a clipboard the button is not rendered; the code is on
              screen to type. */}
          {!expired && <CopyButton text={minted.code} label="Copy code" size="default" />}
        </div>
        {/* role=timer is not announced each tick; the expiry itself is a status. */}
        {expired ? (
          <p data-testid="pairing-countdown" role="status" className="font-medium">
            Expired. Make a new code to pair {minted.name}.
          </p>
        ) : (
          <p data-testid="pairing-countdown" role="timer">
            Expires in <span className="tabular-nums">{clock(left)}</span>
          </p>
        )}
        <p>
          On the box: Settings → Devices, enter this platform's address ({origin}) and the code.
          Or from the box's shell:{" "}
          <code className="font-mono text-xs break-all">
            deploy/edge/edge-up.sh --check --pair {origin} {minted.code}
          </code>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {expired && (
            <Button type="button" disabled={renewing} onClick={() => void renew()}>
              Make a new code
            </Button>
          )}
          <Button type="button" variant="outline" onClick={props.onDone}>
            Done
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-mw-danger">
            {error}
          </p>
        )}
      </div>
    </Alert>
  );
}

function DeviceRow(props: { device: EdgeDevice; onChanged: () => void }) {
  const { device } = props;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function unpair() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch<void>(`/api/sync/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
      setConfirming(false);
      props.onChanged();
    } catch (err) {
      setError(messageOf(err, "Could not unpair the box."));
    } finally {
      setBusy(false);
    }
  }
  // Read once per mount: "paired 3 days ago" does not need to tick.
  const [now] = useState(() => Date.now());
  const synced = device.last_used_at !== null;
  return (
    <Row
      leading={
        <span
          aria-hidden="true"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-mw-surface-hover text-mw-text-muted"
        >
          <ServerIcon className="size-4" />
        </span>
      }
      title={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{device.box_name}</span>
          {device.revoked_at && <Badge variant="outline">Unpaired</Badge>}
        </span>
      }
      meta={
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          <span className="font-mono text-xs">{device.prefix}</span>
          <span>· Paired {ago(device.created_at, now)} ·</span>
          <span className="inline-flex items-center gap-1.5">
            {!device.revoked_at && <StatusDot tone={synced ? "positive" : "neutral"} />}
            {synced ? `last synced ${ago(device.last_used_at!, now)}` : "never synced"}
          </span>
        </span>
      }
      extra={
        error && (
          <p role="alert" className="mt-1 text-sm text-mw-danger">
            {error}
          </p>
        )
      }
      trailing={
        !device.revoked_at &&
        (confirming ? (
          <>
            <span className="text-sm">Unpair {device.box_name}?</span>
            <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void unpair()}>
              Unpair
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
            Unpair…
          </Button>
        ))
      }
    />
  );
}

// --- the box --------------------------------------------------------------------

function ThisBox(props: { initial: SyncStatus }) {
  const [status, setStatus] = useState<SyncStatus>(props.initial);
  const changed = (next: SyncStatus) => {
    setStatus(next);
    announce();
  };
  return (
    <div className="flex flex-col gap-7">
      {status.paired && <BoxStatus status={status} onUnpaired={changed} />}
      {/* A rejected key is a revoked pairing: pairing again is the way on. */}
      {(!status.paired || status.stopped === "key_rejected") && <BoxPairForm onPaired={changed} />}
    </div>
  );
}

function BoxPairForm(props: { onPaired: (status: SyncStatus) => void }) {
  const urlId = useId();
  const codeId = useId();
  const codeHintId = useId();
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || !code.trim()) {
      setError("Enter the platform's address and the pairing code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      props.onPaired(
        await apiFetch<SyncStatus>("/api/sync/box/pairing", {
          method: "POST",
          json: { platform_url: url.trim(), code: code.trim() },
        }),
      );
    } catch (err) {
      setError(messageOf(err, "Could not pair this box."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <PaneSection
      title="Pair this box with the platform"
      description="This box mirrors its conversations to your account whenever it has a connection."
    >
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} aria-label="Pair this box">
        {/* "e.g." placeholders: a bare address or code in the field read as
            one already filled in, and people pressed Pair on it. */}
        <label className="flex flex-col gap-1" htmlFor={urlId}>
          <span className={LABEL_CLASS}>Platform address</span>
          <Input
            id={urlId}
            value={url}
            placeholder="e.g. https://app.matterwave.ai"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <div className="flex flex-col gap-1">
          <label className={LABEL_CLASS} htmlFor={codeId}>
            Pairing code
          </label>
          <Input
            id={codeId}
            value={code}
            placeholder="e.g. ABCD-EFGH-JKMN"
            autoComplete="off"
            aria-describedby={codeHintId}
            className="font-mono"
            onChange={(e) => setCode(e.target.value)}
          />
          <span id={codeHintId} className="text-xs text-mw-text-muted">
            Twelve letters, made on the platform under Settings → Devices. It works for ten minutes.
          </span>
        </div>
        <div>
          <Button type="submit" disabled={busy}>
            Pair
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-mw-danger">
            {error}
          </p>
        )}
      </form>
      <LearnMore className="mt-4">
        <p>
          Once paired, this box sends its conversations to your MatterWave account every minute it has a
          connection, and keeps working without one. On the platform an owner or admin makes the code under
          Settings → Devices. Attached files stay on this box.
        </p>
      </LearnMore>
    </PaneSection>
  );
}

function BoxStatus(props: { status: SyncStatus; onUnpaired: (status: SyncStatus) => void }) {
  const { status } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const line = syncLine(status, now);
  async function unpair() {
    setBusy(true);
    setError(null);
    try {
      props.onUnpaired(await apiFetch<SyncStatus>("/api/sync/box/pairing", { method: "DELETE" }));
    } catch (err) {
      setError(messageOf(err, "Could not unpair this box."));
    } finally {
      setBusy(false);
    }
  }
  const pending = status.pending_messages;
  return (
    <PaneSection
      title={status.name ? `Paired as ${status.name}` : "Paired"}
      description={`Mirroring to ${status.platform_url ?? "the platform"}.`}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-label="Sync status">
        <dt className="text-mw-text-muted">Status</dt>
        <dd>{line?.text ?? "Paired"}</dd>
        <dt className="text-mw-text-muted">Waiting</dt>
        <dd>
          {pending === null || pending === undefined
            ? "unknown"
            : `${pending}${status.pending_capped ? "+" : ""} message${pending === 1 ? "" : "s"}`}
        </dd>
        {status.last_error && (
          <>
            <dt className="text-mw-text-muted">Last error</dt>
            <dd>{status.last_error}</dd>
          </>
        )}
        <dt className="text-mw-text-muted">Device id</dt>
        <dd className="font-mono text-xs">{status.device_id}</dd>
      </dl>
      <div className="mt-3">
        <Button type="button" variant="destructive" disabled={busy} onClick={() => void unpair()}>
          Unpair this box
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-mw-danger">
          {error}
        </p>
      )}
    </PaneSection>
  );
}

// --- this machine (desktop) -----------------------------------------------------

/** What a minted code looks like, for the field's hint. */
const CODE_SHAPE = "ABCD-EFGH-JKMN";

/**
 * Pair THIS MACHINE with the platform: the desktop's half of the handshake.
 * A code made on the platform (above, by an owner or admin) is redeemed
 * here at the platform's anonymous route and the device key it grants is
 * kept in the OS keychain -- not used as the app's bearer, which is why the
 * section is available to any signed-in person, admin or not.
 */
function MachinePairing() {
  const [pairing, setPairing] = useState<DesktopDevicePairing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    desktopDevicePairing()
      .then((state) => {
        if (cancelled) return;
        setPairing(state);
        setLoadError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError("Could not read this machine's pairing.");
      });
    fetchSyncStatus()
      .then((next) => !cancelled && setSync(next))
      .catch(() => {});
    desktopAppInfo()
      .then((info) => !cancelled && setOrigin(info?.api_base_url ?? null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (loadError !== null) {
    return (
      <PaneSection title="Pair with the platform" description="Register this machine as a device.">
        <p role="alert" className="text-sm text-mw-danger">
          {loadError}
        </p>
      </PaneSection>
    );
  }
  if (pairing === null) {
    return (
      <PaneSection title="Pair with the platform" description="Register this machine as a device.">
        <LoadingSkeleton rows={1} />
      </PaneSection>
    );
  }
  return pairing.paired ? (
    <MachineStatus pairing={pairing} origin={origin} sync={sync} onUnpaired={setPairing} />
  ) : (
    <MachinePairForm onPaired={setPairing} origin={origin} />
  );
}

function MachinePairForm(props: { onPaired: (pairing: DesktopDevicePairing) => void; origin: string | null }) {
  const codeId = useId();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim()) {
      setError("Paste the pairing code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      props.onPaired(await desktopPairDevice(code.trim()));
    } catch (err) {
      setError(messageOf(err, "Could not pair this machine."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <PaneSection
      title="Pair with the platform"
      description={
        props.origin
          ? `Register this machine (${props.origin}) as a device of your organisation.`
          : "Register this machine as a device of your organisation."
      }
    >
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} aria-label="Pair with the platform">
        <div className="flex flex-col gap-1">
          <label className={LABEL_CLASS} htmlFor={codeId}>
            Pairing code
          </label>
          <Input
            id={codeId}
            value={code}
            placeholder={`e.g. ${CODE_SHAPE}`}
            autoComplete="off"
            className="font-mono"
            onChange={(e) => setCode(e.target.value)}
          />
          <span className="text-xs text-mw-text-muted">
            Twelve letters, made on the platform above by an owner or admin. It works for ten
            minutes.
          </span>
        </div>
        <div>
          <Button type="submit" disabled={busy}>
            Pair this machine
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-mw-danger">
            {error}
          </p>
        )}
      </form>
      <LearnMore className="mt-4">
        <p>
          Pairing stores a key on this machine that can only add conversations to your organisation
          -- it never signs you in, and this app keeps working exactly as before. The platform lists
          the machine beside the paired boxes, where it can be revoked; unpairing here does the same
          from this side.
        </p>
      </LearnMore>
    </PaneSection>
  );
}

function MachineStatus(props: {
  pairing: DesktopDevicePairing;
  origin: string | null;
  sync: SyncStatus | null;
  onUnpaired: (pairing: DesktopDevicePairing) => void;
}) {
  const { pairing, origin, sync } = props;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read once per mount, as the box's status line is: "paired 3 days ago"
  // does not need to tick.
  const [now] = useState(() => Date.now());
  async function unpair() {
    setBusy(true);
    setError(null);
    try {
      props.onUnpaired(await desktopUnpairDevice());
      setConfirming(false);
    } catch (err) {
      setError(messageOf(err, "Could not unpair this machine."));
    } finally {
      setBusy(false);
    }
  }
  // The one sync line the sync status route offers. A platform answers it
  // for its boxes; unless this machine is pointed at one, there is nothing
  // to report yet -- the pairing stands regardless.
  const syncedAt = sync?.box && sync.paired ? sync.last_synced_at : null;
  return (
    <PaneSection
      title={pairing.name ? `Paired as ${pairing.name}` : "Paired with the platform"}
      description={
        origin ? `A device of your organisation at ${origin}.` : "A device of your organisation."
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-label="Device pairing">
        {pairing.hint && (
          <>
            <dt className="text-mw-text-muted">Device key</dt>
            <dd className="font-mono text-xs">{pairing.hint}</dd>
          </>
        )}
        <dt className="text-mw-text-muted">Paired</dt>
        <dd>{pairing.paired_at ? ago(new Date(pairing.paired_at * 1000).toISOString(), now) : "unknown"}</dd>
        <dt className="text-mw-text-muted">Device id</dt>
        <dd className="font-mono text-xs">{pairing.device_id}</dd>
        <dt className="text-mw-text-muted">Last sync</dt>
        <dd>
          {syncedAt ? (
            ago(syncedAt, now)
          ) : (
            <span className="text-mw-text-muted">nothing reported yet</span>
          )}
        </dd>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="text-sm">Revoke this machine's key?</span>
            <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void unpair()}>
              Unpair
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
            Unpair this machine…
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-mw-danger">
          {error}
        </p>
      )}
      <LearnMore className="mt-4">
        <p>
          Unpairing revokes the key on the platform, best effort -- if this machine is offline the
          key can still be revoked there, under Settings → Devices. Conversations already mirrored
          stay.
        </p>
      </LearnMore>
    </PaneSection>
  );
}
