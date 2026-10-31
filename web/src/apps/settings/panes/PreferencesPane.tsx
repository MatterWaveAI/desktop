import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { Button } from "../../../components/ui/button";
import { SimpleSelect } from "../../../components/ui/select";
import { DEVICE_LOCALE, LOCALES, useLocalePreference, type LocalePreference } from "../../../i18n/locale";
import { ApiError, apiFetch } from "../../../lib/api";
import {
  desktopGlobalShortcutState,
  desktopSetGlobalShortcut,
  isDesktop,
  type DesktopGlobalShortcutState,
} from "../../../lib/desktopAuth";
import { useThemePreference, type ThemePreference } from "../../../shell/theme";
import type { Preferences } from "../../../types";
import { PaneSection } from "../PaneSection";
import {
  canSpeak,
  DEFAULT_READ_ALOUD,
  loadReadAloudSettings,
  RATE_CHOICES,
  saveReadAloudSettings,
  type ReadAloudSettings,
  type SpeechSynthesisVoiceLike,
} from "../../chat/tts";

const THEME_CHOICES: ReadonlyArray<{
  value: ThemePreference;
  label: MessageDescriptor;
  icon: ReactNode;
}> = [
  { value: "system", label: msg`System`, icon: <MonitorIcon className="size-4" /> },
  { value: "light", label: msg`Light`, icon: <SunIcon className="size-4" /> },
  { value: "dark", label: msg`Dark`, icon: <MoonIcon className="size-4" /> },
];

/**
 * The theme control, as a radiogroup rather than the header's cycling
 * toggle: on a settings page the three choices should all be visible and
 * directly selectable. It drives `useThemePreference` — the
 * same store the header toggle and the pre-paint script read, so the two
 * controls stay in step without either owning the state.
 */
function ThemeChoice() {
  const { t, i18n } = useLingui();
  const { preference, resolved, setPreference } = useThemePreference();
  return (
    <div>
      <div role="radiogroup" aria-label={t`Theme`} className="flex flex-wrap gap-2">
        {THEME_CHOICES.map((choice) => {
          const selected = preference === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setPreference(choice.value)}
              className={`flex min-h-9 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm pointer-coarse:min-h-11 ${
                selected
                  ? "border-ring bg-mw-surface-active font-medium"
                  : "border-border text-mw-text-secondary hover:bg-mw-surface-hover"
              }`}
            >
              {choice.icon}
              {i18n._(choice.label)}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-sm text-mw-text-muted">
        {preference === "system" ? (
          resolved === "dark" ? (
            <Trans>Following your device, which is currently dark.</Trans>
          ) : (
            <Trans>Following your device, which is currently light.</Trans>
          )
        ) : preference === "dark" ? (
          <Trans>Always dark.</Trans>
        ) : (
          <Trans>Always light.</Trans>
        )}
      </p>
    </div>
  );
}

/**
 * The language select. "Match device" is the default and means the
 * browser's language, narrowed to one this build ships; the rest are the
 * shipped catalogues, each named in its own language, with a draft marked
 * as such until a native speaker has reviewed it.
 *
 * The choice applies the moment it is made -- the page re-renders in the
 * new language, which is the only confirmation that matters -- and is
 * remembered on this device at once and on the account when the API
 * answers. The account copy is what another device adopts at sign-in
 * (boot.tsx); a save that fails leaves the device copy standing and says so.
 */
function LanguageChoice() {
  const { t } = useLingui();
  const { preference, locale, setPreference } = useLocalePreference();
  const [state, setState] = useState<"idle" | "saving" | "saved" | "device-only">("idle");

  async function choose(next: LocalePreference) {
    setState("saving");
    await setPreference(next);
    try {
      // The API validates the preferences as one shape, so the current one
      // is read and sent back with only the locale changed.
      const current = await apiFetch<Preferences>("/api/me/preferences");
      await apiFetch<Preferences>("/api/me/preferences", {
        method: "PUT",
        json: { ...current, locale: next === DEVICE_LOCALE ? null : next },
      });
      setState("saved");
    } catch {
      setState("device-only");
    }
  }

  const selectId = "preferences-language";
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={selectId} className="text-sm font-medium">
        <Trans>Language</Trans>
      </label>
      <SimpleSelect<LocalePreference>
        id={selectId}
        value={preference}
        onValueChange={(next) => void choose(next)}
        className="w-full max-w-xs"
        options={[
          { value: DEVICE_LOCALE, label: t`Match device` },
          // Each catalogue named in its own language, so the label carries
          // that language for a screen reader to pronounce.
          ...LOCALES.map((option) => ({
            value: option.tag,
            label: <span lang={option.tag}>{option.label}</span>,
          })),
        ]}
      />
      <p aria-live="polite" className="text-sm text-mw-text-muted">
        {state === "device-only" ? (
          <Trans>Saved on this device only; the account could not be updated.</Trans>
        ) : state === "saved" ? (
          <Trans>Saved to your account.</Trans>
        ) : preference === DEVICE_LOCALE ? (
          <Trans>Following your device, which is currently {locale}.</Trans>
        ) : null}
      </p>
    </div>
  );
}

function Toggle(props: {
  label: ReactNode;
  hint: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 py-2 text-sm">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        aria-disabled={props.disabled || undefined}
        onChange={(event) => props.onChange?.(event.target.checked)}
        className="mt-0.5 accent-mw-accent"
      />
      <span className="flex flex-col">
        <span>{props.label}</span>
        <span className="text-xs text-mw-text-muted">{props.hint}</span>
      </span>
    </label>
  );
}

/**
 * The mail and notification toggles, kept by `PUT /api/me/preferences`.
 * The whole shape goes up every save -- the API validates it as one --
 * so a toggle the API does not know is a 422 here, never a silent drop.
 * Receipts are shown but fixed on: the API refuses to turn them off, and
 * a disabled control says so better than a missing one.
 */
function EmailPreferences() {
  const { i18n } = useLingui();
  const [saved, setSaved] = useState<Preferences | null>(null);
  const [draft, setDraft] = useState<Preferences | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const body = await apiFetch<Preferences>("/api/me/preferences");
        if (!alive) return;
        setSaved(body);
        setDraft(body);
      } catch (err) {
        if (!alive) return;
        setLoadError(
          err instanceof ApiError ? err.message : i18n._(msg`Could not load your email preferences.`),
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [i18n]);

  const save = useCallback(async () => {
    if (!draft) return;
    setState("saving");
    setSaveError(null);
    try {
      const body = await apiFetch<Preferences>("/api/me/preferences", {
        method: "PUT",
        json: draft,
      });
      setSaved(body);
      setDraft(body);
      setState("saved");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : i18n._(msg`Could not save your preferences.`));
      setState("idle");
    }
  }, [draft, i18n]);

  if (loadError) {
    return (
      <p role="alert" className="text-sm text-mw-danger">
        {loadError}
      </p>
    );
  }
  if (!draft || !saved) {
    return (
      <p className="text-sm text-mw-text-muted">
        <Trans>Loading preferences…</Trans>
      </p>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: (current: Preferences) => Preferences) => {
    setDraft((current) => (current ? patch(current) : current));
    if (state === "saved") setState("idle");
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset className="divide-y divide-border">
        <legend className="pb-1 text-sm font-medium">
          <Trans>Email</Trans>
        </legend>
        <Toggle
          label={<Trans>Product updates</Trans>}
          hint={<Trans>Occasional mail about new models and features.</Trans>}
          checked={draft.email.product_updates}
          onChange={(checked) =>
            set((p) => ({ ...p, email: { ...p.email, product_updates: checked } }))
          }
        />
        <Toggle
          label={<Trans>Usage alerts</Trans>}
          hint={<Trans>Mail when your organisation nears its budget or plan allowance.</Trans>}
          checked={draft.email.usage_alerts}
          onChange={(checked) =>
            set((p) => ({ ...p, email: { ...p.email, usage_alerts: checked } }))
          }
        />
        <Toggle
          label={<Trans>Billing receipts</Trans>}
          hint={<Trans>Always sent: receipts are part of the transaction, not marketing.</Trans>}
          checked
          disabled
        />
      </fieldset>
      {/* Not mail: a notice in the app itself, saved with the same form
          because the API keeps both in one preferences shape. */}
      <fieldset className="mt-2 divide-y divide-border">
        <legend className="pb-1 text-sm font-medium">
          <Trans>In the app</Trans>
        </legend>
        <Toggle
          label={<Trans>Budget warnings</Trans>}
          hint={<Trans>Show a notice in the app when the organisation's budget is nearly spent.</Trans>}
          checked={draft.notifications.budget_warn}
          onChange={(checked) =>
            set((p) => ({ ...p, notifications: { ...p.notifications, budget_warn: checked } }))
          }
        />
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!dirty || state === "saving"}>
          {state === "saving" ? <Trans>Saving…</Trans> : <Trans>Save preferences</Trans>}
        </Button>
        <span aria-live="polite" className="text-sm text-mw-text-muted">
          {state === "saved" && !dirty && <Trans>Preferences saved.</Trans>}
        </span>
        {saveError && (
          <span role="alert" className="text-sm text-mw-danger">
            {saveError}
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * Preferences: theme (this device), language (this device and the
 * account), email (this account) and -- where this browser can speak --
 * the voice and pace the read-aloud speaker button uses.
 */
export function PreferencesPane() {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-7">
      <PaneSection
        title={t`Theme`}
        description={t`Applies on this device. “System” follows your OS setting live.`}
      >
        <ThemeChoice />
      </PaneSection>

      <PaneSection
        title={t`Language`}
        description={t`The language of the app's own text. Conversations are never translated.`}
      >
        <LanguageChoice />
      </PaneSection>

      <PaneSection
        title={t`Notifications`}
        description={t`Which mail this account receives, and what the app warns you about. Receipts and security mail are always sent.`}
      >
        <EmailPreferences />
      </PaneSection>

      {canSpeak() && <ReadAloudChoice />}

      {isDesktop() && <GlobalHotkeyChoice />}
    </div>
  );
}

/** A voice as the list shows it: its name, and what it speaks. */
function voiceLabel(voice: SpeechSynthesisVoiceLike): string {
  return `${voice.name} (${voice.lang})`;
}

/**
 * The chord as a person reads it: "CommandOrControl" is the plugin's
 * portable spelling, and what it means -- Ctrl on Windows and Linux, Cmd
 * on a Mac -- is what the label should say.
 */
function friendlyAccelerator(accelerator: string, apple = /Mac/.test(navigator.platform)): string {
  return accelerator
    .split("+")
    .map((part) => {
      const key = part.trim();
      switch (key.toLowerCase()) {
        case "commandorcontrol":
        case "cmdorctrl":
          return apple ? "Cmd" : "Ctrl";
        case "command":
        case "cmd":
        case "meta":
        case "super":
          return "Cmd";
        case "control":
        case "ctrl":
          return "Ctrl";
        case "option":
        case "alt":
          return apple ? "Option" : "Alt";
        default:
          return key.charAt(0).toUpperCase() + key.slice(1);
      }
    })
    .join("+");
}

/** The chords the pane offers beside the default and Off. */
const HOTKEY_CHOICES: readonly string[] = [
  "CommandOrControl+Shift+K",
  "CommandOrControl+Alt+M",
  "CommandOrControl+Shift+Space",
];

/**
 * The global hotkey quick-summon, desktop only: the chord that summons or
 * hides the window from anywhere. The registration is the native side's
 * (src-tauri/src/hotkey.rs), which also persists the choice -- the chord
 * must work before this page is up. A chord another application holds is
 * refused by the OS; the pane says so and the previous chord keeps working.
 */
export function GlobalHotkeyChoice() {
  const [state, setState] = useState<DesktopGlobalShortcutState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    desktopGlobalShortcutState()
      .then((loaded) => {
        if (!cancelled) setState(loaded);
      })
      .catch(() => {
        // No native side to answer (or an older app): render nothing rather
        // than a control that cannot work.
        if (!cancelled) setState({ accelerator: null, default: "" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = useCallback(async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      setState(await desktopSetGlobalShortcut(value === "" ? null : value));
    } catch (err) {
      setError(
        typeof err === "string" && err
          ? `${err} The previous shortcut keeps working.`
          : "The shortcut could not be registered; the previous one keeps working.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  if (state === null || state.default === "") {
    // Still loading, or there is no native side to register with.
    return null;
  }

  const options = [
    { value: state.default, label: `${friendlyAccelerator(state.default)} (default)` },
    ...HOTKEY_CHOICES.filter((choice) => choice !== state.default).map((choice) => ({
      value: choice,
      label: friendlyAccelerator(choice),
    })),
    { value: "", label: "Off" },
  ];

  return (
    <PaneSection
      title="Global hotkey"
      description="Summon or hide MatterWave from anywhere, even when the window is hidden. Registered with the operating system, so it works before the app is in front."
    >
      <div className="flex flex-col gap-2">
        <label htmlFor="preferences-global-hotkey" className="text-sm font-medium">
          Shortcut
        </label>
        <SimpleSelect<string>
          id="preferences-global-hotkey"
          value={state.accelerator ?? ""}
          onValueChange={(next) => void choose(next)}
          disabled={busy}
          className="w-full max-w-xs"
          options={options}
        />
        <p aria-live="polite" className="text-sm text-mw-text-muted">
          {state.accelerator === null
            ? "Off: the app is summoned from its taskbar or tray icon."
            : `${friendlyAccelerator(state.accelerator)} is registered with the operating system.`}
          {error && (
            <span role="alert" className="block text-mw-danger">
              {error}
            </span>
          )}
        </p>
      </div>
    </PaneSection>
  );
}

/**
 * Read aloud: the voice and pace the speaker button under a reply uses
 * (chat/tts.ts). Client-side only -- the words go to the operating system's
 * voices and never over the network. Chosen per device, like the theme; a
 * browser without speechSynthesis never sees the section at all.
 */
export function ReadAloudChoice() {
  const [voices, setVoices] = useState<readonly SpeechSynthesisVoiceLike[]>([]);
  const [settings, setSettings] = useState<ReadAloudSettings>(loadReadAloudSettings);

  useEffect(() => {
    const synth = canSpeak() ? (globalThis as { speechSynthesis: { getVoices(): readonly SpeechSynthesisVoiceLike[]; onvoiceschanged: (() => void) | null } }).speechSynthesis : null;
    if (!synth) return;
    const refresh = () => setVoices(synth.getVoices());
    refresh();
    // Chromium fills the voice list a moment after launch; the event is
    // how the pane learns.
    synth.onvoiceschanged = refresh;
    return () => {
      synth.onvoiceschanged = null;
    };
  }, []);

  const choose = useCallback((next: ReadAloudSettings) => {
    setSettings(next);
    saveReadAloudSettings(next);
  }, []);

  // SimpleSelect takes strings, so the voice choice rides its URI (with ""
  // as "let the engine decide") and the rate its "1.25" spelling. A stored
  // voice the list does not have reads as Automatic -- that is what really
  // happens -- with the note below saying what was kept.
  const voiceValue =
    settings.voiceURI !== null && voices.some((voice) => voice.voiceURI === settings.voiceURI)
      ? settings.voiceURI
      : "";
  const rateValue = String(settings.rate);
  return (
    <PaneSection
      title="Read aloud"
      description="The voice and pace the speaker button under a reply uses. Your browser's speech voices, on this device; nothing is sent anywhere."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="preferences-read-aloud-voice" className="text-sm font-medium">
            Voice
          </label>
          <SimpleSelect<string>
            id="preferences-read-aloud-voice"
            value={voiceValue}
            onValueChange={(next) => choose({ ...settings, voiceURI: next === "" ? null : next })}
            className="w-full max-w-xs"
            options={[
              { value: "", label: "Automatic" },
              ...voices.map((voice) => ({ value: voice.voiceURI, label: voiceLabel(voice) })),
            ]}
          />
          <p className="text-sm text-mw-text-muted">
            {settings.voiceURI === null
              ? "Automatic picks a voice for the reply's language."
              : voices.some((voice) => voice.voiceURI === settings.voiceURI)
                ? "This voice reads every reply, whatever its language."
                : "This voice is not available right now; Automatic is used until it is."}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="preferences-read-aloud-rate" className="text-sm font-medium">
            Pace
          </label>
          <SimpleSelect<string>
            id="preferences-read-aloud-rate"
            value={rateValue}
            onValueChange={(next) => choose({ ...settings, rate: Number(next) })}
            className="w-full max-w-xs"
            options={RATE_CHOICES.map((rate) => ({
              value: String(rate),
              label: rate === DEFAULT_READ_ALOUD.rate ? `Normal (${rate}×)` : `${rate}×`,
            }))}
          />
        </div>
      </div>
    </PaneSection>
  );
}
