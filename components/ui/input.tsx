import * as React from 'react'
import { Input as InputPrimitive } from '@base-ui/react/input'
import { cn } from 'cn'

/**
 * Task 16: `outline-none` used to sit in this base class and, exactly as on
 * `buttonVariants` (finding F13), it left every text field in the product with
 * NO focus ring — measured in the browser as `outline-style: none` while
 * `:focus-visible` matched, on Settings' display-name field and on every field
 * of every create sheet. It is replaced by spec §2's ring, stated here so a
 * field is ringed regardless of the global `:focus-visible` rule. `outline-2`
 * had to REPLACE `outline-none` rather than join it: in Tailwind v4
 * `outline-none` sets `--tw-outline-style: none`, which `outline-2` then reads.
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-11 w-full min-w-0 rounded-md border border-input bg-[var(--input-bg)] px-3 py-2 text-base transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-negative md:h-10 md:text-sm',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
