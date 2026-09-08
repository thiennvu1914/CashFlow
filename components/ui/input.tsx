import * as React from 'react'
import { Input as InputPrimitive } from '@base-ui/react/input'
import { cn } from 'cn'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-11 w-full min-w-0 rounded-md border border-input bg-[var(--input-bg)] px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-negative md:h-10 md:text-sm',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
