'use client'

import { Select } from '@base-ui/react/select'
import { ChevronDown } from 'lucide-react'

/**
 * The category picker (spec §2: "a custom Select only where option richness or
 * hierarchy needs it — category picker with two groups").
 *
 * A native `<optgroup>` can hold a heading, but it cannot be styled to the
 * design system and its heading is announced inconsistently across platforms;
 * more to the point, the two groups here are the *whole* information — an
 * expense category and an income category of the same name mean different
 * things — so the hierarchy is the reason this one is custom.
 *
 * Built directly on `@base-ui/react/select`'s parts, not the generated
 * `components/ui/select.tsx` — see `account-select.tsx`'s doc comment for why.
 * `items` is handed to `Select.Root` as Base UI 1.8's grouped shape
 * (`{ items: { value, label }[] }[]`), which is what lets `Select.Value`
 * resolve the trigger's label from the selected id without a render-prop.
 *
 * Controlled, and unavoidably so: a Base UI Select has no uncontrolled DOM form
 * value, so it is driven by react-hook-form's `Controller`. The caller renders
 * it only after `useHydrated()` (the form's fieldset is disabled until then
 * anyway) and renders a `disabled` native `<select>` holding the selected
 * option in the server HTML, so the first paint says the right thing, is
 * labelable, and looks like the other inputs. This is the one place Phase 7
 * introduces a controlled control, and it is because the primitive has no other
 * mode — NOT to silence a Base UI warning, which spec §9 forbids.
 *
 * `undefined`, never `''`, for "nothing chosen": that is what lets
 * `createTransactionFormSchema`'s friendly "Category is required for income and
 * expense transactions" refine message fire instead of the generic "at least 1
 * character" a stray `''` would trigger. The caller's `onChange` normalises,
 * and this component passes `''` to the primitive only as its own placeholder
 * value because a Base UI Select's `value` may not be `undefined`.
 */
const NONE = ''

export function CategorySelect({
  id,
  groups,
  value,
  onChange,
  placeholder,
  ...aria
}: {
  id: string
  /** One entry per group; `label` is already translated by the caller. */
  groups: { labelKey: string; label: string; items: { id: string; name: string }[] }[]
  value: string | undefined
  onChange: (categoryId: string | undefined) => void
  placeholder: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}) {
  const items = groups.map((group) => ({
    items: group.items.map((item) => ({ value: item.id, label: item.name })),
  }))

  return (
    <Select.Root
      items={items}
      value={value ?? NONE}
      onValueChange={(next: string | null) => onChange(!next ? undefined : next)}
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
            {groups.map((group) => (
              <Select.Group key={group.labelKey}>
                {/* The group heading is the point of this component. `px-2 pt-2`
                    rather than a divider: two headings and a rule between them
                    is more furniture than a twelve-item list needs. */}
                <Select.GroupLabel className="px-2 pt-2 pb-1 text-xs/[1rem] font-medium tracking-[0.04em] text-muted-foreground uppercase">
                  {group.label}
                </Select.GroupLabel>
                {group.items.map((item) => (
                  <Select.Item
                    key={item.id}
                    value={item.id}
                    className="flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-muted data-selected:font-medium data-selected:text-brand"
                  >
                    <Select.ItemText>{item.name}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Group>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
