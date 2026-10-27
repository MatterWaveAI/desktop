import { AI_DISCLOSURE } from "./aiDisclosureText";

/** Rendered in the chat empty state, before a first-time user can type. */
export function AiDisclosure() {
  return (
    <p className="max-w-md text-sm font-medium text-mw-text">{AI_DISCLOSURE}</p>
  );
}
