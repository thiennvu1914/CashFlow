'use client'

import { linkLoanToAccountAction } from '@/lib/server/actions/loan-actions'
import { LOAN_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import type { DebtAccountOption } from '@/lib/ui/debt-accounts'
import type { LoanDto } from '@/lib/ui/loan-view-model'
import { LinkToAccountForm } from '@/components/debts/link-to-account-form'

/**
 * "Record in an account" for a loan (spec 2026-10-12 §6.4), mounted by
 * `LoanRowMenu`: the shared `LinkToAccountForm` (`components/debts/`, beside
 * the account field both agreements already share), under the create form's
 * own "Nhận tiền vào tài khoản" label, dated by default on the loan's start
 * date unless an instalment still to record is older, and submitting
 * `linkLoanToAccountAction` — which writes the disbursement on that day and,
 * when asked, each instalment's principal and interest on its own day.
 */
export function LoanLinkForm({
  loan,
  accounts,
  mostRecentAccountId,
  onDone,
}: {
  loan: LoanDto
  accounts: ReadonlyArray<DebtAccountOption>
  mostRecentAccountId: string | null
  onDone: () => void
}) {
  return (
    <LinkToAccountForm
      namespace="loans"
      currency={loan.currency}
      agreementDate={loan.startDate}
      payments={loan.payments}
      accounts={accounts}
      mostRecentAccountId={mostRecentAccountId}
      errorKeys={LOAN_ERROR_KEYS}
      submit={({ date, ...rest }) =>
        linkLoanToAccountAction(loan.id, { ...rest, disbursedOn: date })
      }
      onDone={onDone}
    />
  )
}
