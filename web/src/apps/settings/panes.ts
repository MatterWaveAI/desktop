/*
 * Metadata only -- ids, titles, groups, descriptions -- and no pane
 * components. routes.ts and the command palette import this from the main
 * chunk; the components are mapped to ids in paneComponents.ts, which only
 * the lazily loaded settings route imports, so the panes' code stays out of
 * the first paint.
 */

import { desktopDevEnabled } from "../../lib/desktopDev";

/**
 * The nav's headings. Twelve panes in one flat row wrapped to four rows on
 * a phone; grouped by whose settings they are, the side nav reads as three
 * short lists and the phone strip scrolls instead of wrapping.
 */
export const SETTINGS_GROUPS = ["You", "Organisation", "Plan and usage"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/**
 * The platform's own settings panes. This is deliberately a flat list and
 * not a registry: a slot mechanism that lets an *app* contribute a pane is
 * a separate feature. These exist whether or not a second app ever
 * installs, so they are declared here and the settings page renders them.
 * API keys and Budget are platform concerns too (a key calls the API, a
 * budget caps the org), not an app's.
 *
 * Each pane is a container its feature fills. A pane whose feature has not
 * landed still renders: a stub, never a 404, so the feature writes UI and
 * not navigation.
 */
export interface SettingsPane {
  /** URL segment: `/settings/<id>`. */
  id: string;
  title: string;
  group: SettingsGroup;
  /** One line under the tab, naming what the pane is for. */
  description: string;
}

const DESKTOP_DEV_PANE: SettingsPane = {
  id: "desktop",
  group: "You",
  title: "Desktop diagnostics",
  description: "Dev only: capability flags, a test notification, and the updater's stages.",
};

const basePanes: readonly SettingsPane[] = [
  {
    id: "account",
    group: "You",
    title: "Account",
    description: "Who you are, how you sign in, and where you are signed in.",
  },
  {
    id: "preferences",
    group: "You",
    title: "Preferences",
    description: "Theme, language and notifications.",
  },
  {
    // Its own pane rather than a section of Preferences. It is the
    // pane people are sent to ("set your custom instructions"), it needs a
    // URL of its own for that, and the two fields plus their counters are
    // more than a Preferences section should hold.
    id: "instructions",
    group: "You",
    title: "Custom instructions",
    description: "What MatterWave should know about you, and how it should respond.",
  },
  {
    id: "data",
    group: "You",
    title: "Data",
    description: "Export or import your conversations, manage shared links, or delete the account.",
  },
  {
    id: "organisation",
    group: "Organisation",
    title: "Organisation",
    // Names its three tabs: General (name, domains, instructions, models),
    // Sign-in & security, and the audit log.
    description: "Name, domains and models; sign-in and security; the audit log.",
  },
  {
    // The membership model: every member sees the list, the caller's
    // org role decides which actions the pane offers.
    id: "members",
    group: "Organisation",
    title: "Members",
    description: "People in your organisation and what they can do.",
  },
  {
    // Beside Members rather than inside Organisation: an endpoint is the
    // org's, managed by the same owners and admins, and the delivery log
    // and the once-shown secret need a URL of their own to be sent to.
    id: "webhooks",
    group: "Organisation",
    title: "Webhooks",
    description: "Where this organisation's events are posted, and how each delivery went.",
  },
  {
    id: "keys",
    group: "Organisation",
    title: "API keys",
    description: "Tokens for scripts and other clients. Shown once, revocable any time.",
  },
  {
    // Beside API keys: a paired box is a key that can only add
    // conversations, made and revoked here rather than in the keys form.
    // On a box the same pane takes the pairing code instead.
    id: "devices",
    group: "Organisation",
    title: "Devices",
    description: "Edge boxes that mirror their conversations here, and pairing new ones.",
  },
  {
    id: "usage",
    group: "Plan and usage",
    title: "Usage",
    description: "What you have spent against your plan this period.",
  },
  {
    id: "budget",
    group: "Plan and usage",
    title: "Budget",
    description: "Included tokens this month, and the cap on what more may cost.",
  },
  {
    // The plan and the hand-off to Stripe's portal. Beside Budget
    // rather than merged with it: Budget is the token allowance and the
    // overage CAP an admin sets, Billing is the PLAN the org pays for, and a
    // person who conflates the two goes looking for the cap in the wrong place.
    id: "billing",
    group: "Plan and usage",
    title: "Billing",
    description: "Your plan, when it renews, and where to change it.",
  },
];

/**
 * What the nav lists. The desktop diagnostics pane exists only in a dev
 * build inside the desktop shell (desktopDev.ts): the prove-it runs --
 * capability flags, a test notification, the updater's stages -- have no
 * meaning anywhere else, and a release build must not ship them.
 */
export const settingsPanes: readonly SettingsPane[] = desktopDevEnabled()
  ? [...basePanes, DESKTOP_DEV_PANE]
  : basePanes;

export const DEFAULT_PANE_ID = settingsPanes[0].id;

export function findPane(id: string | undefined): SettingsPane {
  return settingsPanes.find((pane) => pane.id === id) ?? settingsPanes[0];
}
