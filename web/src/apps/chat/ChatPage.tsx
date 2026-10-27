import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { JUMP_TO_MESSAGE_EVENT, type JumpToMessageDetail } from "../../shell/useConversationSearch";
import type { ChatMessage, ChatModelAdapter, MessagePart } from "./chatAdapter";
import { useChatThread, type ThreadPhase } from "./useChatThread";
import type {
  Conversation,
  ConversationWithMessages,
  EffectiveInstructions,
  Message,
  ModelInfo,
} from "../../types";
import { ApiError, apiFetch, currentToken } from "../../lib/api";
import { useShell } from "../../shell/shellContext";
import { useOnline } from "../../shell/useOnline";
import { createChatAdapter, textOfParts } from "./chatAdapter";
import { ModelPicker } from "./ModelPicker";
import { InstructionsBadge } from "./InstructionsBadge";
import { MessageParts } from "./MessageParts";
import { classifyStreamError, isMissingConversation, type StreamFailure } from "./streamErrors";
import { useBranchedThread, type BranchedMessage } from "./useBranchedThread";
import { useStickToBottom } from "./useStickToBottom";
import { useMountedSession } from "./useMountedSession";
import { useStopShortcut } from "./useStopShortcut";
import { isEditLastKey, lastEditableId, useCopyShortcuts } from "./chatShortcuts";
import { DeleteConversationShortcut } from "./DeleteConversationShortcut";
import { JumpToLatest } from "./JumpToLatest";
import { MessageTime } from "./MessageTime";
import { loadDraft, saveDraft } from "./drafts";
import { AttachmentChips } from "./AttachmentChips";
import { AttachmentPicker, DropOverlay } from "./AttachmentPicker";
import { useAttachments, type UseAttachments } from "./useAttachments";
import type { PendingAttachment } from "./attachments";
import {
  anyFailed,
  anyUploading,
  dragHasFiles,
  filesFromPaste,
  humanSize,
  isImageType,
  localTypeOf,
  readyIds,
} from "./attachments";
import { visionCapableIds, visionOf, visionRefusal } from "./vision";
import { MessageEditor } from "./BranchControls";
import { useAutosize } from "./useAutosize";
import { ErrorBoundary } from "../../components/AppError";
import { useSupportReadOnly } from "./supportMode";
import { MessageControls } from "./MessageControls";
import { fetchTree, forkConversation } from "./branchApi";
import { defaultLeaf } from "./branches";
import { conversationHref, writeConversationUrl } from "../../shell/useShellState";
import {
  AwaitingFirstToken,
  PhaseAnnouncer,
  StoppedNote,
  NewConversationState,
  OfflineBanner,
  RequestReference,
  StreamingIndicator,
  TranscriptError,
  ConversationMissing,
  TranscriptSkeleton,
} from "./ChatStates";
import { ConversationActions, type ExportFormat } from "./ConversationActions";
import { ReportDialog } from "./ReportDialog";
import { ShareDialog } from "./ShareDialog";
import { TemporaryNotice, TemporaryToggle } from "./TemporaryChat";
import { fetchFeedback, type Feedback } from "./feedback";
import { COMPACT_HINT, CompactionDivider, ContextMeter, SummaryMarker } from "./CompactionDivider";
import { DictationButton, DictationNotices } from "./DictationButton";
import { useDictation } from "./useDictation";
import {
  compactConversation,
  endedOnLength,
  endedStopped,
  fetchContext,
  foldPath,
  meterReading,
  readingOfContext,
  readingOfFrame,
  resolveWindow,
  type CompactionFrame,
  type ContextFrame,
  type ContextReading,
} from "./compaction";
import { CommandMenu } from "./CommandMenu";
import { optionId, useCommandMenu } from "./useCommandMenu";
import {
  canCompact,
  contextNotice,
  helpNotice,
  parseCommand,
  runCompact,
  unknownCommandNotice,
  type ParsedCommand,
} from "./commands";
import {
  conversationToJson,
  conversationToMarkdown,
  downloadText,
  safeFilename,
} from "./exportConversation";

/** How long after a reload the first look for a reply that was streaming waits. */
const REATTACH_FIRST_MS = 750;
/** How many looks, doubling the wait each time, before the turn is left as it is. */
const REATTACH_TRIES = 4;

/** Chat, mounted as app #1 through the app registry. */
export function ChatPage() {
  const shell = useShell();
  const activeId = shell.activeConversationId;

  // Which conversation is mounted: held still while a new chat creates its
  // own, and remounted empty by New chat (useMountedSession).
  const session = useMountedSession(activeId);
  const sessionId = session.sessionId;
  // Where each conversation branched in this session came from, by its id.
  // The API's fork answers with the copy alone and records no parent, so
  // the "Branched from" line can only be drawn for a branch made here.
  const [origins, setOrigins] = useState<ReadonlyMap<string, BranchOrigin>>(() => new Map());

  useEffect(() => {
    // A link (a search hit, a bookmark, a shared ?c=) names the conversation
    // to open. Only when nothing is open yet: on a cold load both ids are
    // null, which is exactly the case this exists for.
    if (activeId !== null) return;
    const fromUrl = new URLSearchParams(location.search).get("c");
    if (fromUrl) shell.selectConversation(fromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A crash inside one conversation is that conversation's: the shell and
  // the sidebar stay, and opening another one (or Retry) starts clean.
  return (
      <ErrorBoundary name="This conversation" resetKeys={[session.key]}>
      <ChatSession
        key={session.key}
        conversationId={sessionId}
        onConversationCreated={(conversation) => {
          session.created(conversation.id);
          shell.onConversationCreated(conversation);
        }}
        onSettled={() => {
          session.settled();
          void shell.reloadConversations();
        }}
        origin={sessionId === null ? null : (origins.get(sessionId) ?? null)}
        onBranched={(forked, parent) => {
          setOrigins((current) => new Map(current).set(forked.id, parent));
          // Pushed, so Back returns to the conversation it was cut from;
          // the shell's own write is then a no-op on the same address.
          writeConversationUrl(forked.id, "push");
          shell.onConversationCreated(forked);
        }}
    />
    </ErrorBoundary>
  );
}

/** The conversation a branch was cut from: enough to name and reopen it. */
interface BranchOrigin {
  id: string;
  title: string;
}

function ChatSession(props: {
  conversationId: string | null;
  onConversationCreated: (conversation: Conversation) => void;
  onSettled: () => void;
  /** Where this conversation was branched from, when it was branched here. */
  origin: BranchOrigin | null;
  /** A branch was made: the new conversation, and the one it came from. */
  onBranched: (forked: Conversation, parent: BranchOrigin) => void;
}) {
  const shell = useShell();
  const [history, setHistory] = useState<Message[] | null>(null);
  // The whole tree and the server's cursor, for the branch switcher.
  const [tree, setTree] = useState<Message[]>([]);
  const [leaf, setLeaf] = useState<string | null>(null);
  // What is in force for this conversation, as the API computed
  // it. Loaded with the transcript because it comes in the same response, and
  // held here so a save from the badge updates the banner without a refetch.
  const [instructions, setInstructions] = useState<EffectiveInstructions | null>(null);
  // Whether the stored conversation is temporary, from the same GET.
  const [temporary, setTemporary] = useState(false);
  // The load failure keeps its kind, not its raw body: the transcript error
  // component owns the wording (the "never show a raw error body" rule).
  const [loadError, setLoadError] = useState<StreamFailure | null>(null);
  // The conversation is not there (a 404): its own state, since a Retry
  // would only ask again for a row that is gone.
  const [missing, setMissing] = useState(false);
  // Incremented by the retry action to re-run the load for the same id.
  const [reloadToken, setReloadToken] = useState(0);
  // Looking for the reply that was streaming when the page reloaded, and how
  // many transcripts that look has brought in (the effect below says why).
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [generation, setGeneration] = useState(0);
  // A message to bring into view once it is on screen: `?m=` on the link
  // that opened this conversation, or the sidebar's search-result event. A
  // ref, not state: it is consumed by the scroll, never rendered; the tick
  // only re-runs the scroll when an event arrives for an already-loaded tree.
  const jumpTo = useRef<string | null>(new URLSearchParams(location.search).get("m"));
  const [jumpTick, setJumpTick] = useState(0);
  useEffect(() => {
    const onJump = (event: Event) => {
      const detail = (event as CustomEvent<JumpToMessageDetail>).detail;
      if (detail.conversationId === props.conversationId && detail.messageId) {
        jumpTo.current = detail.messageId;
        setJumpTick((n) => n + 1);
      }
    };
    window.addEventListener(JUMP_TO_MESSAGE_EVENT, onJump);
    return () => window.removeEventListener(JUMP_TO_MESSAGE_EVENT, onJump);
  }, [props.conversationId]);
  useEffect(() => {
    const id = jumpTo.current;
    if (!id) return;
    const row = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    // Not rendered yet (the transcript is still loading): the effect runs
    // again when the tree arrives.
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.setAttribute("data-mw-jumped", "true");
    jumpTo.current = null;
  }, [jumpTick, tree]);

  useEffect(() => {
    let alive = true;
    if (!props.conversationId) {
      // Queued, not synchronous: a setState in the effect body runs before
      // paint and costs an extra render pass.
      queueMicrotask(() => {
        if (alive) {
          setHistory([]);
          setTree([]);
          setLeaf(null);
        }
      });
      return () => {
        alive = false;
      };
    }
    // No reset to null/null here. The parent keys this component by session id
    // (`key={sessionId ?? "new"}`), so a different conversation remounts it
    // with fresh state - resetting would only ever re-set what the mount
    // already set.
    // `?full=1` brings the tree with the path in one request: the
    // switcher needs the siblings the path leaves out, and a second round
    // trip would show a transcript that cannot branch yet.
    apiFetch<ConversationWithMessages>(`/api/conversations/${props.conversationId}?full=1`)
      .then((conversation) => {
        if (!alive) return;
        setHistory(conversation.messages);
        setTree(conversation.tree ?? conversation.messages);
        setLeaf(conversation.current_leaf_message_id ?? null);
        setInstructions(conversation.instructions);
        setTemporary(conversation.temporary === true);
        setAwaitingReply(conversation.messages.at(-1)?.role === "user");
      })
      .catch((err: unknown) => {
        if (alive && isMissingConversation(err)) {
          setMissing(true);
        } else if (alive) {
          setLoadError({
            kind:
              err instanceof ApiError
                ? classifyStreamError(err.message, err.status)
                : classifyStreamError(err instanceof Error ? err.message : ""),
            // The id of the failed GET, so a conversation that will not open
            // is diagnosable from the screen the user is stuck on.
            requestId: err instanceof ApiError ? err.requestId : null,
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [props.conversationId, reloadToken]);

  // A transcript that ends on the person's own turn, just after a reload,
  // is usually a reply that was streaming when the page went: the server
  // keeps what arrived when the stream closes, a moment after this read.
  // So the conversation is asked again, briefly and with backoff, and the
  // stored partial reply is picked up -- shown as stopped, with Continue --
  // rather than the question sitting there unanswered.
  useEffect(() => {
    const id = props.conversationId;
    if (!awaitingReply || !id) return;
    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      timer = setTimeout(() => {
        apiFetch<ConversationWithMessages>(`/api/conversations/${id}?full=1`)
          .then((conversation) => {
            if (!alive) return;
            if (conversation.messages.at(-1)?.role === "assistant") {
              setHistory(conversation.messages);
              setTree(conversation.tree ?? conversation.messages);
              setLeaf(conversation.current_leaf_message_id ?? null);
              setAwaitingReply(false);
              setGeneration((n) => n + 1);
            } else if (++tries < REATTACH_TRIES) {
              ask();
            } else {
              setAwaitingReply(false);
            }
          })
          .catch(() => {
            if (alive) setAwaitingReply(false);
          });
      }, REATTACH_FIRST_MS * 2 ** tries);
    };
    ask();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [awaitingReply, props.conversationId]);

  if (missing) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <ConversationMissing />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <TranscriptError
          kind={loadError.kind}
          reference={<RequestReference requestId={loadError.requestId} />}
          onRetry={() => {
            setLoadError(null);
            setHistory(null);
            // Bumping the token re-runs the load effect; the conversation id
            // has not changed, so it is the only thing that can.
            setReloadToken((token) => token + 1);
          }}
        />
        <a href="/apps/chat" className="text-sm underline">
          Start a new chat
        </a>
      </div>
    );
  }
  // Skeleton, not a spinner: it is shaped like the transcript that is coming,
  // so the page does not jump when the messages land.
  if (history === null) return <TranscriptSkeleton />;

  return (
    <ThreadRuntime
      /* Remounted when a reattach brings the stored reply: the runtime
         reads its transcript once, on mount. */
      key={generation}
      reattaching={awaitingReply}
      conversationId={props.conversationId}
      history={history}
      tree={tree}
      leaf={leaf}
      instructions={instructions}
      onInstructionsChanged={setInstructions}
      temporary={temporary}
      onConversationCreated={props.onConversationCreated}
      onSettled={props.onSettled}
      onRenamed={shell.onConversationRenamed}
      origin={props.origin}
      onBranched={props.onBranched}
    />
  );
}

function ThreadRuntime(props: {
  /** Looking for the reply that was streaming when the page reloaded. */
  reattaching: boolean;
  conversationId: string | null;
  history: Message[];
  /** Every message, for the switcher; empty for a conversation not yet saved. */
  tree: Message[];
  /** The server's recorded branch cursor, if it sent one. */
  leaf: string | null;
  instructions: EffectiveInstructions | null;
  onInstructionsChanged: (next: EffectiveInstructions) => void;
  /** The stored conversation is temporary; false for a new chat. */
  temporary: boolean;
  onConversationCreated: (conversation: Conversation) => void;
  onSettled: () => void;
  onRenamed: (conversationId: string, title: string) => void;
  origin: BranchOrigin | null;
  onBranched: (forked: Conversation, parent: BranchOrigin) => void;
}) {
  // The classified failure and its correlation id, not its text.
  // Every stream failure mode lands here and renders as one inline component
  // at the end of the transcript, where the message it belongs to is. The id
  // rides along because a stream that dies mid-answer began as a 200: there is
  // no ApiError to hang it on, so it has to be carried from the start.
  const shell = useShell();
  const [error, setError] = useState<StreamFailure | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // The gateway's model list, for the composer's vision gate.
  // Reported by the picker, which fetches it anyway.
  const [models, setModels] = useState<readonly ModelInfo[] | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  // The last real count for this conversation: from `/context` on open,
  // then from the `context` frame beside every `done`. Null until either
  // has answered, which is different from a model with no window.
  const [context, setContext] = useState<ContextReading | null>(null);
  // How many recent exchanges a fold keeps, as `/context` says. The server
  // owns the rule (a deployment setting), so the "nothing to compact"
  // notice quotes its number rather than a copy of it; null until it has
  // answered, when the 409's own detail carries the number instead.
  const [keepPairs, setKeepPairs] = useState<number | null>(null);
  // A fold that failed or had nothing to do, or a command's answer.
  // Information, not an error: no turn was lost, so it does not take the
  // error slot or offer a retry.
  const [notice, setNotice] = useState<string | null>(null);
  // Answers this session saw end on the token limit, by id. The stored
  // message says so too; this covers the turn before the tree is refetched.
  const [lengthCut, setLengthCut] = useState<ReadonlySet<string>>(() => new Set());
  const online = useOnline();
  const idRef = useRef(props.conversationId);
  // Mirrors idRef for rendering. The ref is what the adapter reads (it must not
  // trigger a rebuild), but reading a ref during render is unsafe, so anything
  // the JSX needs comes from state instead.
  const [conversationId, setConversationId] = useState(props.conversationId);
  const modelRef = useRef<string | null>(null);
  // Temporary chat: the switch on a new chat, or the stored flag of an open
  // one. The ref is what the adapter reads when the first send creates the
  // conversation; the state is what the header and the notice render.
  const [temporary, setTemporary] = useState(props.temporary);
  const temporaryRef = useRef(props.temporary);
  // The adapter reports a detail string; it is classified here and the string
  // itself is dropped. Nothing downstream can render it by accident. The
  // correlation id is kept, because it is the one piece of the failure that is
  // safe to show and useful to quote.
  const reportError = useCallback(
    (detail: string, meta?: { requestId?: string | null; code?: string }) => {
      setError({
        kind: classifyStreamError(detail, undefined, meta?.code),
        requestId: meta?.requestId ?? null,
      });
    },
    [],
  );
  const hooksRef = useRef({
    onConversationCreated: props.onConversationCreated,
    onSettled: props.onSettled,
    onRenamed: props.onRenamed,
    onBranched: props.onBranched,
    onError: reportError,
  });
  // Kept current in an effect rather than during render: writing a ref while
  // rendering is unsafe under concurrent rendering, where a render can be
  // discarded or replayed. The adapter reads these through the ref, so it sees
  // the latest props without being rebuilt every time one changes.
  useEffect(() => {
    hooksRef.current = {
      onConversationCreated: props.onConversationCreated,
      onSettled: props.onSettled,
      onRenamed: props.onRenamed,
      onBranched: props.onBranched,
      onError: reportError,
    };
  }, [props.onConversationCreated, props.onSettled, props.onRenamed, props.onBranched, reportError]);

  // The adapter is built once and stays identical for the life of the session,
  // so an in-flight stream is never dropped by a re-render. It reaches the
  // current conversation, model and callbacks through refs. The getters are
  // only ever called later, from the adapter's own async work - never while
  // this component renders - so the rule's concern does not apply here.
  // The summary a send folded before its turn goes to the tree half, which
  // is built after the adapter; the ref is how the adapter reaches it.
  const compactionRef = useRef<(frame: CompactionFrame) => void>(() => undefined);
  /* eslint-disable react-hooks/refs, react-hooks/preserve-manual-memoization --
     see the note above: the empty dep array is deliberate, and the compiler
     cannot preserve a memo whose inputs it cannot see through the refs. */
  const adapter = useMemo<ChatModelAdapter>(
    () =>
      createChatAdapter({
        getConversationId: () => idRef.current,
        getModel: () => modelRef.current,
        getTemporary: () => temporaryRef.current,
        onConversationCreated: (conversation) => {
          idRef.current = conversation.id;
          setConversationId(conversation.id);
          hooksRef.current.onConversationCreated(conversation);
        },
        onRenamed: (id, title) => hooksRef.current.onRenamed(id, title),
        onSettled: () => hooksRef.current.onSettled(),
        // `meta` forwarded, not dropped: it carries the correlation id and the
        // refusal code, and a one-argument wrapper here silently threw both
        // away — the id reached this line and got no further.
        onError: (message, meta) => hooksRef.current.onError(message, meta),
        onCompaction: (frame) => compactionRef.current(frame),
        // State setters are stable, so these need no ref.
        onContext: (frame) => setContext(readingOfFrame(frame)),
        onNotice: setNotice,
        onLengthTruncated: (id) => setLengthCut((current) => new Set(current).add(id)),
      }),
    [],
  );
  /* eslint-enable react-hooks/refs, react-hooks/preserve-manual-memoization */

  // Carried through as message metadata so "which model said this"
  // stays answerable for stored messages too.
  const initialMessages: ChatMessage[] = useMemo(
    () =>
      props.history
        // Stored history can include system messages; the thread shows the
        // conversation, so they are not rendered.
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({
          role: message.role as "user" | "assistant",
          // A reload shows what the stream drew. The API sends `parts`
          // and, for a client that predates this ticket, the flattened
          // `content` beside it; an API that predates it sends only
          // `content`, which is one text part.
          content: message.parts ?? [{ type: "text" as const, text: message.content }],
          metadata:
            message.model === null ? undefined : { custom: { model: message.model } },
        })),
    [props.history],
  );

  const thread = useChatThread(adapter, initialMessages);

  // The tree half. It owns the stored transcript and its branches;
  // `thread` above still owns one in-flight send, which is the exchange the
  // adapter is streaming and which has no server ids yet.
  const onBranchContext = useCallback((frame: ContextFrame) => setContext(readingOfFrame(frame)), []);
  const branches = useBranchedThread({
    conversationId,
    initialTree: props.tree,
    initialLeaf: props.leaf,
    getModel: () => modelRef.current,
    onError: reportError,
    onSettled: () => hooksRef.current.onSettled(),
    onContext: onBranchContext,
    onNotice: setNotice,
  });

  // The count on open, so a long conversation shows how full it is before
  // the first turn of this visit. A failure leaves the meter on the model
  // list's window with nothing counted, which the first `done` corrects.
  // The id comes from the ref, as `reloadTree` reads it: a conversation
  // started in this session has no id in the props until it is reopened,
  // and keyed on the prop the refresh after each turn asked for nothing, so
  // Compact now stayed disabled however long the new thread grew.
  const loadContext = useCallback(() => {
    const id = idRef.current;
    if (!id) return;
    fetchContext(id)
      .then((answer) => {
        setContext(readingOfContext(answer));
        setKeepPairs(typeof answer.keep_pairs === "number" ? answer.keep_pairs : null);
      })
      .catch(() => undefined);
  }, []);
  useEffect(loadContext, [loadContext]);

  const { addSummary } = branches;
  // A send that folded first: the summary joins the tree now rather than
  // with the refetch after the answer, and the meter drops to what the fold
  // left, marked as the estimate it is until the `context` frame beside
  // `done` counts the turn for real.
  useEffect(() => {
    compactionRef.current = (frame) => {
      addSummary(frame.message);
      setContext((current) => ({
        used: frame.tokens_after,
        window: current?.window ?? null,
        estimated: true,
      }));
    };
  }, [addSummary]);
  const [compacting, setCompacting] = useState(false);
  // Compact now, from the menu or `/compact`. Always offered once the
  // thread exists: a 409 ("nothing to fold yet") is answered in the thread
  // with the server's kept count, so nobody is left guessing at a greyed
  // item. Any other failure keeps the existing copy by status.
  const compactNow = useCallback(async () => {
    setNotice(null);
    setCompacting(true);
    try {
      await runCompact({
        conversationId: idRef.current,
        compact: compactConversation,
        keepPairs,
        onSummary: (summary) => {
          addSummary(summary);
          loadContext();
        },
        onNotice: setNotice,
      });
    } finally {
      setCompacting(false);
    }
  }, [addSummary, loadContext, keepPairs]);

  // After a send settles, the tree is a message or two behind -- the adapter
  // wrote them, not this hook. Refetching once per settle is the honest way
  // to pick them up: the ids are the server's, and guessing them client-side
  // is how a switcher ends up pointing at a message that does not exist.
  const { setTree, setLeafId } = branches;
  const reloadTree = useCallback(() => {
    const id = idRef.current;
    if (!id) return;
    void fetchTree(id)
      .then((messages) => {
        setTree(messages);
        setLeafId(defaultLeaf(messages));
      })
      // Deliberately silent: the transcript on screen is what the stream
      // drew and is already correct. A failed refresh only leaves the branch
      // counts a turn stale, which the next settle or reload corrects; an
      // error here would sit under an answer that arrived fine.
      .catch(() => undefined);
  }, [setTree, setLeafId]);

  const sending = thread.phase !== "idle";
  const wasSending = useRef(sending);
  useEffect(() => {
    if (wasSending.current && !sending) {
      reloadTree();
      loadContext();
    }
    wasSending.current = sending;
  }, [sending, reloadTree, loadContext]);

  // A branch turn (edit, regenerate, continue) writes its own messages into
  // the tree as they stream, so only the server's verdict on the new path
  // is asked for -- whether there is now anything to fold.
  const wasRunning = useRef(branches.running);
  useEffect(() => {
    if (wasRunning.current && !branches.running) loadContext();
    wasRunning.current = branches.running;
  }, [branches.running, loadContext]);

  // Which transcript is on screen. While a send streams, the adapter's is the
  // live one; otherwise the tree's, which is the only one that can branch.
  const showingSend = sending || branches.tree.length === 0;
  const phase = sending ? thread.phase : branches.phase;
  // Esc is the Stop button's key: the same cancel, for as long as it shows.
  useStopShortcut(sending || branches.running, sending ? thread.cancel : branches.cancel);

  // A minute with no first token: the wait is given up on rather than left
  // to spin. A send stops and offers Retry with the timeout's copy; an edit
  // or a regenerate stops and says so, since Retry resends the last send.
  const giveUp = () => {
    if (sending) {
      thread.cancel();
      setError({ kind: "timeout", requestId: null });
    } else {
      branches.cancel();
      setNotice("No answer arrived in a minute, so that was stopped. Try again, or pick another model.");
    }
  };

  // An operator's support session is read only: the API refuses every
  // write, so the composer says so instead of offering a send that fails.
  const readOnly = useSupportReadOnly(shell.principal);

  // What is being reported: the whole conversation, or one reply by id.
  // Null closes the dialog, and the dialog is unmounted with it so the next
  // report starts from a clean form rather than the last one's note.
  const [reportTarget, setReportTarget] = useState<{ messageId: string | null } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  // The person's own thumbs in this conversation, keyed by message id. Held
  // here rather than on the message rows because the tree is refetched
  // after every turn (`reloadTree`) and a rating carried on a row would
  // vanish with the refetch; loaded once per conversation, updated as the
  // person clicks. A failed load reads as "nothing rated yet" -- the thumbs
  // still work, they just start dark.
  const [feedback, setFeedback] = useState<ReadonlyMap<string, Feedback>>(() => new Map());
  useEffect(() => {
    let alive = true;
    if (conversationId === null) return;
    fetchFeedback(conversationId)
      .then((map) => {
        if (alive) setFeedback(map);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [conversationId]);
  const onFeedbackChange = useCallback((messageId: string, next: Feedback | null) => {
    setFeedback((current) => {
      const copy = new Map(current);
      if (next === null) copy.delete(messageId);
      else copy.set(messageId, next);
      return copy;
    });
  }, []);

  // Export is built from the stored tree, not the in-flight send: the tree
  // is what has server ids and a settled answer. The menu is disabled while
  // a turn streams, so the two never disagree about what is on screen.
  const exportConversation = (format: ExportFormat) => {
    if (conversationId === null) return;
    const title =
      shell.conversations.find((entry) => entry.id === conversationId)?.title ?? "Conversation";
    const data = {
      id: conversationId,
      title,
      messages: branches.path.map((entry) => entry.message),
      tree: branches.tree,
    };
    const now = new Date();
    if (format === "markdown") {
      downloadText(`${safeFilename(title)}.md`, conversationToMarkdown(data, now), "text/markdown");
    } else {
      downloadText(`${safeFilename(title)}.json`, conversationToJson(data, now), "application/json");
    }
  };

  // Branch from here: the path down to one message becomes a conversation
  // of its own, named after this one, and the page moves onto it. A
  // temporary conversation cannot be forked and a support session cannot
  // write, so neither offers the action.
  const [branching, setBranching] = useState(false);
  const branchFrom = async (messageId: string) => {
    const id = idRef.current;
    if (id === null || branching) return;
    const title = shell.conversations.find((entry) => entry.id === id)?.title ?? "Conversation";
    setNotice(null);
    setBranching(true);
    try {
      const forked = await forkConversation(id, messageId, `Branch of ${title}`);
      hooksRef.current.onBranched(forked, { id, title });
    } catch (err) {
      setNotice(
        err instanceof ApiError
          ? `Could not branch the conversation: ${err.message}`
          : "Could not branch the conversation.",
      );
    } finally {
      setBranching(false);
    }
  };

  const meterContext: ContextReading = {
    used: context?.used ?? null,
    estimated: context?.estimated === true,
    window: resolveWindow({
      selectedModel,
      defaultModel,
      models,
      contextWindow: context === null ? undefined : context.window,
    }),
  };

  // A slash command from the composer. None of these is a turn: nothing is
  // sent to the model or stored, and each answers in the thread's notice
  // slot (or, for /compact, with the divider a fold leaves).
  const runCommand = (command: ParsedCommand) => {
    if (command.kind === "unknown") {
      setNotice(unknownCommandNotice(command.name));
      return;
    }
    switch (command.name) {
      case "compact":
        if (sending || branches.running || compacting) {
          setNotice("Wait for the answer to finish, then /compact again.");
          return;
        }
        void compactNow();
        return;
      case "context":
        setNotice(contextNotice(meterContext));
        return;
      case "help":
        setNotice(helpNotice());
        return;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Offline is chrome, not a transcript event: it is about the whole app,
          so it sits above the picker rather than inside the thread. */}
      {!online && <OfflineBanner />}
      {/* The picker and the instructions affordance are one header row: both
          say what the NEXT turn will do, so they belong together. */}
      {/* One row at every width, ruled off from the transcript, and as tall
          before the model list loads as after: a row that wrapped took a
          third of a phone screen, and one that grew on load pushed the whole
          transcript down under the reader. */}
      <div className="shrink-0 border-b border-mw-border">
        <div className="mx-auto flex min-h-12 w-full max-w-3xl items-center gap-2 px-3 py-1.5 sm:min-h-16 sm:gap-3 sm:px-4">
          <ModelPicker
            conversationId={conversationId}
            value={selectedModel}
            onChange={(model) => {
              modelRef.current = model;
              setSelectedModel(model);
            }}
            onModelsLoaded={(list, fallback) => {
              setModels(list);
              setDefaultModel(fallback);
            }}
          />
          <InstructionsBadge
            conversationId={conversationId}
            instructions={props.instructions}
            onChanged={props.onInstructionsChanged}
          />
          {/* Only before the first send: the flag is fixed at creation. */}
          {conversationId === null && (
            <TemporaryToggle
              on={temporary}
              disabled={sending}
              onChange={(on) => {
                temporaryRef.current = on;
                setTemporary(on);
              }}
            />
          )}
          {/* Export and report need a stored conversation: there is nothing to
              export before the first turn and no id to report. */}
          {conversationId !== null && (
            <div className="ml-auto">
              <ConversationActions
                busy={sending || branches.running || compacting}
                onCompact={() => void compactNow()}
                onShare={temporary ? undefined : () => setShareOpen(true)}
                onExport={exportConversation}
                onReport={() => setReportTarget({ messageId: null })}
              />
            </div>
          )}
        </div>
      </div>
      {shareOpen && conversationId !== null && (
        <ShareDialog open conversationId={conversationId} onOpenChange={setShareOpen} />
      )}
      <DeleteConversationShortcut conversationId={conversationId} />
      {reportTarget !== null && conversationId !== null && (
        <ReportDialog
          open
          conversationId={conversationId}
          messageId={reportTarget.messageId}
          onOpenChange={(open) => {
            if (!open) setReportTarget(null);
          }}
        />
      )}
      {temporary && <TemporaryNotice />}
      {props.origin !== null && <BranchedFrom origin={props.origin} />}
      <ThreadView
        conversationId={conversationId}
        reattaching={props.reattaching}
        readOnly={readOnly}
        onGiveUp={giveUp}
        models={models}
        selectedModel={selectedModel}
        csrfCookieName={shell.authConfig.csrf_cookie}
        messages={showingSend ? thread.messages : []}
        branched={showingSend ? [] : branches.path}
        phase={phase}
        error={error}
        canRetry={thread.canRetry}
        context={meterContext}
        onCompact={conversationId === null || readOnly ? undefined : () => void compactNow()}
        compactDisabled={sending || branches.running || compacting}
        keepPairs={keepPairs}
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        lengthCut={lengthCut}
        onContinue={() => {
          setError(null);
          void branches.continueAnswer();
        }}
        online={online}
        busy={sending || branches.running}
        onSend={(text, attachmentIds, attachmentParts) =>
          void thread.send(text, attachmentIds, attachmentParts)
        }
        onCommand={runCommand}
        onRetry={() => {
          setError(null);
          void thread.retry();
        }}
        onDismissError={() => setError(null)}
        onCancel={sending ? thread.cancel : branches.cancel}
        onSwitchBranch={branches.switchBranch}
        onEdit={(messageId, content) => {
          setError(null);
          void branches.edit(messageId, content);
        }}
        onRegenerate={(messageId) => {
          setError(null);
          void branches.regenerate(messageId);
        }}
        onReport={(messageId) => setReportTarget({ messageId })}
        onBranch={
          conversationId === null || temporary || readOnly
            ? undefined
            : (messageId) => void branchFrom(messageId)
        }
        feedback={feedback}
        onFeedbackChange={onFeedbackChange}
      />
    </div>
  );
}

/**
 * The line under the header of a conversation branched in this session:
 * where it came from, as a link back. Selecting, then writing the address
 * as a push, is the sidebar row's own click path.
 */
function BranchedFrom(props: { origin: BranchOrigin }) {
  const shell = useShell();
  return (
    <p
      data-mw-branched-from=""
      className="mx-auto w-full max-w-3xl px-4 pt-2 text-xs text-mw-text-muted"
    >
      Branched from{" "}
      <a
        href={conversationHref(props.origin.id)}
        className="underline underline-offset-2 hover:text-mw-text"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          shell.selectConversation(props.origin.id);
          writeConversationUrl(props.origin.id, "push");
        }}
      >
        {props.origin.title}
      </a>
    </p>
  );
}

function ThreadView(props: {
  /** Which conversation's draft is in the composer. */
  conversationId: string | null;
  /** Looking for the reply that was streaming when the page reloaded. */
  reattaching: boolean;
  /** An operator's support session: nothing may be sent. */
  readOnly: boolean;
  /** A minute with no first token: stop and say so. */
  onGiveUp: () => void;
  /** The gateway's models, for the vision gate; null until loaded. */
  models: readonly ModelInfo[] | null;
  /** The picker's current choice; null is "Default", resolved server-side. */
  selectedModel: string | null;
  /** For the upload request's CSRF header; the same cookie `apiFetch` reads. */
  csrfCookieName: string;
  /** The in-flight send's transcript; empty when the tree is on screen. */
  messages: readonly ChatMessage[];
  /** The stored transcript with its branch counts; empty while sending. */
  branched: readonly BranchedMessage[];
  phase: ThreadPhase | "idle" | "awaiting-first-token" | "streaming";
  error: StreamFailure | null;
  canRetry: boolean;
  /** What the composer's meter counts against; a null window hides it. */
  context: ContextReading;
  /** Fold now, from the button beside a full meter; absent where nothing can be folded. */
  onCompact?: () => void;
  compactDisabled?: boolean;
  /** How many recent exchanges a fold keeps, as the server said; null until it has. */
  keepPairs: number | null;
  /** A fold that failed or found nothing to do. */
  notice: string | null;
  onDismissNotice: () => void;
  /** Answers known to have stopped on the token limit. */
  lengthCut: ReadonlySet<string>;
  /** Ask for the rest of a length-truncated answer. */
  onContinue: () => void;
  online: boolean;
  /** Any turn in flight -- a send, an edit or a regenerate. */
  busy: boolean;
  onSend: (
    text: string,
    attachmentIds: readonly string[],
    attachmentParts: readonly MessagePart[],
  ) => void;
  /** A slash command typed in the composer; never a send. */
  onCommand: (command: ParsedCommand) => void;
  onRetry: () => void;
  onDismissError: () => void;
  onCancel: () => void;
  onSwitchBranch: (message: Message, delta: number) => void;
  onEdit: (messageId: string, content: string) => void;
  onRegenerate: (messageId: string) => void;
  /** Report one stored reply by id. */
  onReport: (messageId: string) => void;
  /** Branch the conversation at one stored message; absent where it cannot be. */
  onBranch?: (messageId: string) => void;
  /** The person's own thumbs, by message id, and where a click goes. */
  feedback: ReadonlyMap<string, Feedback>;
  onFeedbackChange: (messageId: string, next: Feedback | null) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  // The draft lives here rather than in the composer: an example prompt from
  // the empty state has to be able to fill it, and the empty
  // state is this component's sibling of the composer, not its child.
  //
  // Seeded from storage, so a tab the phone evicted while the user was in
  // another app comes back with their text. The lazy
  // initialiser reads once per mount rather than on every render.
  const { conversationId } = props;
  const [draft, setDraft] = useState(() => loadDraft(conversationId));
  // Summaries whose originals the reader asked to see, by summary id.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => foldPath(props.branched, expanded), [props.branched, expanded]);
  // The row whose bubble is a textarea, here rather than in the row so the
  // composer's ArrowUp can open the last one.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editLastId = props.busy ? null : lastEditableId(props.branched);
  const copiedWhat = useCopyShortcuts({
    branched: props.branched,
    messages: props.messages,
    busy: props.busy,
  });
  const lastEntry = props.branched[props.branched.length - 1];
  // Whether /compact is worth offering: the stored turns on the path,
  // without the summaries a fold already left, against the kept tail.
  const storedTurns = props.branched.filter((entry) => entry.message.role !== "system").length;
  const compactable = props.onCompact !== undefined && canCompact(storedTurns, props.keepPairs);
  const showContinue =
    !props.busy &&
    props.error === null &&
    lastEntry !== undefined &&
    endedOnLength(lastEntry.message, props.lengthCut);
  // Stopped -- by the person, or by a reload under a streaming answer -- is
  // a quiet note with Continue, not the red cut-off alert above.
  const showStopped =
    !props.busy &&
    props.error === null &&
    !showContinue &&
    lastEntry !== undefined &&
    endedStopped(lastEntry.message);

  // Mirror every keystroke to storage. Cheap (one small string) and the
  // alternative — debouncing — loses exactly the last few characters in the
  // case this exists for, because an eviction gives no warning to flush on.
  useEffect(() => {
    saveDraft(conversationId, draft);
  }, [conversationId, draft]);

  // Follow the stream unless the reader scrolled up, AND re-pin when the
  // on-screen keyboard opens or closes — the keyboard shrinks
  // the box without changing the content, so a content-keyed effect never
  // sees it. useStickToBottom owns both rules. Keyed on everything the
  // transcript draws, not on `messages` alone: an edit, a regenerate or a
  // continue streams through `rows`, and the phase moves without either.
  const transcriptKey = useMemo(
    () => [props.messages, rows, props.phase],
    [props.messages, rows, props.phase],
  );
  const stick = useStickToBottom(
    viewportRef,
    transcriptKey,
    props.messages.length > 0 || props.branched.length > 0,
  );

  // A control that unmounts while it holds focus drops focus on <body>, and
  // a keyboard user's next Tab starts from the top of the page. Regenerate
  // replaces its own row with the new reply's and Jump to latest removes
  // itself on arrival, so both hand focus to the transcript first: the
  // scroller, which takes focus without scrolling and, on a phone, without
  // raising the keyboard the way the composer would.
  const focusTranscript = () => viewportRef.current?.focus({ preventScroll: true });

  // The vision gate, asked at the moment of choosing.
  //
  // The guard runs before the pre-check and before any upload, so attaching
  // an image to a text-only model costs the user nothing but the sentence
  // that explains it. It reads the same `supports_vision` the API's 422 reads,
  // and makes the same trade for `null` (unknown is allowed through —
  // `vision.ts` has the reasoning), so the two cannot disagree about a model
  // the gateway described.
  const { models, selectedModel } = props;
  const visionGuard = useCallback(
    (files: readonly File[]): string | null => {
      const hasImage = files.some((file) => isImageType(localTypeOf(file)));
      if (!hasImage) return null;
      if (visionOf(models, selectedModel) !== "no") return null;
      // `selectedModel` is non-null here: `visionOf` only answers "no" for a
      // model it found in the list by id.
      return visionRefusal(selectedModel ?? "This model", visionCapableIds(models));
    },
    [models, selectedModel],
  );

  const attachments = useAttachments({
    conversationId,
    csrfCookieName: props.csrfCookieName,
    bearerToken: currentToken(),
    guard: visionGuard,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* `data-mw-transcript` is a stable hook for the mobile layout suite,
          which measures this box's scroll geometry across keyboard open and
          close. A class selector would also match the sidebar's own scroller. */}
      <div
        ref={viewportRef}
        data-mw-transcript=""
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none"
      >
        {props.messages.length === 0 && props.branched.length === 0 && props.error === null ? (
          <>
            <NewConversationState
              onPickPrompt={setDraft}
              /* One click sends. The draft is cleared first so a
                 card click behaves exactly like pressing Send on typed text. */
              onSendPrompt={(prompt) => {
                setDraft("");
                // No attachments: a suggested prompt is text the user never typed,
                // so nothing was picked to go with it. The two empty arguments are
                // the attachment ids and parts of this signature.
                props.onSend(prompt, [], []);
              }}
              disabled={!props.online || props.busy || props.readOnly}
            />
            {/* /help and /context answer before a first turn too. */}
            {props.notice !== null && (
              <div className="mx-auto w-full max-w-3xl px-4">
                <ThreadNotice text={props.notice} onDismiss={props.onDismissNotice} />
              </div>
            )}
          </>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-4 py-6">
            {props.messages.map((message, i) =>
              message.role === "user" ? (
                <UserMessage key={i} message={message} />
              ) : (
                <AssistantMessage key={i} message={message} />
              ),
            )}
            {rows.map((row) =>
              row.kind === "fold" ? (
                <CompactionDivider
                  key={`fold:${row.entry.message.id}`}
                  covered={row.covered}
                  expanded={row.expanded}
                  onToggle={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      const id = row.entry.message.id;
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                />
              ) : row.kind === "summary" ? (
                <SummaryMarker key={row.entry.message.id} summary={row.summary} />
              ) : (
                <BranchedRow
                  key={row.entry.message.id}
                  entry={row.entry}
                  /* Every stored reply, not only the last: regenerating an
                     earlier one writes a sibling and the rows beneath it leave
                     the active path, exactly as editing an earlier user turn
                     does, and the switcher is the way back to them. A reply
                     still streaming has the `pending-*` id and no server row
                     to regenerate. */
                  canRegenerate={
                    row.entry.message.role === "assistant" &&
                    !row.entry.message.id.startsWith("pending-")
                  }
                  busy={props.busy}
                  editing={editingId === row.entry.message.id}
                  onEditingChange={(editing) =>
                    setEditingId(editing ? row.entry.message.id : null)
                  }
                  onSwitchBranch={props.onSwitchBranch}
                  onEdit={props.onEdit}
                  onRegenerate={(messageId) => {
                    focusTranscript();
                    props.onRegenerate(messageId);
                  }}
                  onReport={props.onReport}
                  onBranch={props.onBranch}
                  feedback={props.feedback.get(row.entry.message.id) ?? null}
                  onFeedbackChange={props.onFeedbackChange}
                />
              ),
            )}
            {/* Two distinct states, not one "running": waiting for a
                cold model reads as a hang unless it is labelled as waiting. */}
            {props.phase === "awaiting-first-token" && (
              <AwaitingFirstToken onGiveUp={props.onGiveUp} />
            )}
            {props.phase === "streaming" && <StreamingIndicator />}
            {props.reattaching && (
              <p data-mw-reattaching="" className="py-2 text-sm text-mw-text-muted">
                Picking up the reply that was being written…
              </p>
            )}
            {/* In the transcript, at the point of failure - not a toast. */}
            {showContinue && <TranscriptError kind="truncated" onContinue={props.onContinue} />}
            {showStopped && (
              <StoppedNote onContinue={props.readOnly ? undefined : props.onContinue} />
            )}
            {props.notice !== null && (
              <ThreadNotice text={props.notice} onDismiss={props.onDismissNotice} />
            )}
            {props.error && (
              <TranscriptError
                kind={props.error.kind}
                /* The id the API logged for this exact failure. */
                reference={<RequestReference requestId={props.error.requestId} />}
                onRetry={props.canRetry ? props.onRetry : undefined}
                onDismiss={props.onDismissError}
              />
            )}
          </div>
        )}
      </div>
      <PhaseAnnouncer phase={props.phase} failed={props.error !== null} />
      {copiedWhat !== null && (
        <p
          role="status"
          data-mw-copied-status=""
          className="pointer-events-none mx-auto mb-1 rounded-md bg-mw-inverse px-3 py-1 text-xs text-mw-inverse-foreground"
        >
          {copiedWhat === "code" ? "Copied the last code block" : "Copied the last reply"}
        </p>
      )}
      <JumpToLatest
        visible={stick.away}
        unseen={stick.unseen}
        onJump={() => {
          focusTranscript();
          stick.jumpToLatest();
        }}
      />
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        running={props.busy}
        readOnly={props.readOnly}
        online={props.online}
        context={props.context}
        onCompact={props.onCompact}
        compactDisabled={props.compactDisabled}
        compactable={compactable}
        attachments={attachments}
        onSend={(text) => {
          // The ids are read BEFORE the draft is cleared, and only `ready`
          // entries have one. There is no await between these three lines and
          // nothing here can throw, which is the whole design of the send
          // path: every way an attachment can fail has already happened by
          // now, in the upload, and left its chip behind. The text cannot be
          // lost to an upload because by the time this runs there is no
          // upload left to fail.
          const ids = readyIds(attachments.pending);
          const parts = attachmentParts(attachments.pending);
          setDraft("");
          attachments.clear();
          props.onSend(text, ids, parts);
        }}
        onCommand={(command) => {
          // The line was a command, not a message: the box clears, the
          // attachments stay for the message the reader is still composing.
          // An unknown `/word` keeps the line -- it may be a typo of a
          // command, or a message that happens to start with a slash, and
          // either way the person's text is not ours to throw away.
          if (command.kind !== "unknown") setDraft("");
          props.onCommand(command);
        }}
        onCancel={props.onCancel}
        onEditLast={editLastId === null ? undefined : () => setEditingId(editLastId)}
      />
    </div>
  );
}

/**
 * A line in the thread that is information, not a message and not an
 * error: a fold that found nothing to do, a command's answer. Lives in the
 * transcript where the reader's attention is, dismissible, and never a
 * toast that a phone would hide behind the keyboard. Preserves line breaks
 * for /help's list.
 */
function ThreadNotice(props: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      data-mw-compaction-notice=""
      data-mw-thread-notice=""
      className="my-4 flex items-start gap-2 rounded-lg border border-mw-border bg-mw-surface-raised px-3 py-2 text-xs text-mw-text-muted"
    >
      <p className="flex-1 whitespace-pre-wrap">{props.text}</p>
      <button type="button" onClick={props.onDismiss} className="shrink-0 underline">
        Dismiss
      </button>
    </div>
  );
}

/**
 * The parts to draw for the user's own turn while the answer streams.
 *
 * The server stores the real `image` and `document` parts and a reload shows
 * those; this is the optimistic echo, so a person who just sent a screenshot
 * sees it in the transcript instead of a bare line of text. `text: null` on
 * the document part is the honest value here — the client has not extracted
 * anything and does not know whether the server will, so claiming otherwise
 * would put a wrong "the model read this" in the transcript for the few
 * seconds before the reload corrects it.
 */
function attachmentParts(pending: readonly PendingAttachment[]): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const entry of pending) {
    if (entry.status !== "ready") continue;
    const { attachment } = entry;
    parts.push(
      isImageType(attachment.content_type)
        ? {
            type: "image",
            attachment_id: attachment.id,
            filename: attachment.filename,
            content_type: attachment.content_type,
          }
        : {
            type: "document",
            attachment_id: attachment.id,
            filename: attachment.filename,
            content_type: attachment.content_type,
            text: null,
            truncated: attachment.extract_truncated,
          },
    );
  }
  return parts;
}

/**
 * The paperclip's tooltip: the real cap, from the API.
 *
 * The rule is "show the real cap in the refusal", and the same number
 * before there is anything to refuse. The limits come from
 * `/api/attachments/limits/me`, so this sentence cannot drift from what the
 * server enforces; when they have not loaded, it says what is accepted and
 * stays silent about sizes rather than inventing one.
 */
function attachmentHint(attachments: UseAttachments, blocked: boolean): string {
  if (blocked) return "You are offline";
  const kinds = "Images, PDF, text and Markdown";
  const { limits } = attachments;
  if (limits === null) return `Attach a file — ${kinds}`;
  return (
    `Attach a file — ${kinds}, up to ${humanSize(limits.max_upload_bytes)} each, ` +
    `${humanSize(limits.quota_remaining_bytes)} left of your ${humanSize(limits.quota_bytes)} quota`
  );
}

function Composer(props: {
  /** Owned by ThreadView so the empty state's example prompts can fill it. */
  draft: string;
  onDraftChange: (draft: string) => void;
  running: boolean;
  /** An operator's support session: the box is shown, nothing can be sent. */
  readOnly: boolean;
  online: boolean;
  /** For the meter under the box: the last count and the window. */
  context: ContextReading;
  /** The fold, for the button beside a full meter. */
  onCompact?: () => void;
  compactDisabled?: boolean;
  /** Whether the slash menu lists /compact: false with nothing to fold. */
  compactable: boolean;
  /** The attachment state, owned by ThreadView beside the draft. */
  attachments: UseAttachments;
  onSend: (text: string) => void;
  /** The line was `/compact`, `/context`, `/help` or an unknown `/word`. */
  onCommand: (command: ParsedCommand) => void;
  onCancel: () => void;
  /** Open the last user message for editing; absent when there is none to edit. */
  onEditLast?: () => void;
}) {
  // Offline disables sending outright: navigator.onLine's false is
  // reliable, so a send now is a guaranteed failure thirty seconds from now.
  // The draft is untouched - it is exactly what the user must not lose.
  const blocked = !props.online || props.readOnly;
  const { attachments } = props;
  const uploading = anyUploading(attachments.pending);
  // A failed chip holds the send: going without the file the person can
  // see on screen is the silent drop the chip exists to prevent.
  const failed = anyFailed(attachments.pending);
  const [failedNotice, setFailedNotice] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useAutosize(boxRef, props.draft);

  // Dictation shares the send's gates: nothing new goes into a box that
  // cannot send, and a full window gets the meter's own remedy as the reason.
  const contextFull = meterReading(props.context, props.draft)?.level === "full";
  const dictation = useDictation({
    boxRef,
    draft: props.draft,
    onDraftChange: props.onDraftChange,
    disabled: blocked || props.running || contextFull,
  });
  const dictationHint = props.readOnly
    ? "Support sessions are read only"
    : !props.online
      ? "You are offline"
      : contextFull
        ? COMPACT_HINT
        : props.running
          ? "Wait for the answer to finish"
          : undefined;

  // Drag depth, not a boolean. `dragenter`/`dragleave` fire for every child
  // the pointer crosses, so a boolean flickers off the moment the cursor
  // moves from the composer box onto the textarea inside it. Counting
  // enters minus leaves is the only reading that survives nested elements.
  const [dragDepth, setDragDepth] = useState(0);
  const dragging = dragDepth > 0;

  // The slash-command popover, driven from the draft: open while the line
  // is `/` plus the start of a command name.
  const menu = useCommandMenu(props.draft, { compactable: props.compactable });
  const menuId = useId();
  const complete = (name: string) => props.onDraftChange(`/${name}`);

  const submit = () => {
    const text = props.draft.trim();
    if (!text) return;
    // A command runs whatever the send button would say: /help and /context
    // are answered locally, and the runtime decides what /compact may do
    // mid-turn. Nothing here goes to the model.
    const command = parseCommand(text);
    if (command !== null) {
      props.onCommand(command);
      return;
    }
    // An upload still running blocks the send rather than sending without it:
    // a message that silently dropped the screenshot the user attached is
    // worse than one they had to wait a second for. The button says so.
    if (props.running || blocked || uploading) return;
    if (failed) {
      setFailedNotice(true);
      return;
    }
    setFailedNotice(false);
    props.onSend(text);
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu.open && menu.active !== null) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        menu.move(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        menu.dismiss();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        complete(menu.active.name);
        return;
      }
      // Enter on a half-typed name completes it; on the full name it runs,
      // through `submit` below.
      if (e.key === "Enter" && !e.shiftKey && props.draft.trim() !== `/${menu.active.name}`) {
        e.preventDefault();
        complete(menu.active.name);
        return;
      }
    }
    // ArrowUp in an empty box edits the last message, as in other chat apps.
    if (props.onEditLast && !menu.open && isEditLastKey(e.nativeEvent, props.draft)) {
      e.preventDefault();
      props.onEditLast();
      return;
    }
    // Enter sends; Shift+Enter is a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="relative shrink-0 border-t border-mw-border p-3"
      /* The drop target is the whole composer, not just the textarea: aiming
         a dragged file at a one-line text box is a precision task, and the
         surrounding border is what a user actually aims at. */
      onDragEnter={(event) => {
        if (!dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragDepth((depth) => depth + 1);
      }}
      onDragOver={(event) => {
        if (!dragHasFiles(event.dataTransfer)) return;
        // Both lines are required: without `preventDefault` on dragover the
        // browser refuses the drop entirely and navigates to the file
        // instead, which replaces the whole SPA with the image.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => setDragDepth((depth) => Math.max(0, depth - 1))}
      onDrop={(event) => {
        if (!dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragDepth(0);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) attachments.add(files);
      }}
      /* Clear the home indicator in standalone mode. The inline
         style rather than a class because `env()` inside an arbitrary Tailwind
         value is fragile across their parser versions, and this is one
         declaration. */
      style={{
        paddingBottom: "var(--mw-safe-bottom)",
        paddingLeft: "max(0.75rem, var(--mw-safe-left))",
        paddingRight: "max(0.75rem, var(--mw-safe-right))",
      }}
    >
      <DropOverlay active={dragging} />
      {/* The refusal, above the composer and above the chips: it is about the
          file the user just tried to attach, so it belongs between the thing
          they did and the thing they did it to. Dismissible, and it never
          touches the draft. */}
      {attachments.notice !== null && (
        <div
          role="status"
          data-mw-attachment-notice=""
          className="mx-auto mb-2 flex w-full max-w-3xl items-start gap-2 rounded-lg border border-mw-danger bg-mw-danger-subtle px-3 py-2 text-xs text-mw-danger-strong"
        >
          <p className="flex-1">{attachments.notice}</p>
          <button
            type="button"
            onClick={attachments.dismissNotice}
            aria-label="Dismiss"
            className="shrink-0 font-medium underline"
          >
            Dismiss
          </button>
        </div>
      )}
      {failedNotice && failed && (
        <p
          role="alert"
          data-mw-failed-attachment-notice=""
          className="mx-auto mb-2 w-full max-w-3xl rounded-lg border border-mw-danger bg-mw-danger-subtle px-3 py-2 text-xs text-mw-danger-strong"
        >
          An attachment did not upload, so nothing was sent. Retry it or remove it, then send
          again — your message is still here.
        </p>
      )}
      <DictationNotices dictation={dictation} />
      <AttachmentChips
        pending={attachments.pending}
        onRemove={attachments.remove}
        onRetry={attachments.retry}
      />
      {/* The box draws the message field's focus: the textarea itself is
          borderless, and a caret alone is not a focus indicator a keyboard
          user can find at a glance (WCAG 2.4.7). */}
      <div className="relative mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-mw-border bg-mw-surface-raised p-2 has-[textarea:focus-visible]:border-mw-accent">
        {menu.open && (
          <CommandMenu
            id={menuId}
            options={menu.options}
            activeIndex={menu.activeIndex}
            onPick={(command) => complete(command.name)}
            onHover={(index) => menu.move(index - menu.activeIndex)}
          />
        )}
        {attachments.available && (
          <AttachmentPicker
            onFiles={(files) => attachments.add(files)}
            disabled={blocked || props.running}
            hint={attachmentHint(attachments, !props.online)}
          />
        )}
        <DictationButton
          dictation={dictation}
          disabled={blocked || props.running || contextFull}
          disabledHint={dictationHint}
        />
        <textarea
          ref={boxRef}
          rows={1}
          autoFocus
          readOnly={props.readOnly}
          /* The hook the shell's "jump to the message box" shortcut focuses:
             a data attribute rather than a class, like the transcript's. */
          data-mw-composer=""
          value={props.draft}
          onChange={(e) => props.onDraftChange(e.target.value)}
          onPaste={(e) => {
            // Paste is the path that matters most, because a
            // screenshot exists only on the clipboard.
            //
            // `preventDefault` ONLY when files were found. A clipboard with
            // text in it also carries `text/plain` items, and swallowing the
            // paste unconditionally would break every ordinary Ctrl+V — so
            // the default is left alone unless this really is a file paste,
            // in which case the default would insert the filename as text.
            if (!attachments.available) return;
            const files = filesFromPaste(e.clipboardData);
            if (files.length === 0) return;
            e.preventDefault();
            attachments.add(files, { fromPaste: true });
          }}
          onKeyDown={onComposerKeyDown}
          /* The popover is a listbox the box drives, the way the shell's
             palette does: focus stays here, the highlighted command is named
             through aria-activedescendant. The box stays a textbox rather
             than a combobox -- a textarea may carry no other role -- so the
             open state lives in the list itself: it is in the tree, and
             aria-controls points at it, only while it is open. `aria-expanded`
             is a combobox attribute and a textbox carrying it is an axe
             critical. */
          aria-autocomplete="list"
          aria-controls={menu.open ? menuId : undefined}
          aria-activedescendant={menu.active ? optionId(menuId, menu.active) : undefined}
          placeholder={
            props.readOnly
              ? "Read only — support sessions cannot send messages"
              : !props.online
                ? "Offline — your draft is kept"
                : "Message MatterWave…"
          }
          /*
           * 16px (`text-base`) below the md breakpoint, 14px
           * (`text-sm`) above it.
           *
           * Safari zooms the page when a text field with a computed font-size
           * UNDER 16px is focused, and it never zooms back out — the user is
           * left on a zoomed, horizontally-scrolling page for the rest of the
           * session. Measured at 14px before this change on every phone
           * viewport. Suppressing zoom with `maximum-scale=1` in the viewport
           * meta also "fixes" it and breaks WCAG 1.4.4; sizing the text
           * correctly is the fix that costs nothing.
           */
          /* `py-1.5` and `leading-6` put the first line -- and the
             placeholder -- on the buttons' centre line, where it used to
             sit high against the box's top edge. `self-center` keeps one line
             centred; `items-end` on the row keeps the buttons at the bottom
             as the box grows. */
          className="max-h-40 min-w-0 flex-1 resize-none self-center bg-transparent px-1 py-1.5 text-base leading-6 pointer-coarse:py-2.5 outline-none md:text-sm md:leading-6"
        />
        {props.running ? (
          <button
            type="button"
            onClick={props.onCancel}
            className="h-9 min-w-16 shrink-0 rounded-lg bg-mw-surface-hover px-3 text-sm font-medium hover:bg-mw-surface-active pointer-coarse:h-11"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={
              props.draft.trim() === "" ||
              (parseCommand(props.draft) === null && (blocked || uploading))
            }
            title={
              props.readOnly
                ? "Support sessions are read only"
                : !props.online
                  ? "You are offline"
                  : uploading
                    ? "Waiting for the attachment to finish uploading"
                    : undefined
            }
            className="h-9 min-w-16 shrink-0 rounded-lg bg-mw-accent px-3 text-sm font-medium text-mw-accent-foreground hover:bg-mw-accent/85 disabled:opacity-40 pointer-coarse:h-11"
          >
            {/* The label says what it is waiting for. A disabled Send with no
                explanation during a 20-second upload is the frozen UI this
                step exists to prevent, and the chip's progress bar is the
                answer to "how long" — this is the answer to "why". */}
            {uploading ? "Uploading…" : "Send"}
          </button>
        )}
      </div>
      <div className="mx-auto mt-1 flex max-w-3xl justify-end px-1">
        <ContextMeter
          context={props.context}
          draft={props.draft}
          onCompact={props.onCompact}
          compactDisabled={props.compactDisabled}
        />
      </div>
    </div>
  );
}


/**
 * One stored message: its bubble, its "2 / 3" switcher where it has siblings,
 * and its actions. Edit turns the bubble into a textarea in
 * place, so the reader keeps their position in the transcript.
 */
function BranchedRow(props: {
  entry: BranchedMessage;
  canRegenerate: boolean;
  busy: boolean;
  /** The bubble is a textarea; ThreadView owns it so ArrowUp can open one. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onSwitchBranch: (message: Message, delta: number) => void;
  onEdit: (messageId: string, content: string) => void;
  onRegenerate: (messageId: string) => void;
  onReport: (messageId: string) => void;
  onBranch?: (messageId: string) => void;
  feedback: Feedback | null;
  onFeedbackChange: (messageId: string, next: Feedback | null) => void;
}) {
  const { editing, onEditingChange: setEditing } = props;
  const { message, branch } = props.entry;
  const isUser = message.role === "user";
  // Report belongs on a stored reply. The `pending-*` id is the one the
  // branch hook gives a reply still streaming, which the API has no row for.
  const canReport = !isUser && !message.id.startsWith("pending-");

  if (editing) {
    return (
      <div className="mb-4 flex justify-end">
        <div className="w-full max-w-[80%]">
          <MessageEditor
            initial={message.content}
            onCancel={() => setEditing(false)}
            onSave={(text) => {
              setEditing(false);
              props.onEdit(message.id, text);
            }}
          />
        </div>
      </div>
    );
  }

  // The switcher, Edit, Copy, Regenerate and Report: MessageControls decides
  // which of them a row of this role gets.
  const controls = (
    <MessageControls
      message={message}
      branch={branch}
      canRegenerate={props.canRegenerate}
      busy={props.busy}
      onSwitchBranch={props.onSwitchBranch}
      onEdit={() => setEditing(true)}
      onRegenerate={props.onRegenerate}
      onReport={props.onReport}
      onBranch={props.onBranch}
      /* Thumbs on a stored reply only: `canReport` is exactly "a reply
         with a server id", which is also what a rating needs. They lead the
         reply's one toolbar. */
      feedback={
        canReport
          ? {
              current: props.feedback,
              onChange: (next) => props.onFeedbackChange(message.id, next),
            }
          : undefined
      }
    />
  );

  if (isUser) {
    // The stored user turn's attachment parts, which is what a reload
    // shows. `message.content` is the flattened text the API sends beside
    // `parts`, so the text still comes from there; the images and documents
    // come from the parts, where they are.
    const extras = (message.parts ?? []).filter((part) => part.type !== "text");
    // `relative`, on both rows: the time under the bubble is clipped to a
    // pixel at phone widths with `position: absolute`, and with no
    // positioned row it was placed against the document instead -- forty
    // rows deep in the transcript, which made the page itself scroll.
    return (
      <div className="relative mb-4 flex flex-col items-end" data-message-id={message.id}>
        {extras.length > 0 && (
          <div className="mb-1 w-full max-w-[80%]">
            <MessageParts parts={extras} />
          </div>
        )}
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-mw-inverse px-4 py-2 text-sm text-mw-inverse-foreground">
          {message.content}
        </div>
        <MessageTime at={message.created_at} />
        {controls}
      </div>
    );
  }

  return (
    <div className="relative mb-4" data-message-id={message.id}>
      {/* Parts when the API sent them - a branched message can carry
          tool calls too - falling back to one text part for a response that
          predates typed parts. MessageParts owns the Markdown boundary. */}
      <MessageParts
        parts={message.parts ?? [{ type: "text", text: message.content }]}
      />
      {message.model && <p className="mt-1 text-xs text-mw-text-muted">{message.model}</p>}
      <MessageTime at={message.created_at} />
      {controls}
    </div>
  );
}

function textOf(message: ChatMessage): string {
  return textOfParts(message.content);
}

function UserMessage(props: { message: ChatMessage }) {
  // A user turn can carry attachments now, so its non-text parts are
  // rendered too. They go OUTSIDE the bubble: the bubble is the inverse
  // colour, and an image or a document chip inside it would be a white card
  // on a dark pill, which reads as a rendering fault. Above the text, in
  // sending order, which is where the user put them.
  const extras = props.message.content.filter((part) => part.type !== "text");
  return (
    <div className="mb-4 flex flex-col items-end">
      {extras.length > 0 && (
        <div className="mb-1 w-full max-w-[80%]">
          <MessageParts parts={extras} />
        </div>
      )}
      <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-mw-inverse px-4 py-2 text-sm text-mw-inverse-foreground">
        {textOf(props.message)}
      </div>
    </div>
  );
}

function AssistantMessage(props: { message: ChatMessage }) {
  const model = props.message.metadata?.custom?.model ?? "";
  return (
    <div className="mb-4">
      {/* One component per part kind, with a placeholder for kinds this
          build does not know. Text still goes through the markdown renderer -- no
          rehype-raw, URL allowlist, same-origin images, per-message error
          boundary -- which MessageParts is the only caller of here. */}
      <MessageParts parts={props.message.content} />
      {model && <p className="mt-1 text-xs text-mw-text-muted">{model}</p>}
    </div>
  );
}
