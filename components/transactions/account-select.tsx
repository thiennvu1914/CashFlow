'use client'

import { Select } from '@base-ui/react/select'
import { ChevronDown } from 'lucide-react'

/**
 * The account picker (spec §2: "a custom Select only where option richness or
 * hierarchy needs it — ... account picker with balance and currency").
 *
 * A native `<option>` can hold only text, and an account is three facts — name,
 * balance, currency — that the user is choosing *between*. Every other select
 * in this app stays native.
 *
 * Built directly on `@base-ui/react/select`'s parts rather than on the
 * generated `components/ui/select.tsx`: that file's `SelectTrigger` is a
 * `w-fit`, 32/28 px, `bg-transparent` control sized for a toolbar, not a
 * `FormField`'s full-width 44/40 px input — matching `Input`/`SELECT_CLASS`'s
 * look here would mean overriding most of its baked classes anyway. This is
 * the same call `RowActionsMenu` already made against `components/ui/
 * dropdown-menu.tsx`, for the same reason (see that file's doc comment).
 * `data-highlighted:bg-muted` (not the generated file's `focus:bg-accent`)
 * matches `RowActionsMenu`'s own popup-item hover, keeping the two menus that
 * exist in this app visually consistent.
 *
 * `items` (Base UI 1.8's flat `{ value, label }[]` shape) is handed to
 * `Select.Root` so `Select.Value` resolves the trigger's label itself —
 * without it, `Select.Value` would only ever echo the raw account id string.
 *
 * Controlled, and that is unavoidable: a Base UI Select has no uncontrolled DOM
 * form value, so it is driven by react-hook-form's `Controller`. The caller
 * renders it only after `useHydrated()` (the form's fieldset is disabled until
 * then anyway) and shows the selected option's label as static text in the
 * server HTML, so the pre-hydration markup still says the right thing. This is
 * the one place Phase 7 introduces a controlled control, and it is because the
 * primitive has no other mode — NOT to silence a Base UI warning, which spec §9
 * forbids.
 */
export function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  placeholder,
  optionLabel,
  ...aria
}: {
  id: string
  accounts: { id: string; name: string; currency: string; balance: string }[]
  value: string
  onChange: (accountId: string) => void
  placeholder: string
  /** `(account) => "Cash · 5.000.000 VND"`, already formatted and translated. */
  optionLabel: (account: { name: string; currency: string; balance: string }) => string
  'aria-describedby'?: string
  'aria-invalid'?: true
}) {
  const items = accounts.map((account) => ({ value: account.id, label: optionLabel(account) }))

  return (
    <Select.Root
      items={items}
      value={value}
      onValueChange={(next: string | null) => onChange(next ?? '')}
    >
      <Select.Trigger
        id={id}
        aria-describedby={aria['aria-describedby']}
        aria-invalid={aria['aria-invalid']}
        // No `outline-none`: the global `:focus-visible` rule (`app/globals.css`)
        // is this app's ONLY keyboard focus ring, and a first pass here
        // silenced it on this control specifically (spec §14 fix round 1,
        // finding 7).
        className="flex h-11 w-full items-center justify-between rounded-md border border-input bg-[var(--input-bg)] px-3 py-2 text-base md:h-10 md:text-sm"
      >
        <Select.Value placeholder={placeholder} />
        <Select.Icon>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={4} className="z-50">
          <Select.Popup className="max-h-72 min-w-[var(--anchor-width)] overflow-y-auto rounded-lg border border-border bg-surface-2 p-1 shadow-[0_8px_24px_rgba(25,33,30,0.10)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.40)]">
            {accounts.map((account) => (
              <Select.Item
                key={account.id}
                value={account.id}
                className="flex cursor-default items-center rounded-md px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)] data-highlighted:bg-muted data-selected:font-medium data-selected:text-brand"
              >
                <Select.ItemText>{optionLabel(account)}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
