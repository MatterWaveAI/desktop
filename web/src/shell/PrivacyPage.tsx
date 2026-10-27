import { LegalPage, type LegalDocument } from "./LegalPage";

/**
 * Privacy Policy for the pre-release service. What it says is what the code
 * does: the fields signup collects, where they go (Postgres for tenancy,
 * the identity provider for credentials), and the export and delete
 * controls that already exist in Settings.
 */
const PRIVACY: LegalDocument = {
  title: "Privacy Policy",
  lastUpdated: "2026-09-28",
  intro: (
    <p>
      This policy describes what MatterWave collects when you use the service, why, and
      what you can do about it. This is the pre-release privacy policy for MatterWave.
      It will be updated before general availability.
    </p>
  ),
  sections: [
    {
      heading: "What we collect",
      body: (
        <>
          <p>
            When you sign up: your name, email address, an optional phone number, and
            the password you choose. The password goes to our identity provider and is
            never stored by the application. Your email address is the name of your
            account.
          </p>
          <p>
            When you use the service: the conversations you have, the model each turn
            used, token counts and timings, and the API keys your organisation issues
            (stored hashed, never in the clear).
          </p>
        </>
      ),
    },
    {
      heading: "Why we collect it",
      body: (
        <p>
          To sign you in, to keep your conversations where you left them, to meter
          usage against your organisation&apos;s budget, and to tell you about changes
          to the service or your account. We do not sell personal data and we do not use
          your content to train models.
        </p>
      ),
    },
    {
      heading: "Where it lives",
      body: (
        <p>
          Account and organisation records live in our database. Credentials and
          verification codes are handled by the identity provider that backs sign-in.
          If your organisation attaches its own single sign-on provider, that provider
          sees your sign-in and its own policy applies to it.
        </p>
      ),
    },
    {
      heading: "Who sees it",
      body: (
        <p>
          The model provider that serves a request sees the content of that request.
          Administrators of your organisation can see who its members are and what the
          organisation has spent, not the content of your conversations. Our operators
          see operational metadata and never log prompt or completion text.
        </p>
      ),
    },
    {
      heading: "Your controls",
      body: (
        <p>
          Settings lets you export everything stored for your account and delete the
          account. Deletion removes your conversations and profile; a hash of the email
          address is kept so the same address cannot be re-registered, and billing
          records are kept for the period the law requires.
        </p>
      ),
    },
    {
      heading: "Cookies",
      body: (
        <p>
          The service sets a session cookie that keeps you signed in and a
          cross-site-request token that protects it. Both are strictly necessary; there
          is no analytics or advertising cookie.
        </p>
      ),
    },
    {
      heading: "Changes and contact",
      body: (
        <p>
          When this policy changes we publish it here with a new date. Questions about
          your data go to the address your organisation was given at signup.
        </p>
      ),
    },
  ],
};

export function PrivacyPage() {
  return <LegalPage document={PRIVACY} />;
}
