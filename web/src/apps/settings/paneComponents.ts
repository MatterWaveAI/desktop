import type { ComponentType } from "react";
import { AccountPane } from "./panes/AccountPane";
import { ApiKeysPane } from "./panes/ApiKeysPane";
import { BudgetPane } from "./panes/BudgetPane";
import { BillingPane } from "./panes/BillingPane";
import { CustomInstructionsPane } from "./panes/CustomInstructionsPane";
import { DataPane } from "./panes/DataPane";
import { DesktopPane } from "./panes/DesktopPane";
import { DevicesPane } from "./panes/DevicesPane";
import { MembersPane } from "./panes/MembersPane";
import { OrganisationPane } from "./panes/OrganisationPane";
import { PreferencesPane } from "./panes/PreferencesPane";
import { UsagePane } from "./panes/UsagePane";
import { WebhooksPane } from "./panes/WebhooksPane";
import { desktopDevEnabled } from "../../lib/desktopDev";

/**
 * Each pane id's component. Kept apart from panes.ts so the metadata the
 * main chunk needs (the palette, the /settings redirect) does not pull
 * every pane in with it; only SettingsPage, behind the lazy settings
 * route, imports this. settings.test.tsx checks every pane in panes.ts
 * has one here.
 *
 * The desktop diagnostics pane rides the same gate as its nav entry
 * (desktopDev.ts): a dev build inside the desktop shell, nothing else.
 */
export const paneComponents: Record<string, ComponentType> = {
  account: AccountPane,
  preferences: PreferencesPane,
  instructions: CustomInstructionsPane,
  data: DataPane,
  organisation: OrganisationPane,
  members: MembersPane,
  webhooks: WebhooksPane,
  keys: ApiKeysPane,
  devices: DevicesPane,
  usage: UsagePane,
  budget: BudgetPane,
  billing: BillingPane,
  ...(desktopDevEnabled() ? { desktop: DesktopPane } : {}),
};
