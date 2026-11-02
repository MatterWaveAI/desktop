import { useEffect, useState } from "react";
import { PaneSection } from "../settings/PaneSection";
import { agentStatus, desktopHost, hostError, type AgentHost, type AgentStatus } from "./host";

/**
 * Preferences -> Agent mode, desktop only. Off by default; turning it on is
 * confirmed in a native dialog (the desktop app's, not this page's), and
 * turning it off stops every run at once. The switch lives on the native
 * side, which refuses every agent command while it is off.
 */
export function AgentModeChoice(props: { host?: AgentHost }) {
  const host = props.host ?? desktopHost;
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void agentStatus(host).then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, [host]);

  // An app without the tool host answers with the "off" default and no
  // contract version: nothing to offer.
  if (status === null || status.contract_version === "") return null;

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await host.setEnabled(enabled));
    } catch (err) {
      setError(hostError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PaneSection
      title="Agent mode (experimental)"
      description="Off by default. Lets the model read a folder you choose and, with your approval, change files and run commands there as you. Its security review is not finished."
    >
      <label className="flex items-start gap-3 py-2 text-sm">
        <input
          type="checkbox"
          data-mw-agent-enabled=""
          checked={status.enabled}
          disabled={busy}
          onChange={(event) => void toggle(event.target.checked)}
          className="mt-0.5 accent-mw-accent"
        />
        <span className="flex flex-col">
          <span>Offer the Agent toggle on new chats</span>
          <span className="text-xs text-mw-text-muted">
            The desktop app asks you to confirm before it turns on. Everything the agent reads is sent to
            MatterWave and the model's provider; .env files, keys and .git are never read, and that list is a
            floor, not a guarantee. Commands are not sandboxed.
          </span>
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-mw-danger">
          {error}
        </p>
      )}
    </PaneSection>
  );
}
