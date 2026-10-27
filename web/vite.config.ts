/// <reference types="vitest/config" />
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type ProxyOptions } from "vite";

// Dev-only: the SPA talks to the API same-origin; this proxy provides that in
// dev. Production serves the built SPA from FastAPI itself, no config needed.
//
// The target may be a shared environment (https://app.mw.local, the dev
// gateway: docs/dev-environment.md, "The web app against dev"). Its
// certificate is from the gateway's own CA, which Node trusts through
// NODE_EXTRA_CA_CERTS - verification stays on.
const proxyTarget = process.env.API_PROXY_TARGET ?? "http://localhost:8000";

// changeOrigin rewrites Host to the target's, and every hop in front of the
// API (Caddy, the ingress) replaces X-Forwarded-Host with the host it was
// asked for, so the API cannot tell a login started here from one on its
// own origin. This header names the browser's origin; the API sends the
// login back here only when it is configured to (MW_OIDC_REDIRECT_URIS),
// and ignores it otherwise.
const proxy: ProxyOptions = {
  target: proxyTarget,
  changeOrigin: true,
  configure: (server) => {
    server.on("proxyReq", (proxyReq, req) => {
      const scheme = (req.socket as { encrypted?: boolean }).encrypted
        ? "https"
        : "http";
      proxyReq.setHeader(
        "x-mw-public-origin",
        `${scheme}://${req.headers.host}`,
      );
    });
  },
};

export default defineConfig({
  // Lingui first: its native macro transform runs before the JSX transform
  // (enforce: "pre"), and the same plugin compiles the .po catalogues on
  // import, so no generated catalogue is committed. lingui.config.ts.
  plugins: [lingui({ macroTransform: true, failOnCompileError: true }), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": proxy,
      "/healthz": proxy,
      "/readyz": proxy,
    },
  },
  // The unit-test runner. jsdom because the modules under test use
  // sessionStorage, location and atob/btoa; nothing heavier is pulled in.
  // test-setup.ts polyfills matchMedia, which jsdom lacks.
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
