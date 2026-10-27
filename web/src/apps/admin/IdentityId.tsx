import { clipboardAvailable } from "../chat/clipboard";
import { CopyButton } from "../../components/ui/copy-button";

/**
 * An identity provider's id (a user's subject, an organisation's Zitadel
 * org id) as the operator needs it: something to paste into the IdP's
 * console, not a string to read. A Copy button where the clipboard works;
 * where it does not (plain http on a LAN address) the id itself, selectable,
 * so the table still carries it.
 */
export function IdentityId(props: { id: string; label: string }) {
  if (!clipboardAvailable()) {
    return (
      <span className="font-mono text-xs text-mw-text-muted" title={props.label}>
        {props.id}
      </span>
    );
  }
  return (
    <CopyButton
      text={props.id}
      label={props.label}
      variant="ghost"
      size="xs"
      className="-ml-2 font-normal text-mw-text-muted"
    />
  );
}
