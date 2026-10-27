/**
 * The example prompts offered on the new-conversation surface.
 *
 * The ticket's requirement is "example prompts that actually work" - so these
 * are deliberately model-agnostic: no tool use, no retrieval, no file upload,
 * nothing that depends on a capability this deployment may not have. Each is
 * answerable by a plain text completion from any model the gateway serves,
 * which is what makes clicking one a safe first impression rather than a
 * demonstration of a missing feature.
 *
 * Kept as data in its own module so the empty state, the dev states page and
 * the tests all name the same four prompts.
 */
export interface ExamplePrompt {
  /** The short label on the card. */
  readonly title: string;
  /** What actually lands in the composer. */
  readonly prompt: string;
}

export const EXAMPLE_PROMPTS: readonly ExamplePrompt[] = [
  {
    title: "Explain a concept",
    prompt: "Explain the difference between a process and a thread, with one concrete example.",
  },
  {
    title: "Draft something",
    prompt:
      "Draft a short, friendly email telling a customer their scheduled maintenance window has moved to Sunday.",
  },
  {
    title: "Review some code",
    prompt:
      "What are the common mistakes when using async/await in JavaScript, and how do I avoid each one?",
  },
  {
    title: "Plan a piece of work",
    prompt:
      "Help me break down migrating a small Postgres database to a new host into ordered, checkable steps.",
  },
];
