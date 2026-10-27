import { useEffect, useState } from "react";
import { LegalPage, type LegalDocument } from "./LegalPage";
import { PRIVACY_PATH, TERMS_PATH } from "./frontDoor";
import { fetchPolicyStats, type PolicyStats } from "./policy";

/**
 * The acceptable-use policy: what is not allowed, what happens when it is,
 * how to appeal and how to report, and the numbers behind it. On the front
 * door, because a suspended person -- whose every other request is refused
 * -- must be able to read how to appeal, and because a policy nobody can
 * read before signing up is not a policy anyone agreed to.
 *
 * Plain language on purpose. The ladder below is the one the API enforces
 * (api/matterwave/enforcement.py); the page describes what the code does,
 * not what a template says. Sections carry ids so the API's 403 and the
 * shell's banner can link straight to the appeal.
 */
const POLICY: LegalDocument = {
  title: "Acceptable Use Policy",
  lastUpdated: "2026-10-24",
  intro: (
    <>
      <p>
        MatterWave gives you hosted language models and the apps built on them. Almost
        everything people do with them is fine, and this page is written for the rare
        case that is not: what we ask you not to do, what we do when it happens, and how
        you can push back if we get it wrong. It sits alongside the{" "}
        <a href={TERMS_PATH} className="underline underline-offset-2">
          Terms of Service
        </a>{" "}
        and the{" "}
        <a href={PRIVACY_PATH} className="underline underline-offset-2">
          Privacy Policy
        </a>
        .
      </p>
      <p>
        One principle runs through all of it: <strong>we do not read your conversations</strong>.
        Decisions are made from what you choose to report, from the categories a screening
        classifier returns, and from how an account behaves, never from a person reading
        your chats. Where a reviewer sees any message text, this page says so.
      </p>
    </>
  ),
  sections: [
    {
      heading: "What is not allowed",
      body: (
        <>
          <p>Do not use MatterWave to:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Generate or request sexual content involving minors. This is the one category
              the service blocks automatically, and the law requires us to act on it.
            </li>
            <li>
              Harass, threaten or incite violence against a person or group, or produce
              content designed to deceive people into harming themselves or others.
            </li>
            <li>
              Break the law or help someone else break it: fraud, unauthorised access to
              systems you do not own, or making weapons capable of mass harm.
            </li>
            <li>
              Resell, share or farm access: creating many accounts to pool free allowances,
              or proxying the service to people who have not agreed to these terms.
            </li>
            <li>
              Probe, overload or interfere with the platform, or evade a limit we have put
              on your account.
            </li>
          </ul>
          <p>
            Asking a model about these subjects is not the same as doing them. Security
            research, medicine, law, journalism and fiction all touch difficult material,
            and the models sometimes decline such requests on their own. A model declining
            is not a violation and never counts against you.
          </p>
        </>
      ),
    },
    {
      heading: "How we find out",
      body: (
        <>
          <p>
            Three ways, none of which involves anyone reading your conversations as a matter
            of course:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>You tell us.</strong> Every reply has a Report action with two
              choices. <em>Unsafe</em> reaches a person; <em>unhelpful</em> (including a
              refusal you think was wrong) goes to the product backlog. Reports are stored
              durably and rate limited against spam.
            </li>
            <li>
              <strong>A screening classifier.</strong> When input screening is configured,
              each message you send is checked by a classifier before it reaches a model.
              Only one category blocks the message; everything else is counted as a
              category and a score, with no text stored. If the classifier is slow or
              unavailable, your message goes through.
            </li>
            <li>
              <strong>How an account behaves.</strong> Signals such as request rate and
              shape, read from metadata, never from content.
            </li>
          </ul>
          <p>
            A reviewer sees message text in exactly one case: the single message a reporter
            chose to report, shown to the reviewer with the report. The surrounding
            conversation is not shown.
          </p>
        </>
      ),
    },
    {
      heading: "What happens: the ladder",
      body: (
        <>
          <p>
            Enforcement is a ladder, not a switch, and every step on it is taken by a person
            who writes down the reason first. Nothing here is automated.
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              <strong>Warning.</strong> A notice in the product saying what we saw and what
              to do differently. Most issues end here.
            </li>
            <li>
              <strong>Rate limit.</strong> Your account, or your organisation, is held to a
              smaller number of messages per hour for a set time. The limit and when it ends
              are shown to you. It expires on its own.
            </li>
            <li>
              <strong>Suspension.</strong> Signing in and every request are refused until a
              person lifts it. Your data is kept, and you can appeal.
            </li>
          </ol>
          <p>
            When an action is taken against you, the product shows a banner naming the step,
            the reason written for you, and when it ends. A suspended account sees the
            reason at sign-in.
          </p>
        </>
      ),
    },
    {
      heading: "How to appeal",
      body: (
        <div id="appeal" className="flex flex-col gap-2">
          <p>
            Every action on the ladder can be appealed, and appeals are how we find out when
            we are wrong. Write to the support address your organisation was given at signup,
            or use the support link in the product, quoting the reason you were shown and the
            request id if you have one. Say what you were doing and why.
          </p>
          <p>
            A person reads every appeal. We aim to answer within five business days, and we
            record the outcome. If an appeal is upheld, the action is lifted and does not
            count against you later.
          </p>
        </div>
      ),
    },
    {
      heading: "How to report",
      body: (
        <p>
          Use the Report action on any reply. Choose <em>unsafe</em> for anything that could
          hurt someone, is illegal, or should never have been generated; choose{" "}
          <em>unhelpful</em> for a wrong, evasive or unwarranted answer. Add a note if you can.
          You will get a report id to quote. If you see content on a shared page and have
          no account, use the support link in the page footer where the deployment shows one,
          or write to the address your organisation was given at signup.
        </p>
      ),
    },
    {
      heading: "The numbers",
      body: <PolicyNumbers />,
    },
  ],
};

/**
 * The counts behind the policy, read from the public aggregate. Zero until
 * there is data, and said as zero: a policy page that hides its numbers
 * until they flatter it is the kind people screenshot. Counts only -- the
 * endpoint returns no subject, note or reason, so none can be shown.
 */
function PolicyNumbers() {
  const [stats, setStats] = useState<PolicyStats | null | "unavailable">(null);
  useEffect(() => {
    let alive = true;
    fetchPolicyStats()
      .then((data) => alive && setStats(data))
      .catch(() => alive && setStats("unavailable"));
    return () => {
      alive = false;
    };
  }, []);

  if (stats === "unavailable") {
    return <p className="text-mw-text-muted">The counts could not be loaded right now.</p>;
  }
  if (stats === null) {
    return <p className="text-mw-text-muted">Loading the counts…</p>;
  }
  const reports = stats.reports;
  const actions = stats.enforcement;
  const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  const rows: readonly [string, number][] = [
    ["Reports received, unsafe", reports.by_kind.unsafe],
    ["Reports received, unhelpful", reports.by_kind.unhelpful],
    ["Unsafe reports still open", reports.unsafe_by_status.open],
    ["Unsafe reports that led to an action", reports.unsafe_by_status.actioned],
    ["Unsafe reports dismissed", reports.unsafe_by_status.dismissed],
    ["Warnings issued", actions.by_state.warned],
    ["Rate limits applied", actions.by_state.rate_limited],
    ["Suspensions", actions.by_state.suspended],
    ["Actions in force now", total(actions.active)],
    ["Appeals received", actions.appeals.received],
    ["Appeals upheld", actions.appeals.upheld],
  ];
  return (
    <>
      <p>
        Since the service started, counted from the same tables the review queue and the
        ladder write to. These update as the counts change; there is no editorial step.
      </p>
      <dl data-testid="policy-numbers" className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-mw-text-muted">{label}</dt>
            <dd className="text-right font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-mw-text-muted">
        Legal process received, and reports filed with authorities, are not counted here
        yet: none have happened. When they do, this list grows.
      </p>
    </>
  );
}

export function PolicyPage() {
  return <LegalPage document={POLICY} />;
}
