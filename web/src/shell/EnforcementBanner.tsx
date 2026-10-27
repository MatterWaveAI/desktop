import { useEffect, useState } from "react";
import { POLICY_PATH } from "./frontDoor";
import { enforcementHeadline, fetchMyEnforcement, STATE_LABEL, type MyEnforcement } from "./policy";

/**
 * The person's own standing under the acceptable-use policy, between the
 * header and the app: a warning, or a rate limit and when it ends. A
 * suspended account never reaches the shell (Boot shows SuspendedNotice), so
 * the two states this draws are the two a person can keep working under.
 *
 * Never dismissible. A warning exists to be seen, and a limit a person has
 * hidden from themselves is one they hit by surprise. It is one short
 * paragraph for the same reason the announcement banner clamps: it must not
 * push the app off a phone screen.
 *
 * Read on mount and then every two minutes, best effort: a failed read shows
 * nothing rather than an error, the same as AnnouncementBanner. The reason
 * shown is the one the operator wrote for the person; the API never sends
 * the operator's notes.
 */

const REFRESH_MS = 120_000;

export function EnforcementBanner() {
  const [me, setMe] = useState<MyEnforcement | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchMyEnforcement()
        .then((data) => alive && setMe(data))
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Only the two states a person keeps working under draw anything. An
  // answer of any other shape -- `none`, `suspended` (never reached), or a
  // body that is not this endpoint's at all -- draws nothing: the banner must
  // never invent a standing from a response it did not understand.
  if (me === null || (me.state !== "warned" && me.state !== "rate_limited")) return null;

  const tone =
    me.state === "rate_limited"
      ? "border-mw-warning bg-mw-warning-subtle text-mw-text"
      : "border-mw-border bg-mw-surface-raised text-mw-text";
  const appeal = me.appeal_path ?? `${POLICY_PATH}#appeal`;
  return (
    <section
      role="status"
      aria-label={`${STATE_LABEL[me.state]} under the Acceptable Use Policy`}
      data-enforcement-state={me.state}
      className={`border-b px-4 py-2 text-sm ${tone}`}
    >
      <p className="mx-auto flex max-w-5xl flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium">{enforcementHeadline(me)}</span>
        {me.reason && <span>{me.reason}</span>}
        {me.expires_at && <span className="text-mw-text-muted">Ends {formatWhen(me.expires_at)}.</span>}
        <a href={appeal} className="underline underline-offset-2">
          Read the policy and how to appeal
        </a>
      </p>
    </section>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
