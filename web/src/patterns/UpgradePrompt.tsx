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
  return (
    <div
      role="status"
      data-upgrade-feature={info.feature}
      className={`rounded-lg border border-mw-border bg-mw-surface-raised p-3 text-sm ${props.className ?? ""}`}
    >
      <p>{info.message}</p>
      <p className="mt-1 text-mw-text-muted">
        You are on the {info.currentPlan} plan.{" "}
        {info.upgradeTo ? `${info.upgradeTo} includes this.` : "A higher plan includes this."}
      </p>
      <Link to="/pricing" className="mt-2 inline-block underline underline-offset-2">
        See plans
      </Link>
    </div>
  );
}
