// modes.ts (vendored) reads Node's `process.platform` when there is a
// `process`; the SPA has no Node types, so the one global it touches is
// declared here. In the webview it is undefined, and agent mode passes the
// platform the native host reported instead.
declare const process: { readonly platform?: string } | undefined;
