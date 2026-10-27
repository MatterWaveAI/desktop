import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { cn } from "cn"

// The guard lives with chat, which had the first Copy control; every copy
// in the product goes through it so an insecure origin (plain http on the
// kind cluster) behaves the same everywhere.
import { clipboardAvailable } from "@/apps/chat/clipboard"
import { useCopy } from "@/apps/chat/useCopy"
import { Button } from "@/components/ui/button"

/**
 * The one Copy button.
 *
 *   <CopyButton text={apiKey} label="Copy key" />
 *
 * Renders nothing when the clipboard API is unavailable: a Copy that cannot
 * copy is worse than none, and the text beside it is still selectable. A
 * failed write leaves the label alone, so "Copied" is never claimed for a
 * copy that did not happen. The wrapper is the live region, so the label
 * change is announced without re-reading the button's name.
 *
 * `text` may be a function, for a value that is expensive to build or not
 * known until the click.
 */
function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  iconOnly = false,
  variant = "outline",
  size,
  className,
  disabled,
}: {
  text: string | (() => string)
  label?: string
  copiedLabel?: string
  /** Icon-only buttons keep `label` as their accessible name. */
  iconOnly?: boolean
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
  className?: string
  disabled?: boolean
}) {
  const { copied, copy } = useCopy()
  if (!clipboardAvailable()) return null
  const current = copied ? copiedLabel : label
  return (
    <span data-slot="copy-button" aria-live="polite" className="inline-flex">
      <Button
        type="button"
        variant={variant}
        size={size ?? (iconOnly ? "icon-sm" : "sm")}
        className={cn(className)}
        disabled={disabled}
        aria-label={iconOnly ? current : undefined}
        onClick={() => void copy(typeof text === "function" ? text() : text)}
      >
        {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        {!iconOnly && current}
      </Button>
    </span>
  )
}

export { CopyButton }
