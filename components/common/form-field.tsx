'use client'

import { cn } from 'cn'

/**
 * One labelled field (spec §2, §8): a visible `<label htmlFor>` above the
 * control, optional 12 px helper, and an error bound to the control through
 * `aria-describedby` — the three things every input in this app was missing.
 *
 * The control is a render prop rather than `children`, because the ids have to
 * land ON the control and only the caller knows what it is (an `Input`, a
 * native `<select>`, a shadcn `Select`). The callback hands back exactly the
 * three attributes to spread.
 *
 * A CLIENT module, and deliberately: `FieldError` below translates a Zod
 * message literal, which needs a translator. `label` and `helper` still arrive
 * already translated from the caller; only the ERROR is translated there,
 * because only the error's text comes from a schema rather than from a message
 * file. Every form in this app is already a client component, so the boundary
 * costs nothing; a server page that wants a labelled read-only field uses
 * `Label` directly.
 *
 * Ordering note (Task 1b/2c): Task 2c's `lib/ui/validation-messages.ts` has not
 * landed yet, so `FieldError` below renders its `children` verbatim and does
 * not yet call `useTranslations()` — see its own doc comment for the wiring
 * Task 2c adds.
 */
export function FormField({
  id,
  label,
  helper,
  error,
  children,
  className,
}: {
  id: string
  label: string
  helper?: string
  error?: string
  children: (aria: {
    id: string
    'aria-describedby': string | undefined
    'aria-invalid': true | undefined
  }) => React.ReactNode
  className?: string
}) {
  const helperId = helper ? `${id}-helper` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [helperId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}
      {helper && (
        <p id={helperId} className="text-xs/[1rem] text-muted-foreground">
          {helper}
        </p>
      )}
      {error && <FieldError id={errorId!}>{error}</FieldError>}
    </div>
  )
}

export function Label({
  htmlFor,
  children,
  className,
}: {
  htmlFor: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn('text-[0.8125rem]/[1.125rem] font-medium text-foreground', className)}
    >
      {children}
    </label>
  )
}

/**
 * A native `<select>` styled to match `Input` (spec §2: native is the default;
 * a custom Select is only for the transaction Category and Account pickers).
 *
 * Exported from here rather than copied into the nine forms that need it, so
 * "a select looks like an input" is one string and not nine. `appearance-none`
 * plus `pr-9` leaves room for the chevron, which the caller renders as a
 * `<ChevronDown className="pointer-events-none absolute right-3 …" />` sibling
 * inside a `relative` wrapper — an inline data-URI background image was tried
 * first and its escaping is brittle in Tailwind v4's arbitrary-value parser.
 */
export const SELECT_CLASS =
  'h-11 w-full min-w-0 appearance-none rounded-md border border-input bg-[var(--input-bg)] px-3 py-2 pr-9 text-base transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50 md:h-10 md:text-sm'

/**
 * A field's error — and, eventually, the render boundary where a Zod message
 * becomes Vietnamese (spec §4).
 *
 * The schemas in `lib/validation/**` keep their English literals: Phase 2–6
 * tests assert them, the server re-produces them, and changing them would be a
 * validation-semantics change this phase forbids. So the translation is meant
 * to happen HERE, keyed by the literal itself — `t('validation.Enter an
 * amount')` — with the literal as its own fallback, so a message that somehow
 * has no entry degrades to readable English rather than to a key path.
 *
 * Task 1b ran before Task 2c: `lib/ui/validation-messages.ts` and
 * `validationMessageKey` do not exist yet, so this renders `children` verbatim
 * for now. Task 2c wires `const t = useTranslations(); const message =
 * typeof children === 'string' ? t(validationMessageKey(children), { ... })
 * : children` here (checking `next-intl`'s actual missing-key behaviour first —
 * v4.14's `useTranslations` return type has no `fallback` option, so Task 2c
 * must use `t.has` or a try/catch instead, per the brief).
 */
export function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    // `role="alert"` so a validation message that appears on submit is
    // announced, and `aria-describedby` (wired by `FormField`) so a screen
    // reader also reads it when focus lands back on the field.
    <p id={id} role="alert" className="text-xs/[1rem] text-negative">
      {children}
    </p>
  )
}
