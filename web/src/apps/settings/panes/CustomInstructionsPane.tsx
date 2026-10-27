import { useEffect, useId, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Alert } from "../../../components/ui/alert";
import { Button, buttonVariants } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import { apiFetch } from "../../../lib/api";
import { ErrorState, LoadingSkeleton, UpgradePrompt } from "../../../patterns";
import { failureMessage } from "../../../shell/authForms";
import { useShell } from "../../../shell/shellContext";
import type { UserInstructions } from "../../../types";
import { LearnMore, PaneSection } from "../PaneSection";

/**
 * Custom instructions: the two fields people expect, so a user says
 * "I am a Python developer, answer concisely" once instead of every turn.
 *
 * The caps are the API's, repeated here only to render the counter and to
 * disable Save before a doomed request — the server enforces them, and a
 * number that drifts would show a count that lets the user past a 422 they
 * cannot see coming. They are per field; the server also caps the two
 * together and the whole assembled message.
 */
export const ABOUT_MAX_LEN = 1500;
export const STYLE_MAX_LEN = 1500;

const EMPTY: UserInstructions = { about: "", style: "" };

/**
 * Whether this org's plan lets instructions be saved, read from the
 * entitlement the API already serves (`/api/entitlements`, the same
 * `features.custom_instructions` switch PUT refuses on). Known up front, so
 * a person on Free sees the plan notice and a read-only form before they
 * type a paragraph the API would then refuse. A missing switch -- no org,
 * gates off, the read failed -- is taken as allowed: the PUT still decides,
 * and its 402 is rendered the same way.
 */
export interface PlanAccess {
  allowed: boolean;
  planName: string;
}

interface EntitlementView {
  plan_name?: string;
  limits?: { features?: Record<string, boolean> };
}

export function planAccessOf(body: EntitlementView | null): PlanAccess {
  const allowed = body?.limits?.features?.custom_instructions !== false;
  return { allowed, planName: body?.plan_name ?? "Free" };
}

type SaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved" }
  // `refusal` is the raw error beside its message: setting instructions is
  // plan-gated, and a 402's headers name the plan that has it, which
  // UpgradePrompt renders and a string could not carry.
  | { phase: "error"; message: string; refusal?: unknown };

/**
 * The unsaved draft, kept in this browser so switching to another settings
 * tab (or reloading) does not throw away a paragraph of typing. Per person,
 * so a shared browser does not hand one person's draft to the next. Storage
 * can be missing or refuse (private windows): the pane then just behaves as
 * it did without drafts.
 */
function draftKey(subject: string): string {
  return `mw-instructions-draft:${subject}`;
}

function readDraft(key: string): UserInstructions | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UserInstructions>;
    if (typeof parsed.about !== "string" || typeof parsed.style !== "string") return null;
    return { about: parsed.about, style: parsed.style };
  } catch {
    return null;
  }
}

function writeDraft(key: string, draft: UserInstructions | null): void {
  try {
    if (draft) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {
    // Storage refused: the draft lives only as long as the pane.
  }
}

export function CustomInstructionsPane() {
  const shell = useShell();
  const key = draftKey(shell.principal.subject);
  const [loaded, setLoaded] = useState<UserInstructions | null>(null);
  const [access, setAccess] = useState<PlanAccess | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<UserInstructions>(EMPTY);
  const [restored, setRestored] = useState(false);
  const [save, setSave] = useState<SaveState>({ phase: "idle" });
  const aboutId = useId();
  const styleId = useId();

  useEffect(() => {
    let alive = true;
    // The plan is read beside the instructions, not after them: the notice
    // and the read-only fields must be there on first paint, not appear
    // once someone has started typing.
    const plan = apiFetch<EntitlementView>("/api/entitlements").catch(() => null);
    Promise.all([apiFetch<UserInstructions>("/api/me/instructions"), plan])
      .then(([instructions, entitlement]) => {
        if (!alive) return;
        setAccess(planAccessOf(entitlement));
        setLoaded(instructions);
        const kept = readDraft(key);
        if (kept && (kept.about !== instructions.about || kept.style !== instructions.style)) {
          setDraft(kept);
          setRestored(true);
        } else {
          writeDraft(key, null);
          setDraft(instructions);
        }
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [key]);

  const dirtyNow =
    loaded !== null && (draft.about !== loaded.about || draft.style !== loaded.style);

  // Closing the tab or the window is the one way out the draft cannot
  // survive on its own terms if storage is refused: ask first.
  useEffect(() => {
    if (!dirtyNow) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyNow]);

  if (loadError) {
    return <ErrorState title="Could not load your instructions" message={loadError} />;
  }
  if (loaded === null || access === null) return <LoadingSkeleton rows={4} />;

  const readOnly = !access.allowed;
  const tooLong = draft.about.length > ABOUT_MAX_LEN || draft.style.length > STYLE_MAX_LEN;
  // Nothing to save is not an error, it is just a disabled button: comparing
  // against what the API returned, not against "" , so re-saving the same text
  // does not look like a change.
  const dirty = draft.about !== loaded.about || draft.style !== loaded.style;

  function edit(next: UserInstructions) {
    setDraft(next);
    setSave({ phase: "idle" });
    const unchanged = loaded !== null && next.about === loaded.about && next.style === loaded.style;
    writeDraft(key, unchanged ? null : next);
  }

  function discard() {
    if (loaded) setDraft(loaded);
    writeDraft(key, null);
    setRestored(false);
    setSave({ phase: "idle" });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || tooLong) return;
    setSave({ phase: "saving" });
    try {
      // The API answers with what it stored, which is what the next turn will
      // use; the pane shows that rather than the draft it sent.
      const saved = await apiFetch<UserInstructions>("/api/me/instructions", {
        method: "PUT",
        json: draft,
      });
      setLoaded(saved);
      setDraft(saved);
      writeDraft(key, null);
      setRestored(false);
      setSave({ phase: "saved" });
    } catch (err: unknown) {
      setSave({ phase: "error", message: failureMessage(err), refusal: err });
    }
  }

  return (
    <form className="flex flex-col gap-7" onSubmit={(event) => void onSubmit(event)}>
      {readOnly && (
        <Alert
          variant="info"
          role="status"
          data-testid="plan-notice"
          title={`Custom instructions are not included in the ${access.planName} plan.`}
          action={
            <Link to="/pricing" className={buttonVariants({ size: "sm" })}>
              Upgrade
            </Link>
          }
        >
          Upgrade to tell MatterWave about yourself once, instead of in every conversation.
          Anything saved before is shown below and still used.
        </Alert>
      )}
      {save.phase === "error" && <UpgradePrompt error={save.refusal} />}
      {restored && dirty && (
        <Alert variant="info">
          Restored your unsaved changes. Save them, or discard them to go back
          to what is saved.
        </Alert>
      )}
      <PaneSection
        title="What should MatterWave know about you?"
        description="Background it should assume in every new conversation — your work, your tools, anything you would otherwise repeat."
      >
        <InstructionsField
          id={aboutId}
          label="What should MatterWave know about you?"
          value={draft.about}
          max={ABOUT_MAX_LEN}
          placeholder="I am a backend engineer working mostly in Python and Postgres."
          readOnly={readOnly}
          onChange={(about) => edit({ ...draft, about })}
        />
      </PaneSection>

      <PaneSection
        title="How should MatterWave respond?"
        description="Tone, length and format for new conversations."
      >
        <InstructionsField
          id={styleId}
          label="How should MatterWave respond?"
          value={draft.style}
          max={STYLE_MAX_LEN}
          placeholder="Be concise. Show code before prose. Do not apologise."
          readOnly={readOnly}
          onChange={(style) => edit({ ...draft, style })}
        />
        <LearnMore className="mt-1">
          <p>These apply to new conversations; a single conversation can override them from the chat.</p>
        </LearnMore>
      </PaneSection>

      {/* Nothing to press on a plan that cannot save: the notice above says what to do instead. */}
      {!readOnly && (
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!dirty || tooLong || save.phase === "saving"}>
          {save.phase === "saving" ? "Saving…" : "Save instructions"}
        </Button>
        {dirty && (
          <Button
            type="button"
            variant="outline"
            disabled={save.phase === "saving"}
            onClick={discard}
          >
            Discard changes
          </Button>
        )}
        {/* One live region for the outcome: a screen reader hears "Saved" or
            the failure without having to go looking for it. */}
        <p role="status" aria-live="polite" className="text-sm text-mw-text-muted">
          {save.phase === "saved" && "Saved. New conversations will use these."}
          {dirty && save.phase === "idle" && "Unsaved changes, kept in this browser until you save."}
          {save.phase === "error" && <span className="text-mw-danger">{save.message}</span>}
        </p>
      </div>
      )}
    </form>
  );
}

function InstructionsField(props: {
  id: string;
  label: string;
  value: string;
  max: number;
  placeholder: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
}) {
  const over = props.value.length > props.max;
  const countId = `${props.id}-count`;
  return (
    <div>
      {/* The section heading already reads as the question, so the label is
          visually hidden rather than repeated. */}
      <label className="sr-only" htmlFor={props.id}>
        {props.label}
      </label>
      <Textarea
        id={props.id}
        rows={4}
        value={props.value}
        placeholder={props.placeholder}
        aria-describedby={countId}
        aria-invalid={over || undefined}
        readOnly={props.readOnly}
        onChange={(event) => props.onChange(event.target.value)}
        className="min-h-24 read-only:text-mw-text-muted"
      />
      <p
        id={countId}
        className={`mt-1 text-right text-xs ${over ? "text-mw-danger" : "text-mw-text-muted"}`}
      >
        {props.value.length} / {props.max}
      </p>
    </div>
  );
}
