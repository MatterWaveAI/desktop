import { useContext, useState } from "react";
import { ApiError } from "../../lib/api";
import { DestructiveConfirm } from "../../patterns";
import { ShellContext } from "../../shell/shellContext";
import { useKeyboardShortcuts } from "../../shell/useKeyboardShortcuts";

/**
 * The delete-this-conversation chord, behind the app's one destructive
 * confirm. The delete itself is the shell's, the same call the sidebar's
 * Delete makes, so the list, the open conversation and the page agree.
 *
 * Mounted by the chat page: "this conversation" means the one on screen,
 * and from settings or help the chord is left to the browser.
 */
export function DeleteConversationShortcut(props: { conversationId: string | null }) {
  // Nullable, like the conversation menu's: a test mounts this without the shell.
  const shell = useContext(ShellContext);
  const [open, setOpen] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { conversationId } = props;
  const title =
    conversationId === null
      ? null
      : (shell?.conversations.find((c) => c.id === conversationId)?.title ?? null);

  useKeyboardShortcuts({
    "delete-chat":
      conversationId !== null && shell !== null
        ? () => {
            setError(null);
            setOpen(true);
          }
        : undefined,
  });

  if (conversationId === null || shell === null) return null;

  const confirm = () => {
    setInFlight(true);
    shell
      .deleteConversation(conversationId)
      // The shell's delete also takes `?c=` off the address.
      .then(() => setOpen(false))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not delete the conversation.");
      })
      .finally(() => setInFlight(false));
  };

  return (
    <DestructiveConfirm
      open={open}
      onOpenChange={(next) => {
        if (!inFlight) setOpen(next);
      }}
      title="Delete this conversation?"
      description={
        <>
          {title !== null ? (
            <>
              <span className="font-medium">{title}</span> is removed from your list.
            </>
          ) : (
            "It is removed from your list."
          )}
          {error !== null && (
            <span role="alert" className="mt-2 block text-mw-danger">
              {error}
            </span>
          )}
        </>
      }
      confirmLabel="Delete"
      inFlight={inFlight}
      onConfirm={confirm}
    />
  );
}
