import { useId, useState } from "react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import {
  accountLabel,
  addAccountUrl,
  fetchAccounts,
  reloadAsSwitchedAccount,
  signOutAll,
  signOutParked,
  switchAccount,
  type AccountEntry,
} from "../lib/accounts";
import { fetchBillingStatus } from "../lib/billing";
import { loadModels } from "../lib/models";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { DEVELOPERS_PATH } from "./frontDoor";
import { HELP_PATH } from "./help";
import { useShell } from "./shellContext";
import { chordLabel, isMacPlatform, PALETTE_CHORD } from "./shortcuts";
import { useThemePreference, type ThemePreference } from "./theme";

/**
 * The account menu: who is signed in and to which organisation, the plan
 * and the way to change it, the theme, and the links out -- settings, the
 * developer pages, help -- with the command palette and sign out.
 *
 * The org is named, never identified: a person knows "Acme", not the uuid
 * the database and the IdP know it by, so a principal without a name (an
 * operator with no membership row) shows the email alone. The default
 * model is named by its label from the price list, which is the only name
 * a person has seen for it; the id is what the API knows it by.
 *
 * On the shared popover, like the sidebar's row menus: portalled and
 * placed against the viewport, so it hangs cleanly below the avatar rather
 * than being drawn over the header row's own controls, and it closes on
 * Escape and on a click outside with focus back on the avatar.
 *
 * The plan and the model list are read when the menu first opens, not when
 * the shell mounts: two requests on every page for a line most visits never
 * look at is the wrong trade. Both are best effort -- the line is simply
 * absent until the answer lands, and stays absent if it never does.
 */
export function UserMenu(props: {
  /** Open the command palette, as the keyboard chord does. */
  onOpenPalette?: () => void;
}) {
  const { t } = useLingui();
  const shell = useShell();
  const { email, subject, org_name: orgName } = shell.principal;
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<{ name: string; free: boolean } | null>(null);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  // The other accounts signed in on this browser (lib/accounts.ts), read
  // when the menu opens like the plan. Null until the list answers; a
  // list that cannot be read hides the switcher rather than guessing.
  const [accounts, setAccounts] = useState<{ others: AccountEntry[]; room: boolean } | null>(null);
  const [switching, setSwitching] = useState<number | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next || asked) return;
    setAsked(true);
    fetchAccounts()
      .then((list) =>
        setAccounts({ others: list.accounts.filter((a) => !a.current), room: list.room }),
      )
      .catch(() => undefined);
    fetchBillingStatus()
      .then((status) => setPlan({ name: status.plan_name, free: status.plan === "free" }))
      .catch(() => undefined);
    loadModels()
      .then((models) => {
        const id = shell.authConfig.default_model;
        setModelLabel(models.data.find((model) => model.id === id)?.label ?? id);
      })
      .catch(() => setModelLabel(shell.authConfig.default_model));
  }

  /**
   * Make a parked account the acting one. The server swaps the cookies;
   * the page then reloads into the other account from scratch, so nothing
   * of this one -- the list, a draft, the instructions -- carries over.
   */
  async function switchTo(account: AccountEntry) {
    setSwitching(account.slot);
    setAccountError(null);
    try {
      await switchAccount(account.slot);
      reloadAsSwitchedAccount();
    } catch {
      setAccountError(t`Could not switch accounts. That account may have been signed out.`);
      setSwitching(null);
    }
  }

  async function signOutOther(account: AccountEntry) {
    setAccountError(null);
    try {
      await signOutParked(account.slot);
      setAccounts((list) =>
        list ? { ...list, others: list.others.filter((a) => a.slot !== account.slot) } : list,
      );
    } catch {
      setAccountError(t`Could not sign that account out.`);
    }
  }

  const itemClass =
    "block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-mw-surface-hover pointer-coarse:py-3";
  // Finger-sized on a touch screen, like the rows: a 16px-tall link beside
  // the plan name is the one thing in this menu a thumb could miss.
  const planLinkClass =
    "inline-flex shrink-0 items-center text-xs underline underline-offset-2 pointer-coarse:min-h-11 pointer-coarse:px-2";
  const planName = plan?.name;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label={t`Account and organisation`}
        className="flex cursor-pointer items-center justify-center gap-1 rounded-full hover:bg-mw-surface-hover pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-mw-inverse text-xs font-medium text-mw-inverse-foreground">
          {(email ?? subject).slice(0, 1).toUpperCase()}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t`Account menu`}
        data-mw-user-menu=""
        className="w-64 gap-0 rounded-md border border-mw-border bg-mw-surface-raised p-1 text-mw-text shadow-lg ring-0"
      >
        <p className="px-2 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wide text-mw-text-muted">
          <Trans>Signed in as</Trans>
        </p>
        <div className="rounded px-2 py-1.5 text-sm">
          <p className="truncate">{email ?? subject}</p>
          {orgName && <p className="truncate text-xs text-mw-text-muted">{orgName}</p>}
          {modelLabel !== null && (
            <p className="truncate text-xs text-mw-text-muted" data-mw-default-model="">
              <Trans>Default model: {modelLabel}</Trans>
            </p>
          )}
        </div>
        {plan !== null && (
          <p
            className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm"
            data-mw-plan=""
          >
            <span className="min-w-0 truncate">
              <Trans>{planName} plan</Trans>
            </span>
            {/* Free has nothing to manage, only something to move up to; a
                paid plan is managed where its invoices are. Plain anchors,
                like the rest of the menu: it renders without a router. */}
            {plan.free ? (
              <a href="/pricing" className={planLinkClass}>
                <Trans>Upgrade</Trans>
              </a>
            ) : (
              <a href="/settings/billing" className={planLinkClass}>
                <Trans>Manage billing</Trans>
              </a>
            )}
          </p>
        )}
        {/* The other accounts on this browser, each one click away. The
            acting account is the block above, never in this list: who is
            acting has to be unmistakable, so the switcher only ever shows
            who else could be. */}
        {accounts !== null && accounts.others.length > 0 && (
          <div data-mw-accounts="" className="mt-1 flex flex-col gap-0.5">
            <p className="px-2 pb-0.5 pt-1 text-xs font-medium uppercase tracking-wide text-mw-text-muted">
              <Trans>Switch account</Trans>
            </p>
            {accounts.others.map((account) => (
              <div key={account.slot} className="flex items-center gap-1">
                <button
                  type="button"
                  className={`${itemClass} min-w-0 flex-1`}
                  disabled={switching !== null}
                  onClick={() => void switchTo(account)}
                  aria-label={t`Switch to ${accountLabel(account)}`}
                >
                  <span className="block truncate">
                    {switching === account.slot ? t`Switching…` : accountLabel(account)}
                  </span>
                  {account.org_name && (
                    <span className="block truncate text-xs text-mw-text-muted">
                      {account.org_name}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded px-2 py-1.5 text-xs text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text pointer-coarse:min-h-11"
                  disabled={switching !== null}
                  onClick={() => void signOutOther(account)}
                  aria-label={t`Sign out ${accountLabel(account)}`}
                >
                  <Trans>Sign out</Trans>
                </button>
              </div>
            ))}
          </div>
        )}
        {accounts !== null && accounts.room && (
          <a href={addAccountUrl(shell.authConfig)} className={itemClass} data-mw-add-account="">
            <Trans>Add account</Trans>
          </a>
        )}
        {accountError && (
          <p role="alert" className="px-2 py-1 text-xs text-mw-danger">
            {accountError}
          </p>
        )}
        <ThemeSwitch />
        <div role="separator" className="my-1 border-t border-mw-border" />
        <a href="/settings/account" className={itemClass}>
          <Trans>Settings</Trans>
        </a>
        <a href={DEVELOPERS_PATH} className={itemClass}>
          <Trans>Developers</Trans>
        </a>
        <a href={HELP_PATH} className={itemClass}>
          <Trans>Help</Trans>
        </a>
        {/* A button, not a reminder: the chord is spelt for the platform
            like the overlay's, and clicking the row does what the chord does. */}
        <button
          type="button"
          className={`${itemClass} flex items-center justify-between gap-2`}
          onClick={() => {
            setOpen(false);
            props.onOpenPalette?.();
          }}
        >
          <span>
            <Trans>Commands</Trans>
          </span>
          <kbd className="rounded border border-mw-border bg-mw-surface px-1 font-mono text-xs text-mw-text-muted">
            {chordLabel(PALETTE_CHORD, isMacPlatform())}
          </kbd>
        </button>
        <div role="separator" className="my-1 border-t border-mw-border" />
        {/* Two sign-outs, worded apart: this account alone leaves the
            others signed in (the front door then offers them); all of them
            ends every session on this browser. */}
        <button type="button" className={itemClass} onClick={() => void shell.signOut()}>
          <Trans>Sign out</Trans>
        </button>
        {accounts !== null && accounts.others.length > 0 && (
          <button
            type="button"
            className={itemClass}
            onClick={() => void signOutAll(shell.authConfig)}
          >
            <Trans>Sign out of all accounts</Trans>
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

const THEMES: readonly { value: ThemePreference; label: MessageDescriptor; Icon: typeof SunIcon }[] = [
  { value: "system", label: msg`System`, Icon: MonitorIcon },
  { value: "light", label: msg`Light`, Icon: SunIcon },
  { value: "dark", label: msg`Dark`, Icon: MoonIcon },
];

/**
 * The three-way theme choice, as a row of pressed buttons: the same
 * preference the header's toggle cycles, named in full here where there is
 * room to, so a person who wants "dark" need not click through "light".
 */
function ThemeSwitch() {
  const { i18n } = useLingui();
  const { preference, setPreference } = useThemePreference();
  const labelId = useId();
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5">
      <span id={labelId} className="text-sm">
        <Trans>Theme</Trans>
      </span>
      <div role="group" aria-labelledby={labelId} className="flex gap-0.5">
        {THEMES.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            aria-pressed={preference === value}
            aria-label={i18n._(label)}
            title={i18n._(label)}
            onClick={() => setPreference(value)}
            className={`inline-flex items-center justify-center rounded p-1.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${
              preference === value
                ? "bg-mw-surface-hover text-mw-text"
                : "text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text"
            }`}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}
