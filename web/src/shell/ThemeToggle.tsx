import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import type { ReactNode } from "react";
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

/**
 * Three-state theme control: cycles system → light → dark.
 * The icon and label name the *preference*, not the resolved theme — under
 * "system" the resolved theme is whatever the OS says, live.
 */
export function ThemeToggle() {
  const { preference, setPreference } = useThemePreference();
  const next = CYCLE[preference];
  return (
    <button
      type="button"
      className="inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded p-1.5 hover:bg-mw-surface-hover"
      onClick={() => setPreference(next)}
      aria-label={`Theme: ${preference}. Switch to ${next}.`}
      title={`Theme: ${preference} (switch to ${next})`}
    >
      {ICON[preference]}
    </button>
  );
}
