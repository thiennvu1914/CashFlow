'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { TransactionType } from '@prisma/client'
import { cn } from 'cn'

/**
 * The transaction type, as a segmented control with a disclosure for the four
 * rarer types (spec §6.2).
 *
 * Chi tiêu and Thu nhập are what a person records all day; the other four —
 * Tiền vào (khác), Tiền ra (khác), Điều chỉnh tăng, Điều chỉnh giảm — are
 * corrections and untracked movements, and putting all six in one row of a
 * mobile form gave the two common cases a sixth of the space each.
 *
 * A `radiogroup`, not a `<select>`, and not six independent buttons: the six
 * are mutually exclusive, so the radio role is the honest one and it brings
 * arrow-key navigation with it. `aria-checked` and the visible fill both carry
 * the state, so nothing depends on seeing colour.
 *
 * This is NOT `components/common/segmented-control.tsx`: that primitive is
 * link-based (the address bar owns which segment is showing, which is right for
 * a period filter and wrong for a form field).
 */
const PRIMARY_TYPES: TransactionType[] = ['EXPENSE', 'INCOME']
const OTHER_TYPES: TransactionType[] = [
  'CASH_IN',
  'CASH_OUT',
  'ADJUSTMENT_INCREASE',
  'ADJUSTMENT_DECREASE',
]

export function TransactionTypeField({
  value,
  onChange,
  labels,
  legend,
  otherLabel,
  disabled,
}: {
  value: TransactionType
  onChange: (type: TransactionType) => void
  labels: Record<TransactionType, string>
  legend: string
  otherLabel: string
  disabled?: boolean
}) {
  // Open when an "other" type is already chosen, so an edit or a rejected
  // submit never hides the field that holds the current value.
  const [showOther, setShowOther] = useState(() => OTHER_TYPES.includes(value))

  return (
    <div className="flex flex-col gap-2">
      <p id="transaction-type-legend" className="text-[0.8125rem]/[1.125rem] font-medium">
        {legend}
      </p>
      <div
        role="radiogroup"
        aria-labelledby="transaction-type-legend"
        className="flex flex-col gap-2"
      >
        <div className="flex gap-2">
          {PRIMARY_TYPES.map((type) => (
            <TypeButton
              key={type}
              type={type}
              label={labels[type]}
              checked={value === type}
              onSelect={onChange}
              disabled={disabled}
            />
          ))}
          <button
            type="button"
            aria-expanded={showOther}
            disabled={disabled}
            onClick={() => setShowOther((open) => !open)}
            className="flex min-h-11 items-center gap-1 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {otherLabel}
            {/* Flipped, not animated: the design system does not animate, so
                the chevron simply IS the other way up while the panel is open. */}
            <ChevronDown aria-hidden="true" className={cn('size-4', showOther && 'rotate-180')} />
          </button>
        </div>
        {showOther && (
          <div className="grid grid-cols-2 gap-2">
            {OTHER_TYPES.map((type) => (
              <TypeButton
                key={type}
                type={type}
                label={labels[type]}
                checked={value === type}
                onSelect={onChange}
                disabled={disabled}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TypeButton({
  type,
  label,
  checked,
  onSelect,
  disabled,
}: {
  type: TransactionType
  label: string
  checked: boolean
  onSelect: (type: TransactionType) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onSelect(type)}
      className={cn(
        // `min-h-11` is the 44 px touch target; `flex-1` so the two primary
        // types share the row evenly.
        'min-h-11 flex-1 rounded-md border px-3 text-sm',
        checked
          ? 'border-brand bg-brand/10 font-medium text-brand dark:bg-brand/18'
          : 'border-border text-foreground hover:bg-muted',
      )}
    >
      {label}
    </button>
  )
}
