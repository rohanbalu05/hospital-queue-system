import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-md border border-input bg-surface px-3 py-1 text-base shadow-xs transition-[color,box-shadow]  selection:bg-primary selection:text-primary-foreground file:mr-3 file:inline-flex file:h-8 file:cursor-pointer file:items-center file:rounded-md file:border file:border-rule file:bg-secondary file:px-3 file:text-sm file:font-bold file:text-ink hover:file:bg-rule/50 placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm ",
        "   ",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/30 ",
        className
      )}
      {...props}
    />
  )
}

export { Input }
