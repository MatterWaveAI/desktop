import { CopyButton } from "../../components/ui/copy-button";

/**
 * Copy, under a reply: the product's one Copy button, as an icon in the
 * message toolbar. Writes the reply's flattened text -- `message.content`,
 * the same thing export writes -- and reads "Copied" for two seconds. No
 * clipboard API, no button: a Copy that cannot copy is worse than none.
 */
export function CopyAction(props: { text: string; disabled?: boolean }) {
  return (
    <CopyButton
      text={props.text}
      label="Copy"
      copiedLabel="Copied"
      iconOnly
      variant="ghost"
      disabled={props.disabled}
      className="text-mw-text-muted hover:text-mw-text pointer-coarse:size-11 [&_svg]:size-3.5"
    />
  );
}
