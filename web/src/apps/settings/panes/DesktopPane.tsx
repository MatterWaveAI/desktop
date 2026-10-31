import { useCallback, useEffect, useRef, useState } from "react";
import {
  desktopAppInfo,
  desktopCheckForUpdates,
  desktopSendTestNotification,
  isDesktop,
  watchUpdates,
  type UpdateStage,
} from "../../../lib/desktopAuth";
import { passkeysSupported } from "../../../lib/webauthn";
import { pickEngine } from "../../chat/speech";
import { useShell } from "../../../shell/shellContext";
import { LearnMore, PaneSection } from "../PaneSection";
import { Button } from "../../../components/ui/button";

/**
 * Desktop diagnostics -- the pane that proves the platform seams for real,
 * in the webview where they live. Dev builds only (`desktopDevEnabled`);
 * a release build never ships it, and a browser never sees it.
 *
 * Three checks, the ones that cannot be proven from code alone (the audit's
 * "verify in-webview breakage risks"):
 *
 * - **Capability flags** -- what the app actually gated: passkeys off in
 *   the webview (a ceremony is bound to its origin), dictation's engine
 *   pick, the origin the webview presents. This is the gating's own
 *   readout, not a restatement of it.
 * - **A test notification** -- the OS's answer, on demand, focus or no.
 * - **The updater's stages** -- a check runs here and every stage it
 *   passes (`checking` → `downloading` → `verified` → `installing`) lands
 *   in the log, so a round trip can be watched end to end against a real
 *   feed.
 */

interface Flag {
  name: string;
  value: string;
  /** What the flag means in the webview, for the muted half of the row. */
  note?: string;
}

function capabilityFlags(
  authConfig: Parameters<typeof pickEngine>[1],
  info: { version: string; api_base_url: string | null } | null,
): Flag[] {
  const engine = pickEngine(globalThis, authConfig);
  return [
    {
      name: "Desktop shell",
      value: isDesktop() ? "yes" : "no",
      note: "the Tauri IPC bridge is present",
    },
    {
      name: "Webview origin",
      value: window.location.origin,
      note: "what a WebAuthn ceremony would be bound to",
    },
    {
      name: "Secure context",
      value: window.isSecureContext ? "yes" : "no",
    },
    {
      name: "Passkeys offered",
      value: passkeysSupported() ? "yes" : "no",
      note: passkeysSupported()
        ? undefined
        : "gated off in the webview: the origin is not the rpId passkeys are made for",
    },
    {
      name: "Dictation engine",
      value: engine ?? "none",
      note:
        engine === "server"
          ? "no SpeechRecognition in the webview; the server transcriber needs the microphone"
          : engine === null
            ? "no engine: no control renders in the composer"
            : undefined,
    },
    {
      name: "App version",
      value: info?.version ?? "unknown",
      note: info?.api_base_url ? `API base: ${info.api_base_url}` : undefined,
    },
  ];
}

export function DesktopPane() {
  const shell = useShell();
  const [info, setInfo] = useState<{ version: string; api_base_url: string | null } | null>(null);
  const flags = capabilityFlags(shell.authConfig, info);
  const [notification, setNotification] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyNotification, setBusyNotification] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [log, setLog] = useState<{ stage: UpdateStage; at: string }[]>([]);
  const logEnd = useRef<HTMLLIElement | null>(null);

  // Read once: the origin and the engine pick are this webview's facts, not
  // state that changes under the pane.
  useEffect(() => {
    let cancelled = false;
    desktopAppInfo().then((next) => !cancelled && setInfo(next));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return watchUpdates({
      onStage: (stage) =>
        setLog((entries) => [...entries, { stage, at: new Date().toLocaleTimeString() }]),
    });
  }, []);
  useEffect(() => {
    // Optional call: engines without scrollIntoView (jsdom among them) keep
    // the log readable at its end regardless.
    logEnd.current?.scrollIntoView?.({ block: "nearest" });
  }, [log.length]);

  const sendTest = useCallback(async () => {
    setBusyNotification(true);
    try {
      const shown = await desktopSendTestNotification();
      setNotification({
        ok: shown,
        text: shown ? "Shown. Look for it in the OS notification area." : "The OS took it silently.",
      });
    } catch (err) {
      setNotification({
        ok: false,
        text: typeof err === "string" && err ? err : "The OS refused the notification.",
      });
    } finally {
      setBusyNotification(false);
    }
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const found = await desktopCheckForUpdates();
      setCheckResult(
        found
          ? `Update offered: ${found}.`
          : "Nothing newer (or the updater is off in this build).",
      );
    } catch (err) {
      setCheckResult(typeof err === "string" && err ? err : "The check failed before an answer.");
    } finally {
      setChecking(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-7">
      <PaneSection
        title="Capability flags"
        description="What this webview actually offers, and what the app gated because of it."
        flush
      >
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-5 py-4 text-sm"
          aria-label="Capability flags"
        >
          {flags.map((flag) => (
            <div key={flag.name} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-mw-text-muted">{flag.name}</dt>
              <dd>
                <span className="font-mono text-xs break-all">{flag.value}</span>
                {flag.note && <span className="block text-xs text-mw-text-muted">{flag.note}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </PaneSection>

      <PaneSection
        title="Notifications"
        description="Prove the OS shows the app's notifications, without waiting for an unfocused reply."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={busyNotification} onClick={() => void sendTest()}>
            Send a test notification
          </Button>
          {notification && (
            <p
              role="status"
              className={notification.ok ? "text-sm text-mw-text-muted" : "text-sm text-mw-danger"}
            >
              {notification.text}
            </p>
          )}
        </div>
        <LearnMore className="mt-4">
          <p>
            The real notification (a finished reply) only fires when the window is NOT focused; this
            test ignores focus on purpose. Nothing appearing means the OS level is where to look:
            the app's notification settings in Windows or macOS.
          </p>
        </LearnMore>
      </PaneSection>

      <PaneSection
        title="Updater stages"
        description="Run a check and watch the round trip: checking, downloading, verified, installing."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={checking} onClick={() => void check()}>
            Check for updates now
          </Button>
          {checkResult && <p className="text-sm text-mw-text-muted">{checkResult}</p>}
        </div>
        {log.length > 0 && (
          <ol
            aria-label="Updater stage log"
            className="mt-3 max-h-48 overflow-y-auto rounded-md border border-border px-4 py-2 text-sm"
          >
            {log.map((entry, index) => (
              <li
                key={`${entry.stage}-${index}`}
                ref={index === log.length - 1 ? logEnd : undefined}
                className="flex gap-2"
              >
                <span className="font-mono text-xs text-mw-text-muted tabular-nums">{entry.at}</span>
                <span className="font-mono text-xs">{entry.stage}</span>
              </li>
            ))}
          </ol>
        )}
        <LearnMore className="mt-4">
          <p>
            A build without the updater answers the check with nothing and logs no stages. Install
            (download, verify, relaunch) runs from the banner when the feed offers a newer version
            {info?.version ? `, and this build is ${info.version}` : ""}.
          </p>
        </LearnMore>
      </PaneSection>
    </div>
  );
}
