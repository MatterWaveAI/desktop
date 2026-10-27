import { useEffect, useState } from "react";
import { CompassIcon } from "lucide-react";
import type { AuthConfig, Principal } from "../types";
import { ApiError, apiFetch } from "../lib/api";
import { loadModels } from "../lib/models";
import { AI_DISCLOSURE } from "../apps/chat/aiDisclosureText";

/**
 * The first-run walkthrough: three short steps between a new account and
 * the shell, shown once.
 *
 * Mounted by Boot in place of the shell after verification and the terms,
 * the same way those gates are, and unlike them it is skippable from every
 * step: it exists to be seen, not to be passed. Finishing and skipping both
 * record `onboarding.completed_at`, so it is never shown again -- on this
 * device or any other, because the flag is on the account.
 *
 * What it says is what a person needs before the first message: what they
 * are talking to (the model, and that it is an AI that can be wrong), where
 * the token allowance and the bill live, and a chance to fix the name the shell will
 * greet them by. The name step is optional and saves only if changed.
 *
 * The model is named by its label from /api/models, never its raw id; until
 * the list answers (or if it cannot) the sentence names no model at all.
 * Usage and Billing are named rather than linked: a link would leave the
 * walkthrough half-way, and since it is not finished, land back on it.
 */
export function Onboarding(props: {
  config: AuthConfig;
  principal: Principal;
  onDone: (principal: Principal) => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(props.principal.name ?? "");
  const [state, setState] = useState<"idle" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const defaultModel = props.config.default_model;

  useEffect(() => {
    let alive = true;
    loadModels()
      .then((list) => {
        const id = list.default_model || defaultModel;
        const label = list.data?.find((m) => m.id === id)?.label;
        if (alive && label) setModelLabel(label);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [defaultModel]);

  const total = STEPS.length;
  const last = step === total - 1;

  async function complete(saveName: boolean) {
    setState("saving");
    setError(null);
    let updatedName = props.principal.name;
    try {
      const trimmed = name.trim();
      if (saveName && trimmed && trimmed !== (props.principal.name ?? "")) {
        const saved = await apiFetch<{ name: string }>("/api/me", {
          method: "PATCH",
          json: { full_name: trimmed },
        });
        updatedName = saved.name;
      }
      await apiFetch("/api/me/onboarding/complete", { method: "POST" });
    } catch (err) {
      setState("idle");
      setError(err instanceof ApiError ? err.message : "Could not save. Try again.");
      return;
    }
    props.onDone({ ...props.principal, name: updatedName, onboarding_completed: true });
  }

  return (
    <main className="h-full overflow-y-auto bg-mw-surface text-mw-text" data-mw-onboarding="">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-12">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-mw-surface-hover text-mw-link">
            <CompassIcon className="size-6" aria-hidden />
          </span>
          <p className="text-xs font-medium uppercase tracking-wide text-mw-text-muted">
            Step {step + 1} of {total}
          </p>
          <h1
            id="onboarding-step"
            className="font-heading text-2xl font-semibold tracking-tight"
            aria-live="polite"
          >
            {STEPS[step].title}
          </h1>
        </div>

        <section className="flex flex-col gap-3 text-sm" aria-labelledby="onboarding-step">
          {step === 0 && (
            <>
              <p>
                MatterWave is a chat workspace. Every answer comes from{" "}
                {modelLabel ? (
                  <>
                    <span className="font-medium">{modelLabel}</span>, the model this deployment
                    serves by default
                  </>
                ) : (
                  "the model this deployment serves by default"
                )}
                ; you can pick another in the message box when more are offered.
              </p>
              <p className="rounded-md border border-mw-border bg-mw-surface-raised p-3 text-mw-text-muted">
                {AI_DISCLOSURE}
              </p>
            </>
          )}
          {step === 1 && (
            <>
              <p>
                Answers use tokens from your organisation's monthly allowance.{" "}
                <span className="font-medium">Settings › Usage</span> shows what has been used and
                when it resets; the app says so itself at 80% and again at the limit.
              </p>
              <p>
                The plan, the invoice and the way to change either live in{" "}
                <span className="font-medium">Settings › Billing</span>. A notification bell in the
                header tells you when any of this moves.
              </p>
            </>
          )}
          {step === 2 && (
            <>
              <p>
                This is the name the app will greet you by and that other members of your
                organisation will see. Leave it as it is, or change it now.
              </p>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-mw-text-muted">Display name</span>
                <input
                  type="text"
                  value={name}
                  maxLength={120}
                  autoComplete="name"
                  onChange={(event) => setName(event.target.value)}
                  className="rounded-md border border-mw-border bg-mw-surface px-3 py-2 text-sm focus:border-mw-focus focus:outline-none"
                />
              </label>
            </>
          )}
        </section>

        <div className="flex items-center gap-2">
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              disabled={state === "saving"}
              className="rounded-lg border border-mw-border px-4 py-2 text-sm hover:bg-mw-surface-hover disabled:opacity-60"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={() => (last ? void complete(true) : setStep((s) => s + 1))}
            disabled={state === "saving"}
            className="ml-auto rounded-lg bg-mw-accent px-4 py-2 text-sm font-medium text-mw-accent-foreground hover:opacity-90 disabled:opacity-60"
          >
            {last ? (state === "saving" ? "Saving…" : "Finish") : "Next"}
          </button>
        </div>

        {/* aria-live, so a refusal is announced rather than only appearing. */}
        <p
          aria-live="polite"
          role={error ? "alert" : undefined}
          className="min-h-5 text-xs text-mw-danger"
        >
          {error}
        </p>

        <button
          type="button"
          onClick={() => void complete(false)}
          disabled={state === "saving"}
          className="self-center text-xs text-mw-text-muted underline hover:text-mw-text disabled:opacity-60"
        >
          Skip the tour
        </button>
      </div>
    </main>
  );
}

const STEPS = [
  { title: "What you are talking to" },
  { title: "Where usage and billing live" },
  { title: "What should we call you?" },
] as const;
