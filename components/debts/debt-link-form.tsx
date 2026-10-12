'use client'

import { linkDebtToAccountAction } from '@/lib/server/actions/debt-actions'
import { DEBT_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import type { DebtAccountOption } from '@/lib/ui/debt-accounts'
import type { DebtDto } from '@/lib/ui/debt-view-model'
import { LinkToAccountForm } from '@/components/debts/link-to-account-form'

/**
 * "Record in an account" for a debt (spec 2026-10-12 §6.4), mounted by
 * `DebtRowMenu`: the shared `LinkToAccountForm`, dated by default on the day
 * the debt was added (`createdOn`, in the user's zone) unless a payment still
 * to record is older, and submitting `linkDebtToAccountAction` — which writes
 * the opening on that day and, when asked, each payment on its own day.
 */
export function DebtLinkForm({
  debt,
  accounts,
  mostRecentAccountId,
  onDone,
}: {
  debt: DebtDto
  accounts: ReadonlyArray<DebtAccountOption>
  mostRecentAccountId: string | null
  onDone: () => void
}) {
  return (
    <LinkToAccountForm
      namespace="debts"
      currency={debt.currency}
      agreementDate={debt.createdOn}
      payments={debt.payments}
      accounts={accounts}
      mostRecentAccountId={mostRecentAccountId}
      errorKeys={DEBT_ERROR_KEYS}
      submit={({ date, ...rest }) => linkDebtToAccountAction(debt.id, { ...rest, openedOn: date })}
      onDone={onDone}
    />
  )
}
