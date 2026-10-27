import { useState, type ReactNode } from "react";
import { PageHeader, EmptyState, ErrorState, LoadingSkeleton } from "../patterns";
import { AppErrorBoundary } from "../shell/AppErrorBoundary";
import {
  AwaitingFirstToken,
  ConversationListSkeleton,
  NewConversationState,
  OfflineBanner,
  RequestReference,
  StreamingIndicator,
  TranscriptError,
  TranscriptSkeleton,
} from "../apps/chat/ChatStates";
import { STREAM_ERROR_KINDS } from "../apps/chat/streamErrors";

/**
 * Every designed state on one page.
 *
 * The point is reviewability. Each of these states is reached in production by
 * a failure — the gateway down, a session expiring mid-stream, a budget
 * spent — and none of them can be reviewed by waiting for that failure to
 * happen. Here they are all mounted at once, with no API and no error to
 * reproduce, so the copy and the layout can be read and corrected.
 *
 * Registered behind the `dev_states` flag, the same way /dev/tokens is: it is
 * host-owned scaffolding, never an end-user app, and it stays out of the nav
 * until the flag is on.
 */

function Section(props: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="border-t border-mw-border px-4 py-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-mw-text-muted">
        {props.title}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-mw-text-muted">{props.note}</p>
      <div className="mt-4 rounded-xl border border-mw-border bg-mw-surface">{props.children}</div>
    </section>
  );
}

/** Throws on demand, so the boundary below can be seen catching something real. */
function Exploder(props: { boom: boolean }) {
  if (props.boom) throw new Error("Deliberate render failure from /dev/states.");
  return (
    <p className="p-4 text-sm text-mw-text-muted">
      This app is fine. Press the button to make it throw during render.
    </p>
  );
}

export function StatesPage() {
  const [picked, setPicked] = useState<string>("");
  const [boom, setBoom] = useState(false);

  return (
    <div className="h-full overflow-y-auto bg-mw-surface text-mw-text">
      <PageHeader
        title="UI states"
        description="Every empty, loading and error state the app designs, rendered without reproducing the failure behind it."
      />

      <Section
        title="New conversation"
        note="The first impression: product line, AI disclosure, and four example prompts. Clicking a card SENDS it; 'Edit first' fills the composer instead. The model picker sits above this in the real surface."
      >
        <NewConversationState
          onPickPrompt={(prompt) => setPicked(`[edit] ${prompt}`)}
          onSendPrompt={(prompt) => setPicked(`[send] ${prompt}`)}
        />
        <p className="border-t border-mw-border px-4 py-2 text-xs text-mw-text-muted">
          Last card action: <span data-testid="picked-prompt">{picked || "—"}</span>
        </p>
      </Section>

      <Section
        title="New conversation — offline"
        note="The same surface with sending disabled. The cards must not offer an action that is guaranteed to fail, so they are dimmed and inert rather than hidden."
      >
        <NewConversationState
          onPickPrompt={() => undefined}
          onSendPrompt={() => undefined}
          disabled
        />
      </Section>

      <Section
        title="Loading"
        note="Skeletons shaped like the content that is coming, so nothing jumps when it lands. No spinners on content areas."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="border-r border-mw-border">
            <p className="px-4 pt-3 text-xs text-mw-text-muted">Conversation list</p>
            <ConversationListSkeleton />
          </div>
          <div>
            <p className="px-4 pt-3 text-xs text-mw-text-muted">Message load</p>
            <TranscriptSkeleton />
          </div>
        </div>
        <div className="border-t border-mw-border">
          <p className="px-4 pt-3 text-xs text-mw-text-muted">Generic pattern</p>
          <LoadingSkeleton rows={3} />
        </div>
      </Section>

      <Section
        title="Streaming"
        note="Awaiting the first token is not the same state as streaming — a cold model is several seconds of silence, and unlabelled silence reads as a hang."
      >
        <div className="px-4 py-3">
          <AwaitingFirstToken />
          <StreamingIndicator />
        </div>
      </Section>

      <Section
        title="Transcript errors"
        note="Every stream failure mode, inline in the transcript rather than as a toast. Each answers 'what do I do now?'; the ones retrying cannot fix offer no retry button. Each carries the correlation id the API logged, so a screenshot leads to the trace."
      >
        <div className="px-4">
          {STREAM_ERROR_KINDS.map((kind) => (
            <TranscriptError
              key={kind}
              kind={kind}
              reference={<RequestReference requestId={`demo-${kind}-0f3c9a1b`} />}
              onRetry={() => undefined}
              onDismiss={() => undefined}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Correlation id"
        note="The reference line on its own, in both of its states. A failure that happened before the server answered has no id, and the line says so rather than rendering blank — an empty slot reads as an id that failed to load."
      >
        <div className="flex flex-col gap-2 px-4 py-3 text-xs text-mw-text-muted">
          <RequestReference requestId="01JB8Z9Q7X2MV4N6P8R0S2" />
          <RequestReference requestId={null} />
        </div>
      </Section>

      <Section
        title="Offline"
        note="Shown only when the browser reports no network, which is the reliable half of navigator.onLine. Send is disabled and the draft is kept; it clears itself on reconnect."
      >
        <OfflineBanner />
      </Section>

      <Section
        title="Empty and error patterns"
        note="The patterns the other surfaces compose, shown here so their copy is reviewed alongside the chat states."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <EmptyState
            title="No conversations yet"
            description="Your chats will be listed here once you send a first message."
          />
          <ErrorState
            title="Could not load conversations"
            message="The list could not be fetched. Your conversations are safe — this is only the sidebar."
            onRetry={() => undefined}
          />
        </div>
      </Section>

      <Section
        title="App crash"
        note="A mounted app throwing during render must lose the app, not the shell. The boundary below is the same one the registry wraps every app in."
      >
        <div className="p-4">
          <button
            type="button"
            onClick={() => setBoom(true)}
            className="mb-3 rounded-lg border border-mw-border bg-mw-surface-raised px-3 py-1.5 text-sm font-medium hover:bg-mw-surface-hover"
          >
            Throw inside the app
          </button>
          <AppErrorBoundary appName="Demo app" onReset={() => setBoom(false)}>
            <Exploder boom={boom} />
          </AppErrorBoundary>
        </div>
      </Section>
    </div>
  );
}
