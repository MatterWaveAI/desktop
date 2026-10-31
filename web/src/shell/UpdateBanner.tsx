import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import {
  desktopInstallUpdate,
  desktopPendingUpdate,
  watchUpdates,
  type UpdateDownloadProgress,
  type UpdateStage,
} from "../lib/desktopAuth";

/**
 * "Update available — install", the one hook the check needs. The native
 * side only ever reports (`update-available`, at launch or from the SPA's
 * own check); turning a newer version into a newer app is this banner's
 * button, which runs the download with progress in the line itself and lets
 * the installer relaunch the app. Dismissal is for the session of the
 * mounted shell: the next real check announces again.
 *
 * In a browser there is no updater and this renders nothing, so the shell
 * mounts it unconditionally. Install failures come back here (the command
 * only resolves on failure -- success ends with the process gone), and the
 * person can read them where the button was. The stage announcements ride
 * the same events (`update-stage`) and name where the round trip is --
 * check, download, verified, install -- so a stalled update says which
 * step it stopped at.
 */

type UpdateState =
  | { phase: "hidden" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; version: string; progress: UpdateDownloadProgress | null }
  /** The artifact is in; the OS installer and the relaunch take over. */
  | { phase: "restarting"; version: string };

const STAGE_TEXT: Record<UpdateStage, string> = {
  checking: "Checking the update feed…",
  downloading: "Downloading…",
  verified: "Signature verified.",
  installing: "Handing to the installer…",
};

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ phase: "hidden" });
  const [stage, setStage] = useState<UpdateStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The unlisten from watchUpdates lands one tick after mount; a banner
  // unmounted inside that tick must not leave the listeners behind.
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    desktopPendingUpdate()
      .then((version) => {
        if (alive && version) setState({ phase: "available", version });
      })
      .catch(() => {});
    unlistenRef.current = watchUpdates({
      onAvailable: (version) => {
        setError(null);
        setStage(null);
        setState({ phase: "available", version });
      },
      onProgress: (progress) =>
        setState((current) =>
          current.phase === "downloading" ? { ...current, progress } : current,
        ),
      onDownloadFinished: () =>
        setState((current) =>
          current.phase === "downloading" || current.phase === "available"
            ? { phase: "restarting", version: current.version }
            : current,
        ),
      onStage: setStage,
    });
    return () => {
      alive = false;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  if (state.phase === "hidden") return null;

  const { version } = state;

  async function install() {
    setError(null);
    setState({ phase: "downloading", version, progress: null });
    try {
      await desktopInstallUpdate();
      // Resolved without a relaunch: the updater refused, say why where the
      // button was and leave the offer standing.
      setState({ phase: "available", version });
      setError("The update could not be installed.");
    } catch (err) {
      setState({ phase: "available", version });
      // A refused command arrives as the native side's own wording (a bare
      // string); a bridge failure as an Error. Either way it is the line
      // where the button was.
      setError(
        typeof err === "string" && err
          ? err
          : err instanceof Error && err.message
            ? err.message
            : "The update could not be installed.",
      );
    }
  }

  const percent =
    state.phase === "downloading" && state.progress?.total
      ? Math.min(100, Math.round((state.progress.downloaded / state.progress.total) * 100))
      : null;

  return (
    <div
      role="status"
      data-mw-update-banner=""
      className="flex items-center gap-3 border-b border-mw-border bg-mw-surface-raised px-3 py-1.5 text-sm text-mw-text"
    >
      <p className="min-w-0 flex-1" aria-live="polite">
        {state.phase === "available" && <>MatterWave {version} is available.</>}
        {state.phase === "downloading" && (
          <>
            Downloading {version}
            {percent !== null ? ` — ${percent}%` : "…"}
          </>
        )}
        {state.phase === "restarting" && <>Installing {version}; the app restarts when it is done.</>}
        {stage && <span className="text-mw-text-muted"> {STAGE_TEXT[stage]}</span>}
        {error && (
          <span role="alert" className="block text-mw-danger">
            {error}
          </span>
        )}
      </p>
      {state.phase === "available" && (
        <>
          <Button size="sm" onClick={() => void install()} data-mw-update-install="">
            Update and restart
          </Button>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 text-mw-text-muted hover:text-mw-text"
            onClick={() => {
              setError(null);
              setState({ phase: "hidden" });
            }}
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}
