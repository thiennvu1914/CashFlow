'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Locale } from '@/lib/i18n/locale'
import {
  closeLoanAction,
  deleteLoanPaymentAction,
  unlinkLoanFromAccountAction,
} from '@/lib/server/actions/loan-actions'
import { LOAN_ERROR_KEYS, LOAN_FROZEN_ACCOUNT_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import type { DebtAccountOption } from '@/lib/ui/debt-accounts'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import type { LoanDto, LoanPaymentDto } from '@/lib/ui/loan-view-model'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Dialog } from '@/components/common/dialog'
import { RowActionsMenu, type RowAction } from '@/components/common/row-actions-menu'
import { useRowError } from '@/components/common/row-error-context'
import { agreementMenuActions } from '@/components/debts/agreement-menu-actions'
import { UnlinkFromAccountDialog } from '@/components/debts/unlink-from-account-dialog'
import { Button } from '@/components/ui/button'
import { LoanEditForm } from './loan-edit-form'
import { LoanLinkForm } from './loan-link-form'
import { LoanPaymentForm } from './loan-payment-form'

/**
 * Record payment / Edit / Close loan for one loan row — split into two
 * independent pieces (fix round 1, findings 4/5/6/7), rendered by `LoanList`
 * into two different `PlanningRow` slots:
 *
 *  - `LoanPaymentButton` — the row's one inline action, passed as
 *    `inlineAction`. `variant="outline"` (not filled): the header's "Thêm
 *    khoản vay" is the page's one primary action, and a filled button on
 *    every row competed with it (fix round 1, finding 4 — the same treatment
 *    the goal row's inline action got). Needs the reader's `locale` (threaded
 *    from the page, same convention as `AccountList`/`TransactionList`) to
 *    format Tổng in the same language the rest of the dialog reads in (fix
 *    round 1, finding 1) — a formatted VND figure is not itself English or
 *    Vietnamese, but its DIGIT GROUPING is a locale, and `formatMoney`'s
 *    locale parameter defaults to `vi` when omitted, which is what silently
 *    produced Vietnamese grouping inside an otherwise-English dialog.
 *  - `LoanRowMenu` — Edit / Record in an account (or, once recorded, Remove
 *    from account) / Close loan, passed as `actions`. Its close and unlink
 *    failures are reported through `useRowError` rather
 *    than a local `useState`: `LoanList` renders this into `actions` and a
 *    `RowErrorAlert` into `extra` (under the row), and only a shared Context
 *    can connect a menu click to an alert that renders elsewhere in the tree.
 *
 * Neither ever mounts on the Dashboard's compact list (no `renderActions`
 * there). In the page's closed section only the menu mounts: a closed loan
 * refuses every write except "Record in an account" (spec 2026-10-12 §6.4)
 * and its undo, "Remove from account" (final review F1) — closing it did not
 * undo the money that moved, nor decide which account it moved through. A
 * PAID_OFF loan is *not* closed and keeps
 * both: a final interest charge can still be recorded (ruling R6-6), and
 * closing it is how the user says they are finished with it.
 *
 * Recording an instalment writes a `LoanPayment` row, advances the loan's
 * `nextDueDate` and, when an account is chosen, books the principal and the
 * interest into it (money-source linking, spec 2026-10-12 §6.3).
 * `LoanPaymentActions` is the third piece: Edit and Delete for one line of the
 * instalment history, mounted by `LoanList`'s `renderPaymentActions` — a
 * correction or removal updates both linked transactions with it, which the
 * confirm copy says.
 *
 * An instalment and an edit are two forms, not one — `LoanPaymentForm`
 * (`loan-payment-form.tsx`) and `LoanEditForm` (`loan-edit-form.tsx`) — because
 * they are two user intents: "I paid the April instalment" and "the instalment
 * changed after the rate review". A single form would make either an
 * accidental submission of the other. The payment form's pure arithmetic
 * (`cents`/`totalFromParts`/`displayTotal`) and its resolver live in
 * `loan-payment-math.ts`, split out (Phase 8 pre-flight A-9) so the module
 * whose test file cannot import a React component (`loan-payment-math.test.ts`
 * — pure functions, no DOM) is not this one.
 *
 * Both forms mount only while their `Dialog` is open, so `useForm` snapshots
 * the *current* row as its defaults; there is no stale-default problem to gate
 * for, and no `useHydrated` here — a click cannot happen before hydration.
 */
export function LoanPaymentButton({
  loan,
  today,
  locale,
  accounts,
  mostRecentAccountId,
}: {
  loan: LoanDto
  today: string
  locale: Locale
  accounts: ReadonlyArray<DebtAccountOption>
  mostRecentAccountId: string | null
}) {
  const t = useTranslations()
  const [paymentOpen, setPaymentOpen] = useState(false)

  // A closed loan refuses every write (`LoanNotActiveError`); guarded here as
  // well as by the page (which renders the closed section without a
  // `renderActions` slot), because this component is the one that knows what
  // its button does.
  if (!loan.active) return null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        // Height only: `size="sm"`'s 36 px is a mouse target, and spec §8
        // wants 44 px under a thumb — so this inline row action is 44 px
        // below the icon rail and the compact 36 px from `md` up.
        className="h-11 md:h-9"
        aria-label={`${t('loans.paymentAction')} · ${loan.lender}`}
        onClick={() => setPaymentOpen(true)}
      >
        {t('loans.paymentAction')}
      </Button>

      <Dialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        title={t('loans.paymentTitle', { name: loan.lender })}
        description={t('loans.description')}
        closeLabel={t('common.close')}
      >
        {paymentOpen && (
          <LoanPaymentForm
            loan={loan}
            today={today}
            locale={locale}
            accounts={accounts}
            mostRecentAccountId={mostRecentAccountId}
            onDone={() => setPaymentOpen(false)}
          />
        )}
      </Dialog>
    </>
  )
}

export function LoanPaymentActions({
  loan,
  payment,
  today,
  locale,
  accounts,
  mostRecentAccountId,
  dateLabel,
}: {
  loan: LoanDto
  payment: LoanPaymentDto
  today: string
  locale: Locale
  accounts: ReadonlyArray<DebtAccountOption>
  mostRecentAccountId: string | null
  /** The date exactly as the history line prints it, for the accessible names. */
  dateLabel: string
}) {
  const t = useTranslations()
  const [editOpen, setEditOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { setError } = useRowError()
  const deleteSubmit = useActionSubmit(t)
  const labelArgs = { date: dateLabel, amount: payment.total }

  async function confirmDelete() {
    await deleteSubmit.run({
      tag: 'LoanPaymentActions: delete failed',
      action: () => deleteLoanPaymentAction(payment.id),
      errorKeys: LOAN_FROZEN_ACCOUNT_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      // Closes on BOTH outcomes: the row's message renders behind this
      // dialog's own scrim (`components/common/confirm-dialog.tsx`).
      onSettled: () => setDeleting(false),
    })
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        aria-label={t('loans.paymentEditLabel', labelArgs)}
        onClick={() => setEditOpen(true)}
      >
        {t('loans.paymentEditAction')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-negative"
        aria-label={t('loans.paymentDeleteLabel', labelArgs)}
        onClick={() => {
          setError(null)
          setDeleting(true)
        }}
      >
        {t('loans.paymentDeleteAction')}
      </Button>

      <Dialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={t('loans.paymentEditTitle', { name: loan.lender })}
        closeLabel={t('common.close')}
      >
        {editOpen && (
          <LoanPaymentForm
            loan={loan}
            today={today}
            locale={locale}
            accounts={accounts}
            mostRecentAccountId={mostRecentAccountId}
            payment={payment}
            onDone={() => setEditOpen(false)}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('loans.paymentDeleteConfirmTitle')}
        description={
          payment.accountId
            ? t('loans.paymentDeleteConfirmLinked')
            : t('loans.paymentDeleteConfirmPlain')
        }
        confirmLabel={t('loans.paymentDeleteAction')}
        cancelLabel={t('common.cancel')}
        pendingLabel={t('loans.paymentDeletePending')}
        onConfirm={confirmDelete}
      />
    </>
  )
}

export function LoanRowMenu({
  loan,
  today,
  accounts,
  mostRecentAccountId,
}: {
  loan: LoanDto
  /** The user's own calendar day (`todayCalendarDateInZone` on the page): the
   *  latest day "Record in an account" may date the money (Ruling P12). */
  today: string
  /** Every active account; "Record in an account" keeps the ones in the
   *  loan's currency. */
  accounts: ReadonlyArray<DebtAccountOption>
  mostRecentAccountId: string | null
}) {
  const t = useTranslations()
  const [editOpen, setEditOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [unlinking, setUnlinking] = useState(false)
  const [unlinkPayments, setUnlinkPayments] = useState(true)
  const [closing, setClosing] = useState(false)
  const { setError } = useRowError()
  const closeSubmit = useActionSubmit(t)
  const unlinkSubmit = useActionSubmit(t)

  // "Record in an account" while the disbursement moved no money (spec §6.4),
  // "Remove from account" once it has; the page re-renders with
  // `disbursementAccountId` changed after either, so the other one shows.
  const linkedPayments = loan.payments.filter((payment) => payment.accountId !== null).length
  const actions: RowAction[] = agreementMenuActions(
    { active: loan.active, linked: loan.disbursementAccountId !== null },
    {
      edit: { id: 'edit', label: t('loans.editAction'), onSelect: () => setEditOpen(true) },
      link: {
        id: 'link',
        label: t('loans.linkAction'),
        onSelect: () => {
          setError(null)
          setLinkOpen(true)
        },
      },
      unlink: {
        id: 'unlink',
        label: t('loans.unlinkAction'),
        onSelect: () => {
          setError(null)
          // Ticked again on every opening — the default, not the last choice.
          setUnlinkPayments(true)
          setUnlinking(true)
        },
      },
      finish: {
        id: 'close',
        label: t('loans.closeAction'),
        tone: 'negative',
        onSelect: () => {
          setError(null)
          setClosing(true)
        },
      },
    },
  )

  async function confirmUnlink() {
    await unlinkSubmit.run({
      tag: 'LoanRowMenu: unlink failed',
      action: () =>
        unlinkLoanFromAccountAction(loan.id, {
          includePayments: linkedPayments > 0 && unlinkPayments,
        }),
      errorKeys: LOAN_FROZEN_ACCOUNT_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      // Closes on BOTH outcomes, as closing the loan does.
      onSettled: () => setUnlinking(false),
    })
  }

  async function confirmClose() {
    await closeSubmit.run({
      tag: 'LoanRowMenu: close failed',
      action: () => closeLoanAction(loan.id),
      errorKeys: LOAN_ERROR_KEYS,
      onError: (failure) => setError(failure?.message ?? null),
      // Closes on BOTH outcomes: the row's message renders behind this
      // dialog's own scrim (`components/common/confirm-dialog.tsx`).
      onSettled: () => setClosing(false),
    })
  }

  return (
    <>
      <RowActionsMenu label={t('common.rowActions', { name: loan.lender })} actions={actions} />

      <Dialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={t('loans.editTitle', { name: loan.lender })}
        closeLabel={t('common.close')}
      >
        {editOpen && <LoanEditForm loan={loan} onDone={() => setEditOpen(false)} />}
      </Dialog>

      <Dialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        title={t('loans.linkTitle', { name: loan.lender })}
        description={t('loans.linkDescription')}
        closeLabel={t('common.close')}
      >
        {linkOpen && (
          <LoanLinkForm
            loan={loan}
            today={today}
            accounts={accounts}
            mostRecentAccountId={mostRecentAccountId}
            onDone={() => setLinkOpen(false)}
          />
        )}
      </Dialog>

      <UnlinkFromAccountDialog
        namespace="loans"
        name={loan.lender}
        linkedPayments={linkedPayments}
        includePayments={unlinkPayments}
        onIncludePaymentsChange={setUnlinkPayments}
        open={unlinking}
        onOpenChange={setUnlinking}
        onConfirm={confirmUnlink}
      />

      <ConfirmDialog
        open={closing}
        onOpenChange={setClosing}
        title={t('loans.closeConfirmTitle', { name: loan.lender })}
        description={t('loans.closeConfirmBody')}
        confirmLabel={t('loans.closeAction')}
        cancelLabel={t('common.cancel')}
        pendingLabel={t('loans.closePending')}
        onConfirm={confirmClose}
      />
    </>
  )
}
