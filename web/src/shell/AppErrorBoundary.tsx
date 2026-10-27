import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "../patterns";

/**
 * A boundary per mounted app.
 *
 * Apps are mounted through the registry and are not all going to be ours. One
 * of them throwing must not take the shell with it: without a boundary here a
 * single bad render white-screens the whole page, including the nav that would
 * let someone leave the broken app.
 *
 * Deliberately not one boundary at the root. A root-only boundary catches the
 * error but replaces everything, so the user loses the shell as well as the
 * app - which is the same outcome as the white screen, just prettier.
 */
export class AppErrorBoundary extends Component<
  { children: ReactNode; appName: string; onReset?: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Correlation id: the backend stamps one on every response, and
    // the same id in the console is what makes a user's screenshot findable
    // in the logs.
    console.error(`[${this.props.appName}] crashed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorState
        title={`${this.props.appName} stopped working`}
        message="The app hit an error it could not recover from."
        onRetry={() => {
          this.setState({ error: null });
          this.props.onReset?.();
        }}
        retryLabel="Reload the app"
      />
    );
  }
}
