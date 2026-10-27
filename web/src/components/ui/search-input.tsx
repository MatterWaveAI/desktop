import * as React from "react"
import { SearchIcon } from "lucide-react"
import { cn } from "cn"

/**
 * A search box: a type=search field with the magnifier inside its leading
 * edge. The icon is decorative; the field still needs a name, so pass
 * `aria-label` (or wrap it in a Field, which supplies the id a <label>
 * points at). Styled like Input: the inset fill, the strong control edge,
 * the focus blue.
 */
function SearchInput({
  className,
  wrapperClassName,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & { wrapperClassName?: string }) {
  return (
    <div data-slot="search-input" className={cn("relative flex min-w-0 items-center", wrapperClassName)}>
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute left-3 size-4 text-mw-text-muted"
      />
      <input
        type="search"
        className={cn(
          "h-9 w-full min-w-0 rounded-lg border border-input bg-mw-surface py-1 pr-3 pl-9 text-base text-foreground transition-colors outline-none placeholder:text-muted-foreground hover:border-mw-text-muted focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-mw-surface-hover disabled:text-mw-text-muted md:text-sm [&::-webkit-search-cancel-button]:cursor-pointer",
          className
        )}
        {...props}
      />
    </div>
  )
}

export { SearchInput }
