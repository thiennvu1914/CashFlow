'use client'

import { useId } from 'react'
import { useTranslations } from 'next-intl'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import type { LinkNamespace } from '@/components/debts/link-to-account-form'

/** A translator that takes ICU values — `useTranslations()` and
 *  `createTranslator()` both fit it. */
type TranslateWithValues = (key: string, values?: Record<string, string | number>) => string

/**
 * What the confirmation says will happen. The opening (debt) or disbursement
 * (loan) transaction always goes and the balances move back; with the box
 * ticked, the transactions of the payments recorded in an account go too, and
 * how many is said outright. With none recorded there is no box and nothing to
 * say about payments.
 */
export function unlinkConfirmDescription(
  t: TranslateWithValues,
  namespace: LinkNamespace,
  linkedPayments: number,
  includePayments: boolean,
): string {
  return linkedPayments > 0 && includePayments
    ? t(`${namespace}.unlinkConfirmBodyWithPayments`, { count: linkedPayments })
    : t(`${namespace}.unlinkConfirmBody`)
}

/**
 * "Bỏ ghi cả N lần trả đã ghi vào tài khoản / Also remove the N payments
 * recorded in an account": a native checkbox like the link dialog's "Ghi bù"
 * box, controlled by the menu that opens the dialog (which ticks it again each
 * time it opens). The whole label is the hit area, at least 44 px tall below
 * the icon rail.
 */
export function UnlinkPaymentsChoice({
  namespace,
  count,
  checked,
  onCheckedChange,
}: {
  namespace: LinkNamespace
  count: number
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const t = useTranslations()
  const id = `${namespace}-unlink-payments-${useId().replace(/:/g, '')}`
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 items-center gap-2 text-sm text-foreground md:min-h-9"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
        className="size-4 shrink-0 accent-brand"
      />
      {t(`${namespace}.unlinkIncludePayments`, { count })}
    </label>
  )
}

/**
 * "Bỏ ghi vào tài khoản / Remove from account" (final review F1): the
 * confirmation before a debt's or a loan's recording in an account is undone —
 * the one `ConfirmDialog` this product uses, with the payments choice as its
 * body when any payment is recorded in an account (ticked by default: a wrong
 * account is usually wrong for the payments too, since their picker starts on
 * the opening's account).
 *
 * The caller owns the choice and the submit, as it owns the write-off's: the
 * dialog closes on both outcomes, and a failure is explained on the row
 * (`useRowError`). On success the page re-renders with the agreement unlinked,
 * and its menu offers "Record in an account" again.
 */
export function UnlinkFromAccountDialog({
  namespace,
  name,
  linkedPayments,
  includePayments,
  onIncludePaymentsChange,
  open,
  onOpenChange,
  onConfirm,
}: {
  namespace: LinkNamespace
  /** The debt's person or the loan's lender, for the title. */
  name: string
  /** How many payments (instalments) are recorded in an account. */
  linkedPayments: number
  includePayments: boolean
  onIncludePaymentsChange: (includePayments: boolean) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
}) {
  const t = useTranslations()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(`${namespace}.unlinkConfirmTitle`, { name })}
      description={unlinkConfirmDescription(t, namespace, linkedPayments, includePayments)}
      confirmLabel={t(`${namespace}.unlinkAction`)}
      cancelLabel={t('common.cancel')}
      pendingLabel={t(`${namespace}.unlinkPending`)}
      onConfirm={onConfirm}
    >
      {linkedPayments > 0 && (
        <UnlinkPaymentsChoice
          namespace={namespace}
          count={linkedPayments}
          checked={includePayments}
          onCheckedChange={onIncludePaymentsChange}
        />
      )}
    </ConfirmDialog>
  )
}
