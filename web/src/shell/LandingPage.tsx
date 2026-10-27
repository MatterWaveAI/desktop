import { useEffect, useState } from "react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import type { AuthConfig } from "../types";
import {
  fetchPlans,
  formatMultiplier,
  formatPrice,
  formatUsd,
  listOf,
  modelFamily,
  splitPartners,
  type ModelPrice,
  type PlanSummary,
} from "../lib/billing";
import { DEVELOPERS_PATH, PRICING_PATH, SIGNUP_PATH } from "./frontDoor";
import { PRODUCT_DESCRIPTION, PRODUCT_LINE } from "./productCopy";
import { FrontDoorFooter, FrontDoorHeader } from "./FrontDoorChrome";
import { FRONT_DOOR_WIDTH } from "./frontDoorLinks";
import { AssistantMark, WaveMark } from "../components/brand";

/**
 * What an unauthenticated visitor sees. Boot used to send a 401
 * straight to the IdP, which was right for cf-control's private handful of
 * principals and wrong for a public app: a stranger has to be able to read
 * what this is and choose "Create account" before anyone asks them to log in.
 *
 * Everything claimed here exists: the six panels name the chat (branches,
 * attachments, instructions, dictation, compaction), the API, SDKs and MCP
 * tools, the organisation model, the clients, sign-in, and import/export --
 * all shipped (routes.ts, the settings panes, the help page). The model
 * family comes from `GET /api/plans`: labels, weights and list prices are
 * the API's, never written here, and so are the family's name and the
 * cheapest paid plan's price. Until the catalog is in, and when it cannot be
 * fetched, the copy says "the models" and the page still reads; the model
 * table and the "from" price are the parts held back.
 *
 * The product preview is an illustration, not a screenshot: one
 * `role="img"` with a name, so a screen reader hears what it shows rather
 * than a conversation that never happened.
 *
 * Sign in is still the API's job: nothing here builds an IdP URL
 * (`SignInAction`). The calls to action are anchors, not `Link`s, for the
 * same reason the shell's nav is: each is a full route change, and an anchor
 * is what a middle-click and a copy-link expect.
 */

interface Feature {
  overline: string;
  title: string;
  body: string;
}

/** The panels that do not depend on the catalogue; `features` translates them. */
const SHARED_FEATURES: readonly { overline: MessageDescriptor; title: MessageDescriptor; body: MessageDescriptor }[] = [
  {
    overline: msg`BUILD`,
    title: msg`API, SDKs and MCP`,
    body: msg`/v1 speaks the OpenAI chat-completions format, so any OpenAI client works with a MatterWave key. Python and TypeScript SDKs, and your conversations as MCP tools.`,
  },
  {
    overline: msg`TEAMS`,
    title: msg`Seats, roles and budgets`,
    body: msg`Administrators invite members and set roles and spending limits. The Team plan is sold per seat, with every seat's tokens in one shared pool, and is the plan that adds single sign-on.`,
  },
  {
    overline: msg`EVERYWHERE`,
    title: msg`Web, terminal, VS Code, desktop`,
    body: msg`A terminal client, a VS Code extension and a desktop app share the same conversations as the web.`,
  },
  {
    overline: msg`SECURE`,
    title: msg`Passkeys and sign-on`,
    body: msg`Passkeys, two-step sign-in, your organisation's single sign-on, and attachments scanned before a model reads them.`,
  },
  {
    overline: msg`YOURS`,
    title: msg`Import and export`,
    body: msg`Bring ChatGPT and Claude history in; export a conversation or everything on your account. Nothing you write is used to train models.`,
  },
];

/** The overlines alternate the link blue and the emerald, as the logo's two waves do. */
const OVERLINE_TONES = ["text-mw-link", "text-mw-positive"] as const;

const CTA_PRIMARY =
  "inline-flex min-h-12 items-center rounded-xl bg-mw-accent px-6 text-base font-semibold text-mw-accent-foreground shadow-lg hover:bg-mw-accent-hover";
const CTA_OUTLINE =
  "inline-flex min-h-12 items-center rounded-xl border border-mw-border-emphasis px-6 text-base font-medium text-mw-text hover:bg-mw-surface-hover";

const SECTION_TITLE = "font-display text-display-lg";

/** "GRT Nano Pro" in a family "GRT Nano": the family upright, the tier word in italic. */
function ModelName(props: { label: string; family: string | null }) {
  const { label, family } = props;
  if (!family || !label.startsWith(family) || label.length === family.length) return <>{label}</>;
  return (
    <>
      {family} <em>{label.slice(family.length).trim()}</em>
    </>
  );
}

/** The cheapest plan that costs anything, monthly: what "plans from" quotes. */
function cheapestPaid(plans: readonly PlanSummary[]): PlanSummary | null {
  const paid = plans.filter((plan) => plan.price_cents_monthly > 0);
  if (paid.length === 0) return null;
  return paid.reduce((low, plan) => (plan.price_cents_monthly < low.price_cents_monthly ? plan : low));
}

export function LandingPage(props: { config: AuthConfig }) {
  const { t, i18n } = useLingui();
  const [models, setModels] = useState<ModelPrice[] | null>(null);
  const [fromPlan, setFromPlan] = useState<PlanSummary | null>(null);
  const family = models ? modelFamily(models) : null;
  const labels = models?.map((model) => model.label) ?? [];

  useEffect(() => {
    let alive = true;
    fetchPlans()
      .then((catalog) => {
        if (!alive) return;
        setModels(splitPartners(catalog.models).own);
        setFromPlan(cheapestPaid(catalog.plans));
      })
      .catch(() => {
        // The page reads without the table; the plans page is linked anyway.
      });
    return () => {
      alive = false;
    };
  }, []);

  /** The six panels, with the chat one naming the models the catalog lists. */
  function features(): readonly Feature[] {
    const onModels = listOf(labels);
    return [
      {
        overline: t`CHAT`,
        title: t`Conversations that keep up`,
        body:
          labels.length > 0
            ? t`Branches, attachments, custom instructions, dictation, and compaction when a thread runs long, on ${onModels}. The model that wrote each reply is named under it.`
            : t`Branches, attachments, custom instructions, dictation, and compaction when a thread runs long. The model that wrote each reply is named under it.`,
      },
      ...SHARED_FEATURES.map((feature) => ({
        overline: i18n._(feature.overline),
        title: i18n._(feature.title),
        body: i18n._(feature.body),
      })),
    ];
  }

  const fromPrice = fromPlan ? formatPrice(fromPlan.price_cents_monthly) : null;

  return (
    <div className="h-full overflow-y-auto bg-mw-surface text-mw-text">
      <FrontDoorHeader config={props.config} />
      <main>
        <section
          data-landing-hero
          className={`${FRONT_DOOR_WIDTH} flex flex-col items-center gap-6 pt-16 pb-10 text-center sm:pt-24`}
        >
          <WaveMark width={420} className="h-auto max-w-full" />
          <h1 className="max-w-4xl font-display text-display-lg sm:text-display-xl">
            <Trans>
              Models that <em>move</em> with you.
            </Trans>
          </h1>
          <p className="max-w-2xl text-lg text-mw-text-subtle">{i18n._(PRODUCT_DESCRIPTION)}</p>
          <div className="flex flex-wrap justify-center gap-3">
            <a href={SIGNUP_PATH} className={CTA_PRIMARY}>
              <Trans>Start free</Trans>
            </a>
            <a href={DEVELOPERS_PATH} className={CTA_OUTLINE}>
              <Trans>Read the docs</Trans>
            </a>
          </div>
          <p className="text-sm text-mw-text-muted">
            <span aria-hidden className="mr-2 inline-block size-2 rounded-full bg-mw-positive-strong align-middle" />
            <Trans>Free plan, no card. Nothing you write trains a model.</Trans>
          </p>
        </section>

        <section aria-label={t`Product preview`} className={`${FRONT_DOOR_WIDTH} pt-6 pb-20`}>
          <div
            role="img"
            aria-label={t`An illustration of a MatterWave conversation: a request for five bullets and the start of the reply.`}
            className="flex flex-col gap-4 rounded-2xl border border-mw-border-emphasis bg-mw-surface-raised p-5 shadow-lg sm:p-7"
          >
            <p className="max-w-[85%] self-end rounded-2xl rounded-br-sm border border-mw-inverse-border bg-mw-inverse px-3.5 py-2.5 text-left text-mw-inverse-foreground">
              <Trans>Summarise the board update in five bullets.</Trans>
            </p>
            <div className="flex items-start gap-3">
              <AssistantMark />
              <p className="text-mw-text-secondary">
                <Trans>
                  Here it is, ready to paste: revenue finished ahead of plan, the Team plan launched, two roles remain
                  open…
                </Trans>
              </p>
            </div>
          </div>
        </section>

        <section aria-labelledby="landing-features" className="border-t border-mw-border">
          <div className={`${FRONT_DOOR_WIDTH} flex flex-col gap-10 py-20`}>
            <div className="flex flex-col gap-2">
              <h2 id="landing-features" className={SECTION_TITLE}>
                <Trans>
                  One platform, <em>every surface</em>
                </Trans>
              </h2>
              <p className="text-mw-text-subtle">{i18n._(PRODUCT_LINE)}</p>
            </div>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {features().map((feature, index) => (
                <li
                  key={feature.title}
                  className="flex flex-col gap-2 rounded-xl border border-mw-border bg-mw-surface-raised p-6"
                >
                  <p className={`font-mono text-xs tracking-wide ${OVERLINE_TONES[index % 2]}`}>{feature.overline}</p>
                  <h3 className="text-lg font-semibold">{feature.title}</h3>
                  <p className="text-mw-text-subtle">{feature.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="landing-models" className="border-t border-mw-border">
          <div className={`${FRONT_DOOR_WIDTH} flex flex-col gap-7 py-20`}>
            <div className="flex flex-col gap-2">
              <h2 id="landing-models" className={SECTION_TITLE}>
                {family ? (
                  <Trans>
                    The {family} <em>family</em>
                  </Trans>
                ) : (
                  <Trans>
                    The <em>models</em>
                  </Trans>
                )}
              </h2>
              <p className="max-w-2xl text-mw-text-subtle">
                <Trans>
                  Priced per million tokens. Each model spends your plan's allowance at its own weight, so an allowance
                  buys the same dollars of list price whichever model you pick. Paid plans add the dearer models;{" "}
                  <a
                    href={PRICING_PATH}
                    className="inline-flex min-h-6 items-center text-mw-link underline underline-offset-2 hover:text-mw-link-hover pointer-coarse:min-h-11"
                  >
                    the Plans page
                  </a>{" "}
                  says which.
                </Trans>
              </p>
            </div>
            {models && models.length > 0 && (
              <div
                role="region"
                aria-labelledby="landing-models"
                tabIndex={0}
                className="overflow-x-auto rounded-xl border border-mw-border"
              >
                <table aria-label={t`Models`} className="w-full min-w-xl border-collapse tabular-nums">
                  <thead>
                    <tr className="bg-mw-surface-raised text-left text-sm text-mw-text-muted">
                      <th scope="col" className="px-5 py-3.5 font-medium">
                        <Trans>Model</Trans>
                      </th>
                      <th scope="col" className="px-5 py-3.5 font-medium">
                        <Trans>Prompt</Trans>
                      </th>
                      <th scope="col" className="px-5 py-3.5 font-medium">
                        <Trans>Completion</Trans>
                      </th>
                      <th scope="col" className="px-5 py-3.5 font-medium">
                        <Trans>Allowance weight</Trans>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((model) => (
                      <tr key={model.id} data-model={model.id} className="border-t border-mw-border">
                        <th scope="row" className="px-5 py-4 text-left font-display text-2xl">
                          <ModelName label={model.label} family={family} />
                        </th>
                        <td className="px-5 py-4">{formatUsd(model.input_usd_per_m)}</td>
                        <td className="px-5 py-4">{formatUsd(model.output_usd_per_m)}</td>
                        <td className="px-5 py-4">{formatMultiplier(model.multiplier)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <section aria-labelledby="landing-start" className="border-t border-mw-border">
          <div className={`${FRONT_DOOR_WIDTH} flex flex-col items-center gap-5 py-24 text-center`}>
            <h2 id="landing-start" className={SECTION_TITLE}>
              <Trans>
                Start on <em>Free</em>.
              </Trans>
            </h2>
            <p className="text-mw-text-subtle">
              {fromPrice ? (
                <Trans>Upgrade for more models, more tokens or a team. Paid plans from {fromPrice} a month.</Trans>
              ) : (
                <Trans>Upgrade for more models, more tokens or a team.</Trans>
              )}
            </p>
            <a href={SIGNUP_PATH} className={CTA_PRIMARY}>
              <Trans>Create your account</Trans>
            </a>
          </div>
        </section>
      </main>
      <FrontDoorFooter config={props.config} />
    </div>
  );
}
