import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { upgradeRequired } from "../lib/billing";

/**
 * What a 402 looks like to a person.
 *
 * The API refuses a gated feature with `UpgradeRequired`: a prose `detail`
 * and the machine half in headers -- which feature, which plan they are on,
 * which plan has it. This renders that as one sentence and one link, so
 * every gated surface (API keys, custom instructions, a new conversation
 * past the cap) shows the same thing and none of them has to know what a
 * 402 is.
 *
 * Renders nothing for any other error: callers can put it above their own
 * error state unconditionally and let it decide.
 */
export function UpgradePrompt(props: { error: unknown; className?: string }) {
  const info = upgradeRequired(props.error);
  if (!info) return null;
  const currentPlan = info.currentPlan;
  const upgradeTo = info.upgradeTo;
  return (
    <div
      role="status"
      data-upgrade-feature={info.feature}
      className={`rounded-lg border border-mw-border bg-mw-surface-raised p-3 text-sm ${props.className ?? ""}`}
    >
      <p>{info.message}</p>
      <p className="mt-1 text-mw-text-muted">
        <Trans>You are on the {currentPlan} plan.</Trans>{" "}
        {upgradeTo ? <Trans>{upgradeTo} includes this.</Trans> : <Trans>A higher plan includes this.</Trans>}
      </p>
      <Link to="/pricing" className="mt-2 inline-block underline underline-offset-2">
        <Trans>See plans</Trans>
      </Link>
    </div>
  );
}
