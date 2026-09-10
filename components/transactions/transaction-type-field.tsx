'use client'

import { useId, useRef, useState } from 'react'
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
 * are mutually exclusive, so the radio role is the honest one. This
 * implements the WAI-ARIA Radio Group pattern in full (spec §14 fix round 1,
 * finding 3), not just the role/`aria-checked` shell a first pass had:
 *
 *  - roving `tabIndex` — only the checked radio is a tab stop (`0`), every
 *    other one is `-1`, so Tab moves PAST the group in one stop, matching how
 *    a native `<input type="radio">` group behaves;
 *  - ←/↑ and →/↓ move to the previous/next radio AND check it (the native
 *    convention — a `radiogroup`'s arrow keys are not mere focus movement);
 *  - Home/End jump to the first/last radio in the currently visible set;
 *  - Space/Enter on the focused radio checks it — free from the native
 *    `<button>` element underneath, no extra handler needed.
 *
 * The "Khác" disclosure `<button>` is a SIBLING of the `role="radiogroup"`
 * element, not a child of it: an ARIA radiogroup's only required owned role
 * is `radio`, and a first pass nested the disclosure button inside the same
 * container the two primary radios were in. The four "other" radios are
 * rendered (or not) INSIDE the one radiogroup alongside the two primary ones,
 * so collapsing the disclosure genuinely removes them from the roving set —
 * there is exactly one `role="radiogroup"` for all six types, always.
 *
 * The disclosure may never hide the CHECKED radio (spec §14 fix round 2
 * regression): a first pass let the user collapse "Khác" while an Other-type
 * value (e.g. `ADJUSTMENT_INCREASE`) was checked, which dropped it out of
 * `visibleTypes` entirely — no rendered radio was checked, so every one got
 * `tabIndex=-1` and the group had zero tab stops, breaking the one WAI-ARIA
 * invariant this whole rewrite exists to satisfy. Two fixes, together:
 *
 *  (a) `showOther` is now `otherOpenedByUser || isOtherChecked` — an
 *      Other-type value being checked always wins over a collapsed
 *      preference, and the toggle button is itself `disabled` while that is
 *      true, so there is no control that could re-close it out from under
 *      the checked value;
 *  (b) `tabStopIndex` falls back to the FIRST visible radio whenever the
 *      checked value is not among `visibleTypes` (structurally unreachable
 *      after (a), but the invariant matters more than trusting that it always
 *      will be) — the safety net, not the primary defence.
 *
 * `useId()` (spec §14 fix round 1, finding 2) makes the legend's id — and
 * therefore `aria-labelledby` — unique per mounted instance: the sticky panel
 * and the mobile sheet can each hold their own `TransactionTypeField`, and a
 * hard-coded id would make the second instance's `aria-labelledby` dangle or
 * collide with the first's.
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
  const legendId = `transaction-type-legend-${useId().replace(/:/g, '')}`
  const isOtherChecked = OTHER_TYPES.includes(value)
  // The user's OWN toggle preference — but `showOther` below is what the
  // group actually renders from, and an Other-type value being checked
  // always overrides a collapsed preference. Open by default when an "other"
  // type is already chosen, so an edit or a rejected submit never hides the
  // field that holds the current value.
  const [otherOpenedByUser, setOtherOpenedByUser] = useState(() => isOtherChecked)
  const showOther = otherOpenedByUser || isOtherChecked
  const buttonRefs = useRef(new Map<TransactionType, HTMLButtonElement>())
  const visibleTypes = showOther ? [...PRIMARY_TYPES, ...OTHER_TYPES] : PRIMARY_TYPES
  const checkedIndex = visibleTypes.indexOf(value)
  // Safety net (b): if the checked value is somehow not among the currently
  // visible radios — unreachable given (a) above, but the WAI-ARIA "exactly
  // one tab stop" invariant matters more than trusting that it always will
  // be — the FIRST visible radio becomes the tab stop instead of leaving
  // zero, and arrow-key navigation starts from it too.
  const tabStopIndex = checkedIndex === -1 ? 0 : checkedIndex

  function focusAndCheck(type: TransactionType) {
    onChange(type)
    buttonRefs.current.get(type)?.focus()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    let nextIndex: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (tabStopIndex + 1) % visibleTypes.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (tabStopIndex - 1 + visibleTypes.length) % visibleTypes.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = visibleTypes.length - 1
        break
      default:
        return
    }
    // Arrow/Home/End are the radiogroup's own keys — the page must never
    // scroll or the browser's native Home/End text-navigation fire instead.
    event.preventDefault()
    focusAndCheck(visibleTypes[nextIndex])
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p id={legendId} className="text-[0.8125rem]/[1.125rem] font-medium">
          {legend}
        </p>
        {/* Outside `role="radiogroup"` below — see the file doc comment.
            Disabled (not just visually inert) while an Other-type value is
            checked: collapsing is exactly the action that used to strand the
            radiogroup with zero tab stops (fix round 2's regression), so the
            one control that could re-close it is itself turned off for as
            long as the checked value needs it open. */}
        <button
          type="button"
          aria-expanded={showOther}
          disabled={disabled || isOtherChecked}
          onClick={() => setOtherOpenedByUser((open) => !open)}
          className="flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {otherLabel}
          {/* Flipped, not animated: the design system does not animate, so
              the chevron simply IS the other way up while the panel is open. */}
          <ChevronDown aria-hidden="true" className={cn('size-4', showOther && 'rotate-180')} />
        </button>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={legendId}
        onKeyDown={handleKeyDown}
        className="grid grid-cols-2 gap-2"
      >
        {visibleTypes.map((type, index) => (
          <TypeButton
            key={type}
            type={type}
            label={labels[type]}
            checked={value === type}
            // `index === tabStopIndex`, not `checked`: identical whenever the
            // checked value is actually visible (the normal case), but this
            // is what makes the (b) safety net real — the first visible
            // radio still gets `tabIndex=0` even in the edge case where NO
            // radio is checked.
            isTabStop={index === tabStopIndex}
            onSelect={onChange}
            disabled={disabled}
            buttonRef={(el) => {
              if (el) buttonRefs.current.set(type, el)
              else buttonRefs.current.delete(type)
            }}
          />
        ))}
      </div>
    </div>
  )
}

function TypeButton({
  type,
  label,
  checked,
  isTabStop,
  onSelect,
  disabled,
  buttonRef,
}: {
  type: TransactionType
  label: string
  checked: boolean
  isTabStop: boolean
  onSelect: (type: TransactionType) => void
  disabled?: boolean
  buttonRef: (el: HTMLButtonElement | null) => void
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={checked}
      // Roving tabindex: exactly one radio in the group is a tab stop —
      // `isTabStop`, not `checked` (see the call site and the file doc
      // comment's fix (b)).
      tabIndex={isTabStop ? 0 : -1}
      disabled={disabled}
      onClick={() => onSelect(type)}
      className={cn(
        // `min-h-11` is the 44 px touch target.
        'min-h-11 rounded-md border px-3 text-sm',
        checked
          ? // `text-brand-on-tint`, not `text-brand` (Task 16, F6): a checked
            // radio is the tinted-pill pattern — `text-<tone>` on a wash of the
            // same tone — and `text-brand` on `bg-brand/18` measured 3.54:1
            // against `--surface-2` in dark, i.e. a FORM CONTROL's own label
            // under the 4.5:1 minimum. Same hue and chroma, L stepped only far
            // enough to clear it; see `app/globals.css`'s ON-TINT table.
            'border-brand bg-brand/10 font-medium text-brand-on-tint dark:bg-brand/18'
          : 'border-border text-foreground hover:bg-muted',
      )}
    >
      {label}
    </button>
  )
}
