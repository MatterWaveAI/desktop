import { useEffect, useId, useState } from "react";
import { apiFetch } from "../../lib/api";
import { PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS, failureMessage } from "../../shell/authForms";
import type { EffectiveInstructions, UserInstructions } from "../../types";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";

/** The conversation level's cap, mirrored from the API to render the counter. */
export const CONVERSATION_INSTRUCTIONS_MAX_LEN = 2000;

const BADGE_CLASS =
  "flex h-8 shrink-0 items-center gap-1.5 rounded border border-mw-border px-2 text-xs text-mw-text-muted hover:bg-mw-surface-hover pointer-coarse:h-11";
const PANEL_CLASS =
  "w-[min(32rem,calc(100vw-2rem))] gap-0 rounded-lg border border-mw-border bg-mw-surface-raised p-3 text-mw-text shadow-lg ring-0";

/**
 * "Instructions" on the conversation.
 *
 * Step 6 is the reason this is visible at all: an answer that changes because
 * of an instruction the user cannot see is confusing, and invisible prompt
 * injection is exactly the failure to avoid. So the affordance states
 * whether anything is in force, and opening it shows the assembled text the
 * model actually receives — not this component's own guess at how the three
 * levels combine, which the API already computed.
 *
 * The owner may override the thread from here. Clearing the box falls back to
 * their own custom instructions, and under those the organisation's, which no
 * conversation can switch off.
 *
 * On the shared popover, so the panel is placed against the viewport and a
 * phone never gets one that starts off the edge of the screen.
 */
export function InstructionsBadge({
  conversationId,
  instructions,
  onChanged,
}: {
  conversationId: string | null;
  instructions: EffectiveInstructions | null;
  onChanged: (next: EffectiveInstructions) => void;
}) {
  // A new conversation has no row to write to yet; what it will start with
  // is the person's own instructions, which it says.
  if (conversationId === null) return <NewChatInstructions />;
  if (instructions === null) return null;
  return (
    <ConversationInstructions
      conversationId={conversationId}
      instructions={instructions}
      onChanged={onChanged}
    />
  );
}

function ConversationInstructions({
  conversationId,
  instructions,
  onChanged,
}: {
  conversationId: string;
  instructions: EffectiveInstructions;
  onChanged: (next: EffectiveInstructions) => void;
}) {
  const [open, setOpen] = useState(false);
  // `draft` holds only what the user has typed since the panel was opened;
  // null means "showing what is stored". Derived rather than synchronised in
  // an effect, so a save or a different conversation re-seeds the box without
  // a cascading render (react-hooks/set-state-in-effect).
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();

  const text = draft ?? instructions.conversation;
  const active = instructions.effective.length > 0;
  const over = text.length > CONVERSATION_INSTRUCTIONS_MAX_LEN;

  async function save(text: string | null) {
    setBusy(true);
    setError(null);
    try {
      const body = await apiFetch<{ instructions: EffectiveInstructions }>(
        `/api/conversations/${conversationId}/instructions`,
        { method: "PUT", json: { text } },
      );
      onChanged(body.instructions);
      setDraft(null);
      setOpen(false);
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={BADGE_CLASS}>
        Instructions
        {/* The state, in a word: whether anything is shaping the answers. */}
        <span className={active ? "text-mw-link" : "text-mw-text-muted"}>
          {active ? "On" : "Off"}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" id={fieldId} aria-label="Instructions" className={PANEL_CLASS}>
        <p className="text-xs text-mw-text-muted">
          {active
            ? "These instructions are in force for this conversation:"
            : "Nothing is shaping this conversation's answers yet."}
        </p>
        {active && (
          <pre className="mt-2 max-h-40 overflow-auto rounded border border-mw-border bg-mw-surface p-2 text-xs whitespace-pre-wrap">
            {instructions.effective}
          </pre>
        )}
        {instructions.user_overridden && (
          <p className="mt-2 text-xs text-mw-text-muted">
            This conversation replaces your own custom instructions.
          </p>
        )}
        {instructions.org.length > 0 && (
          <p className="mt-2 text-xs text-mw-text-muted">
            Your organisation&rsquo;s instructions always apply and cannot be turned off here.
          </p>
        )}

        <label className="mt-3 block text-xs font-medium" htmlFor={`${fieldId}-text`}>
          Instructions for this conversation
        </label>
        <textarea
          id={`${fieldId}-text`}
          rows={3}
          value={text}
          placeholder="Answer as a reviewer would, and quote the clause you are referring to."
          aria-describedby={`${fieldId}-count`}
          aria-invalid={over || undefined}
          onChange={(event) => setDraft(event.target.value)}
          className="mt-1 w-full rounded border border-mw-border bg-mw-surface p-2 text-base outline-none focus-visible:border-mw-focus aria-invalid:border-mw-danger md:text-xs"
        />
        <p
          id={`${fieldId}-count`}
          className={`mt-1 text-right text-xs ${over ? "text-mw-danger" : "text-mw-text-muted"}`}
        >
          {text.length} / {CONVERSATION_INSTRUCTIONS_MAX_LEN}
        </p>

        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className={PRIMARY_BUTTON_CLASS}
            disabled={busy || over}
            onClick={() => void save(text.trim() === "" ? null : text)}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {instructions.conversation.length > 0 && (
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              disabled={busy}
              onClick={() => void save(null)}
            >
              Use my instructions
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-2 text-xs text-mw-danger">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The badge before the first send. There is no conversation to override yet,
 * so it is read only: it says whether the person's own custom instructions
 * will shape the new chat, shows them, and points at where they are edited.
 * The organisation's are not readable by a member; that they apply is said
 * rather than shown. A failed read hides the badge rather than guessing.
 */
function NewChatInstructions() {
  const [mine, setMine] = useState<UserInstructions | null>(null);
  useEffect(() => {
    let alive = true;
    apiFetch<UserInstructions>("/api/me/instructions")
      .then((body) => {
        if (alive) setMine({ about: body.about ?? "", style: body.style ?? "" });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (mine === null) return null;
  const active = mine.about.trim() !== "" || mine.style.trim() !== "";
  return (
    <Popover>
      <PopoverTrigger className={BADGE_CLASS}>
        Instructions
        <span className={active ? "text-mw-link" : "text-mw-text-muted"}>
          {active ? "On" : "Off"}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Instructions" className={PANEL_CLASS}>
        <p className="text-xs text-mw-text-muted">
          {active
            ? "This chat will start with your custom instructions:"
            : "You have no custom instructions, so nothing of yours shapes this chat."}
        </p>
        {active && (
          <pre className="mt-2 max-h-40 overflow-auto rounded border border-mw-border bg-mw-surface p-2 text-xs whitespace-pre-wrap">
            {[mine.about, mine.style].filter((part) => part.trim() !== "").join("\n\n")}
          </pre>
        )}
        <p className="mt-2 text-xs text-mw-text-muted">
          Your organisation&rsquo;s instructions, if it has any, apply too. Once the chat has
          started you can replace yours for it here.
        </p>
        <a href="/settings/instructions" className="mt-2 inline-block text-xs underline">
          Edit your custom instructions
        </a>
      </PopoverContent>
    </Popover>
  );
}
