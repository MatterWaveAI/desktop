import { LegalPage, type LegalDocument } from "./LegalPage";
import { POLICY_PATH } from "./frontDoor";

/**
 * Terms of Service, as they stand for the pre-release service: what the
 * service is, what an account holder agrees to and how the agreement ends.
 * The "last updated" date and the API's version line say plainly which
 * revision this is, and the intro says they will be updated before general
 * availability. The version bump lives in the API (`TERMS_VERSION`), not
 * here; what each version changed is `termsChanges.ts`.
 */
const TERMS: LegalDocument = {
  title: "Terms of Service",
  lastUpdated: "2026-10-22",
  intro: (
    <p>
      These terms govern your use of MatterWave, the platform your AI apps run on. By
      creating an account you accept them on behalf of yourself and, where you sign up
      for an organisation, on behalf of that organisation. These are the pre-release
      terms for MatterWave. They will be updated before general availability, and the
      version you accepted is recorded on your account.
    </p>
  ),
  sections: [
    {
      heading: "The service",
      body: (
        <p>
          MatterWave provides hosted access to language models and the applications
          built on them. Features, models and limits may change while the service is in
          development. We will give reasonable notice of changes that reduce what your
          organisation can do.
        </p>
      ),
    },
    {
      heading: "Your account",
      body: (
        <>
          <p>
            One email address, one account, one organisation. You are responsible for
            keeping your password private and for everything done through your account.
            Tell us at once if you believe it has been used without your permission.
          </p>
          <p>
            An organisation&apos;s administrators may add members, attach a single
            sign-on provider, set spending limits and remove members. They act for the
            organisation, and the organisation is responsible for their actions.
          </p>
        </>
      ),
    },
    {
      heading: "Acceptable use",
      body: (
        <p>
          You may not use the service to break the law, to infringe another
          person&apos;s rights, to generate material intended to harm or deceive, or to
          probe, overload or interfere with the platform. We may suspend an account or
          an organisation that does so, and will say why unless the law prevents it.
          The <a href={POLICY_PATH} className="text-mw-link underline underline-offset-2">Acceptable Use Policy</a>{" "}
          sets out what is not allowed, the steps we take, and how to appeal.
        </p>
      ),
    },
    {
      heading: "Your content",
      body: (
        <p>
          What you send to a model and what it returns is yours. We store it so that
          your conversations persist and you can export or delete them, and we do not
          use it to train models. Operational metadata - token counts, model names,
          latency - is kept to run and bill the service.
        </p>
      ),
    },
    {
      heading: "Plans, fees and limits",
      body: (
        <>
          <p>
            Every plan includes a monthly allowance of tokens, counted with each
            model&apos;s multiplier, as listed on the Plans page. On the Free plan,
            requests stop at the allowance until the month resets.
          </p>
          <p>
            An organisation&apos;s owner or administrators can subscribe to a paid plan
            on the Plans page, billed monthly or annually in advance at the listed
            price. A plan sold per seat is charged for each member. Where a plan offers
            a free trial, the payment method collected when subscribing is charged when
            the trial ends unless the subscription is cancelled first. Fees agreed with
            your organisation in writing take precedence over the listed prices.
          </p>
          <p>
            On a monthly paid plan, usage past the allowance continues at each
            model&apos;s listed price and is billed as overage on the next invoice, up to
            an overage cap. The cap starts at the plan&apos;s monthly price (per seat, on
            a plan sold per seat) and an administrator can change it; once it is
            reached, requests are refused until the month resets. Annual plans have no
            overage: requests stop at the allowance until the month resets. An
            administrator can also set a spending budget that stops requests sooner.
          </p>
          <p>
            A cancelled subscription runs to the end of the period already paid for. If
            a payment is late we tell your organisation, and may limit overage, new API
            keys and plan changes, and then move the organisation to the Free plan,
            until it is paid. Late payment never deletes your content.
          </p>
        </>
      ),
    },
    {
      heading: "Ending the agreement",
      body: (
        <p>
          You can delete your account at any time from Settings. We may end the
          agreement with notice, or without notice where an account breaches these
          terms. On termination your content is deleted after the retention period set
          out in the Privacy Policy.
        </p>
      ),
    },
    {
      heading: "Liability",
      body: (
        <p>
          The service is provided as-is during its pre-release period. To the extent the
          law allows, we are not liable for loss arising from model output, from
          downtime, or from anything you build on the platform. Nothing here limits
          liability that cannot be limited by law.
        </p>
      ),
    },
    {
      heading: "Changes to these terms",
      body: (
        <p>
          When the terms change we publish a new version here with a new date, and the
          version number recorded against your account tells us which text you
          accepted. Continuing to use the service after a change means accepting the
          new version.
        </p>
      ),
    },
  ],
};

export function TermsPage() {
  return <LegalPage document={TERMS} showVersion />;
}
