/**
 * Whether the selected model can see an image, client-side.
 *
 * The API already refuses an image sent to a text-only model, with a good
 * message, at 422 — `vision.refusal_message` wrote it. That refusal is the
 * authority and is not being replaced here. What it cannot do is arrive in
 * time: by then the user has chosen a file, waited for a 5 MB upload, pressed
 * Send and watched a spinner. The requirement is that they "learn that while
 * choosing, not after waiting", so the same question is asked here, from the
 * same source, before the file picker ever opens.
 *
 * ## Tri-state, and why `null` is permissive
 *
 * `/api/models` serves `supports_vision` as `true | false | null`, and `null`
 * means the gateway did not say. `vision.py` spells out the trade and this
 * module must make the same one or the two will disagree: an unknown model is
 * ALLOWED through. A bare llama.cpp or vLLM build serves a `/v1/models` with
 * nothing but `id`, so treating silence as "no" would grey out the paperclip
 * on the default local setup and make the whole feature look broken. The cost
 * of a wrong yes is the upstream error the user would have got anyway; the
 * cost of a wrong no is a capable model the user cannot use and cannot
 * override.
 *
 * `"Default"` in the picker (`null` model) is the same case: the server
 * resolves it to `settings.default_model`, whose capability the client cannot
 * know without duplicating that resolution. Allowed through, and the server's
 * 422 is the backstop.
 */

import type { ModelInfo } from "../../types";

export type VisionVerdict = "yes" | "no" | "unknown";

/**
 * What the model list says about `modelId`.
 *
 * A model absent from the list is `unknown`, not `no` — the picker and the
 * gateway can disagree transiently, and that must not become a refusal.
 * Mirrors `vision.support_for`.
 */
export function visionOf(
  models: readonly ModelInfo[] | null,
  modelId: string | null,
): VisionVerdict {
  if (modelId === null || models === null) return "unknown";
  const entry = models.find((model) => model.id === modelId);
  if (entry === undefined) return "unknown";
  if (entry.supports_vision === true) return "yes";
  if (entry.supports_vision === false) return "no";
  return "unknown";
}

/** The ids the gateway positively says accept images. Mirrors `vision.vision_capable_ids`. */
export function visionCapableIds(models: readonly ModelInfo[] | null): string[] {
  if (models === null) return [];
  return models.filter((model) => model.supports_vision === true).map((model) => model.id);
}

/**
 * What a user is told when the model they picked cannot see images.
 *
 * Deliberately parallel to the server's `vision.refusal_message`, with one
 * difference that matters: the server's version says "the attachment is
 * saved and nothing was lost", because by then it has been uploaded. This one
 * fires *before* the upload, so it says nothing about saving — there is
 * nothing to save yet, and the honest version of this refusal is shorter.
 *
 * Naming the models that do accept images is what turns an error into a next
 * step, and it is omitted rather than faked when the gateway named none.
 */
export function visionRefusal(modelId: string, capableIds: readonly string[]): string {
  const base = `${modelId} cannot read images.`;
  if (capableIds.length === 0) {
    return `${base} Switch to a vision-capable model to attach one. Your message is untouched.`;
  }
  const shown = [...capableIds].sort().slice(0, 3).join(", ");
  return `${base} Switch the model to ${shown} to attach one. Your message is untouched.`;
}
