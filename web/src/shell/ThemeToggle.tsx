import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useThemePreference, type ThemePreference } from "./theme";

const CYCLE: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const ICON: Record<ThemePreference, ReactNode> = {
  system: <MonitorIcon width={16} height={16} />,
  light: <SunIcon width={16} height={16} />,
  dark: <MoonIcon width={16} height={16} />,
};

// Lower case: each is read mid-sentence ("Theme: dark. Switch to system.").
const NAME: Record<ThemePreference, MessageDescriptor> = {
  system: msg({ message: "system", comment: "Theme preference, mid-sentence" }),
  light: msg({ message: "light", comment: "Theme preference, mid-sentence" }),
  dark: msg({ message: "dark", comment: "Theme preference, mid-sentence" }),
};

/**
 * Three-state theme control: cycles system → light → dark.
 * The icon and label name the *preference*, not the resolved theme — under
 * "system" the resolved theme is whatever the OS says, live.
 */
export function ThemeToggle() {
  const { t, i18n } = useLingui();
  const { preference, setPreference } = useThemePreference();
  const next = CYCLE[preference];
  const current = i18n._(NAME[preference]);
  const upcoming = i18n._(NAME[next]);
  return (
    <button
      type="button"
      className="inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded p-1.5 hover:bg-mw-surface-hover"
      onClick={() => setPreference(next)}
      aria-label={t`Theme: ${current}. Switch to ${upcoming}.`}
      title={t`Theme: ${current} (switch to ${upcoming})`}
    >
      {ICON[preference]}
    </button>
  );
}
