import { useContext, useEffect, useRef, useState } from "react";
import { MoreHorizontalIcon } from "lucide-react";
import { ApiError, apiFetch } from "../../lib/api";
import { ShellContext } from "../../shell/shellContext";
import type { Conversation, Folder } from "../../types";
import { DestructiveConfirm } from "../../patterns";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";

export type ExportFormat = "markdown" | "json";

/**
 * The actions on the conversation as a whole: rename, pin, archive, file
 * and delete it; share it, export it, compact it, report it.
 *
 * A small menu beside the model picker rather than a row of buttons, because
 * each of these is used once in a long while and four permanent buttons on
 * the header would outweigh the two controls a person uses every turn. The
 * shared dropdown menu: portalled and collision-aware, so it never opens
 * past the edge of a phone, with the WAI-ARIA menu keys (arrows, Home, End,
 * Escape) and focus back on the button when it closes.
 *
 * Rename, pin, archive, move and delete are the shell's, not the page's:
 * the row lives on the shell's conversation list, where the sidebar reads
 * it, and the shell's actions update every reader at once -- the same
 * actions the sidebar's row menu runs, so the two menus cannot disagree.
 * They appear only when the menu is mounted inside the shell with an open
 * conversation, and the page that mounts it passes nothing for them.
 */
export function ConversationActions(props: {
  /** True while a turn streams: an export (or a share) then would be of a half-written answer. */
  busy: boolean;
  /** Absent hides the item: a temporary conversation cannot be shared. */
  onShare?: () => void;
  onExport: (format: ExportFormat) => void;
  onReport: () => void;
  /**
   * Fold the older turns into a summary now. Absent hides the item. Present,
   * it is enabled whenever no turn is streaming: the server answers a thread
   * with nothing to fold with a 409, which the page shows in the thread, so
   * a greyed item nobody can explain is never the answer.
   */
  onCompact?: () => void;
}) {
  // Nullable on purpose: a test mounts this menu without the shell, and
  // outside it there is simply nothing to rename.
  const shell = useContext(ShellContext);
  const activeId = shell?.activeConversationId ?? null;
  const renameConversation = shell?.renameConversation;
  const conversation: Conversation | null =
    activeId === null ? null : (shell?.conversations.find((c) => c.id === activeId) ?? null);
  const title = conversation?.title ?? null;
  const canRename = activeId !== null && title !== null && renameConversation !== undefined;
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  // Pin, archive and move answer with the updated row or a refusal; the
  // refusal is said where the rename's is, beside the button.
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The folders to file under, read when the menu first opens: the sidebar
  // holds its own copy, and a second read here is cheaper than threading it
  // through the page that has no other use for it.
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const loadFolders = () => {
    if (folders !== null || conversation === null) return;
    apiFetch<{ folders?: unknown }>("/api/library")
      .then((body) => setFolders(Array.isArray(body.folders) ? (body.folders as Folder[]) : []))
      .catch(() => setFolders([]));
  };
  const attempt = (work: Promise<unknown>, failure: string) => {
    setActionError(null);
    void work.catch((err: unknown) => {
      setActionError(err instanceof ApiError ? err.message : failure);
    });
  };
  const moveTo = (folderId: string | null) => {
    if (conversation === null || shell === null) return;
    attempt(
      apiFetch(`/api/library/conversations/${conversation.id}/folder`, {
        method: "PUT",
        json: { folder_id: folderId },
      }).then(() => shell.reloadConversations()),
      "Could not move the conversation.",
    );
  };
  const confirmDelete = async () => {
    if (conversation === null || shell === null) return;
    setDeleting(true);
    try {
      await shell.deleteConversation(conversation.id);
      setConfirmingDelete(false);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not delete the conversation.");
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  };
  const pinned = Boolean(conversation?.pinned_at);
  const archived = Boolean(conversation?.archived_at);
  // Rename hands focus to its field, which mounts as the menu closes; the
  // menu must not then take it back to the button, or the field's blur
  // would end the rename before a key was pressed.
  const focusPlaced = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Share and Report open a modal dialog. The menu hands focus back to its
  // button only after its close animation, by which time the dialog is open:
  // that late focus would land outside the modal and Tab would walk out of
  // it. So focus goes to the button now, before the dialog opens -- which
  // also gives the dialog a live element to return focus to on close -- and
  // the menu is told to leave focus alone.
  const toDialog = (action: () => void) => () => {
    focusPlaced.current = true;
    buttonRef.current?.focus();
    action();
  };

  const busyTitle = props.busy ? "Wait for the answer to finish" : undefined;
  const itemClass = "w-full px-2 py-1.5 text-left text-sm pointer-coarse:py-3";

  return (
    <div className="flex items-center gap-2">
      {(renameError ?? actionError) && !renaming && (
        <p role="alert" className="max-w-48 text-xs leading-tight text-mw-danger">
          {renameError ?? actionError}
        </p>
      )}
      {renaming && canRename ? (
        <HeaderRenameField
          title={title}
          onDone={() => {
            setRenaming(false);
            buttonRef.current?.focus();
          }}
          onSave={(name) => {
            setRenameError(null);
            renameConversation(activeId, name).catch((err: unknown) => {
              setRenameError(
                err instanceof ApiError ? err.message : "Could not rename the conversation.",
              );
            });
          }}
        />
      ) : (
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) loadFolders();
          }}
        >
          <DropdownMenuTrigger
            ref={buttonRef}
            aria-label="Conversation actions"
            className="inline-flex size-8 items-center justify-center rounded border border-mw-border text-mw-text-muted hover:bg-mw-surface-hover hover:text-mw-text pointer-coarse:size-11"
          >
            <MoreHorizontalIcon className="size-4" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            aria-label="Conversation actions"
            className="w-56 border border-mw-border bg-mw-surface-raised text-mw-text"
            finalFocus={() => {
              const keep = !focusPlaced.current;
              focusPlaced.current = false;
              return keep;
            }}
          >
            {canRename && (
              <DropdownMenuItem
                nativeButton
                render={<button type="button" />}
                className={itemClass}
                onClick={() => {
                  focusPlaced.current = true;
                  setRenaming(true);
                }}
              >
                Rename…
              </DropdownMenuItem>
            )}
            {conversation !== null && shell !== null && (
              <>
                <DropdownMenuItem
                  nativeButton
                  render={<button type="button" />}
                  className={itemClass}
                  onClick={() =>
                    attempt(
                      shell.setPinned(conversation.id, !pinned),
                      pinned ? "Could not unpin it." : "Could not pin it.",
                    )
                  }
                >
                  {pinned ? "Unpin" : "Pin"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  nativeButton
                  render={<button type="button" />}
                  className={itemClass}
                  onClick={() =>
                    attempt(
                      shell.setArchived(conversation.id, !archived),
                      archived ? "Could not unarchive it." : "Could not archive it.",
                    )
                  }
                >
                  {archived ? "Unarchive" : "Archive"}
                </DropdownMenuItem>
                {/* Only once there is a folder to file under: a "Move to"
                    with "No folder" as its one choice offers nothing. */}
                {folders !== null && folders.length > 0 && (
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="px-2 pt-1.5 text-xs font-medium uppercase tracking-wide text-mw-text-muted">
                      Move to
                    </DropdownMenuLabel>
                    <FolderItem
                      current={!conversation.folder_id}
                      className={itemClass}
                      onClick={() => moveTo(null)}
                    >
                      No folder
                    </FolderItem>
                    {folders.map((folder) => (
                      <FolderItem
                        key={folder.id}
                        current={conversation.folder_id === folder.id}
                        className={itemClass}
                        onClick={() => moveTo(folder.id)}
                      >
                        {folder.name}
                      </FolderItem>
                    ))}
                  </DropdownMenuGroup>
                )}
                <DropdownMenuSeparator />
              </>
            )}
            {props.onShare !== undefined && (
              <>
                <DropdownMenuItem
                  nativeButton
                  render={<button type="button" />}
                  className={itemClass}
                  disabled={props.busy}
                  title={busyTitle}
                  onClick={props.onShare && toDialog(props.onShare)}
                >
                  Share…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              nativeButton
              render={<button type="button" />}
              className={itemClass}
              disabled={props.busy}
              title={busyTitle}
              onClick={() => props.onExport("markdown")}
            >
              Export as Markdown
            </DropdownMenuItem>
            <DropdownMenuItem
              nativeButton
              render={<button type="button" />}
              className={itemClass}
              disabled={props.busy}
              title={busyTitle}
              onClick={() => props.onExport("json")}
            >
              Export as JSON
            </DropdownMenuItem>
            {props.onCompact && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  nativeButton
                  render={<button type="button" />}
                  className={itemClass}
                  disabled={props.busy}
                  title={
                    props.busy
                      ? "Wait for the answer to finish"
                      : "Summarise the earlier messages so the conversation fits the model"
                  }
                  onClick={props.onCompact}
                >
                  Compact now
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              nativeButton
              render={<button type="button" />}
              className={itemClass}
              onClick={toDialog(props.onReport)}
            >
              Report conversation…
            </DropdownMenuItem>
            {conversation !== null && shell !== null && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  nativeButton
                  variant="destructive"
                  render={<button type="button" />}
                  className={`${itemClass} text-mw-danger`}
                  onClick={toDialog(() => setConfirmingDelete(true))}
                >
                  Delete…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {conversation !== null && (
        <DestructiveConfirm
          open={confirmingDelete}
          onOpenChange={(next) => {
            if (!deleting) setConfirmingDelete(next);
          }}
          title="Delete this conversation?"
          description={
            <>
              <span className="font-medium">{conversation.title}</span> and its messages are
              deleted. This cannot be undone; archive it instead to keep it out of the list.
            </>
          }
          confirmLabel="Delete"
          inFlight={deleting}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}

/** One folder to file under, ticked where the conversation already is. */
function FolderItem(props: {
  current: boolean;
  className: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenuItem
      nativeButton
      render={<button type="button" />}
      aria-current={props.current ? "true" : undefined}
      className={`${props.className} flex items-center gap-2`}
      onClick={props.onClick}
    >
      <span className="w-3 shrink-0 text-mw-link" aria-hidden>
        {props.current ? "✓" : ""}
      </span>
      <span className="min-w-0 flex-1 truncate">{props.children}</span>
    </DropdownMenuItem>
  );
}

/**
 * The title, editable where the menu was. Enter and blur save, Escape
 * cancels; an empty or unchanged name is a cancel, since there is nothing
 * to send. Enter closes the field, which blurs it, and the guard makes
 * that one save rather than two.
 */
function HeaderRenameField(props: {
  title: string;
  onSave: (name: string) => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(props.title);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function finish(save: boolean) {
    if (settled.current) return;
    settled.current = true;
    const name = value.trim();
    props.onDone();
    if (save && name && name !== props.title) props.onSave(name);
  }

  return (
    <form
      /* In the header row, where the menu button was: no popup to clip. */
      className="w-48 sm:w-72"
      onSubmit={(event) => {
        event.preventDefault();
        finish(true);
      }}
    >
      <input
        ref={ref}
        type="text"
        aria-label={`New name for ${props.title}`}
        value={value}
        maxLength={200}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
        /* 16px below the md breakpoint, as the composer: Safari zooms a
           field under 16px on focus and never zooms back. */
        className="w-full rounded-md border border-mw-border bg-mw-surface px-2 py-1 text-base focus:border-mw-focus focus:outline-none md:text-sm"
      />
    </form>
  );
}
