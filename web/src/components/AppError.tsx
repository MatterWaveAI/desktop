import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { msg, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { CircleAlertIcon, HomeIcon, RotateCwIcon } from "lucide-react";
import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { i18n } from "../i18n/runtime";
import { Button, buttonVariants } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { Wordmark } from "./brand";

/**
 * The failure surfaces a route or a section falls back to.
 *
 *   - RouteError: the router's `defaultErrorComponent`. A whole page failed,
 *     so it offers Retry and a way out (Go home).
 *   - ErrorBoundary: for a pane, tab or card to wrap itself in, so one
 *     section throwing loses that section and not the page around it.
 *   - ErrorFallback: the presentational part both render, for anything that
 *     catches its own errors and wants the same look.
 *   - RoutePending: the router's `defaultPendingComponent`, shown while a
 *     lazy route's chunk is loading.
 */

/**
 * A chunk that will not load is not a bug in the page: the deploy moved on
 * and the old file is gone. Re-rendering asks for the same missing file, so
 * the only retry that can work is a full reload.
 */
function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|Loading chunk|module script/i.test(
    message,
  );
}

const PAGE_FAILURE = msg`This page hit an error it could not recover from. Retry.`;
const SECTION_FAILURE = msg`This section could not be shown. Retry.`;

/**
 * What the user reads. Never the exception text: "x.map is not a function"
 * means nothing to them and can leak internals. The raw error goes to the
 * console (componentDidCatch, or the router's own logging) instead.
 */
function describe(error: unknown, fallback: MessageDescriptor | string): string {
  if (isChunkLoadError(error)) {
    return t`A newer version of MatterWave is available. Reload to pick it up.`;
  }
  return typeof fallback === "string" ? fallback : i18n._(fallback);
}

export function ErrorFallback(props: {
  title?: string;
  message?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  /** Where Go home leads; omit to hide it (a section inside a page has no need). */
  homeHref?: string;
  /** `page` fills its slot and carries the brand; `section` is compact. */
  variant?: "page" | "section";
}) {
  const page = props.variant !== "section";
  return (
    <div
      role="alert"
      data-slot="error-fallback"
      data-variant={page ? "page" : "section"}
      className={
        page
          ? "flex h-full min-h-80 flex-col items-center justify-center gap-3 px-4 py-12 text-center"
          : "flex flex-col items-center justify-center gap-2 rounded-lg border border-mw-border bg-mw-surface-raised px-4 py-8 text-center"
      }
    >
      {page && (
        <Wordmark size="sm" />
      )}
      <span className="flex size-10 items-center justify-center rounded-full bg-mw-danger-subtle text-mw-danger">
        <CircleAlertIcon aria-hidden className="size-5" />
      </span>
      <p className={page ? "text-xl font-semibold" : "text-base font-medium"}>
        {props.title ?? <Trans>Something went wrong</Trans>}
      </p>
      {props.message && <p className="max-w-md text-sm text-mw-text-muted">{props.message}</p>}
      {(props.onRetry || props.homeHref) && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {props.onRetry && (
            <Button onClick={props.onRetry}>
              <RotateCwIcon aria-hidden />
              {props.retryLabel ?? <Trans>Retry</Trans>}
            </Button>
          )}
          {props.homeHref && (
            // A plain link, not the router's: after a crash a full load of
            // the front page is the recovery least likely to hit it again.
            <a href={props.homeHref} className={buttonVariants({ variant: "outline" })}>
              <HomeIcon aria-hidden />
              <Trans>Go home</Trans>
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** The router's error page: Retry re-runs the route, Go home leaves it. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useLingui();
  const router = useRouter();
  const chunk = isChunkLoadError(error);
  return (
    <ErrorFallback
      title={chunk ? t`MatterWave was updated` : t`This page could not load`}
      message={describe(error, PAGE_FAILURE)}
      retryLabel={chunk ? t`Reload` : t`Retry`}
      onRetry={() => {
        if (chunk) {
          window.location.reload();
          return;
        }
        // invalidate re-runs loaders; reset clears the boundary so the
        // component renders again.
        void router.invalidate();
        reset();
      }}
      homeHref="/"
    />
  );
}

/** The router's not-found page: an address nothing in the app answers. */
export function RouteNotFound() {
  const { t } = useLingui();
  const tabTitle = t`Page not found · MatterWave`;
  // No route matched, so no route's `head` names this page: the tab would
  // keep whatever title the last page left. Set here, and put back on the
  // way out so the next page's own title is not overwritten.
  useEffect(() => {
    const previous = document.title;
    document.title = tabTitle;
    return () => {
      document.title = previous;
    };
  }, [tabTitle]);
  return (
    <ErrorFallback
      title={t`Page not found`}
      message={t`Nothing lives at this address. It may have moved, or the link may be mistyped.`}
      homeHref="/"
    />
  );
}

type FallbackRender = (args: { error: Error; reset: () => void }) => ReactNode;

/**
 * Wrap a pane, tab or card in this so its crash stays inside it.
 *
 *   <ErrorBoundary name="Webhooks">
 *     <WebhooksPane />
 *   </ErrorBoundary>
 *
 * `resetKeys` clears the error when any of them changes -- pass the pane id
 * so switching panes does not keep showing the last one's failure.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode;
    /** Names the section in the fallback title and the console line. */
    name?: string;
    /** App copy for the fallback; the raw error is only ever logged. */
    message?: string;
    fallback?: FallbackRender;
    onReset?: () => void;
    resetKeys?: readonly unknown[];
    variant?: "page" | "section";
  },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.name ?? "section"}] crashed`, error, info.componentStack);
  }

  componentDidUpdate(previous: { resetKeys?: readonly unknown[] }) {
    if (this.state.error === null) return;
    const before = previous.resetKeys ?? [];
    const after = this.props.resetKeys ?? [];
    if (before.length !== after.length || before.some((key, i) => !Object.is(key, after[i]))) {
      this.setState({ error: null });
    }
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback({ error, reset: this.reset });
    const name = this.props.name;
    return (
      <ErrorFallback
        variant={this.props.variant ?? "section"}
        title={name ? t`${name} stopped working` : undefined}
        message={describe(
          error,
          this.props.message ?? (this.props.variant === "page" ? PAGE_FAILURE : SECTION_FAILURE),
        )}
        onRetry={isChunkLoadError(error) ? () => window.location.reload() : this.reset}
        homeHref={this.props.variant === "page" ? "/" : undefined}
      />
    );
  }
}

/** Page-shaped placeholder while a route's chunk loads. */
export function RoutePending() {
  return (
    <div role="status" className="flex flex-col gap-4 p-6">
      <span className="sr-only">
        <Trans>Loading…</Trans>
      </span>
      <div aria-hidden className="flex flex-col gap-4">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-4 w-full max-w-lg" />
        <Skeleton className="h-32 w-full max-w-2xl" />
      </div>
    </div>
  );
}
