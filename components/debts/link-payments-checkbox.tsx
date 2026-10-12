'use client'

import type { UseFormRegisterReturn } from 'react-hook-form'

/**
 * "Ghi bù N lần trả đã có / Also record the N existing payments" — the one
 * yes/no question of the "Record in an account" dialogs (spec 2026-10-12
 * §6.4), shared by the debt and the loan one like `DebtAccountField`.
 *
 * A native checkbox, like the native `<select>` beside it: a single boolean
 * needs no richer control, and being uncontrolled it gets its server-rendered
 * `checked` from `defaultChecked` — on by default, as the spec asks. The whole
 * label is the hit area, at least 44 px tall below the icon rail (spec §8),
 * and the helper is wired as its description.
 */
export function LinkPaymentsCheckbox({
  id,
  label,
  helper,
  registration,
}: {
  id: string
  label: string
  helper: string
  registration: UseFormRegisterReturn
}) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className="flex min-h-11 items-center gap-2 text-sm text-foreground md:min-h-9"
      >
        <input
          id={id}
          type="checkbox"
          defaultChecked
          aria-describedby={`${id}-helper`}
          className="size-4 shrink-0 accent-brand"
          {...registration}
        />
        {label}
      </label>
      <p id={`${id}-helper`} className="text-xs/[1rem] text-muted-foreground">
        {helper}
      </p>
    </div>
  )
}
