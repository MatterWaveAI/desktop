import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { I18nProvider } from "@lingui/react";
import { router } from "./routes";
import { installDesktopAuth } from "./lib/desktopAuth";
import { installDesktopNavigation } from "./lib/desktopNavigation";
import { installExternalLinks } from "./lib/desktopLinks";
import { i18n } from "./i18n/runtime";
import { initLocale } from "./i18n/locale";
import "./styles.css";

// Before the first render: Boot's first request must already go through the
// desktop shell's bearer path. A no-op in a browser.
installDesktopAuth();
// Links opened from outside the app (`matterwave://conversation/...`), the
// launch link included. A no-op in a browser.
installDesktopNavigation((href) => void router.navigate({ href }));
// Links out of the app open in the system browser, not in the webview.
installExternalLinks();

// The catalogue before the first paint, so nothing renders in one language
// and re-renders in another. Immediate for the source locale, which is in
// this chunk; one small fetch for any other.
void initLocale().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    </StrictMode>,
  );
});
