import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Per-message boundary. A malformed table or a renderer that
 * throws on one message must not blank the thread: the failure is contained to
 * the message that caused it, and the raw text is still shown so the content
 * is not lost.
 */
export class MarkdownErrorBoundary extends Component<
  { children: ReactNode; fallbackText: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("markdown render failed", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="whitespace-pre-wrap text-sm leading-relaxed">
        <p className="mb-1 text-xs text-mw-text-muted">
          This message could not be formatted; showing it as plain text.
        </p>
        {this.props.fallbackText}
      </div>
    );
  }
}
