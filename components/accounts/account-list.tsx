'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Wallet } from 'lucide-react'
import type { Currency } from '@prisma/client'
import type { Locale } from '@/lib/i18n/locale'
import { archiveFinancialAccountAction } from '@/lib/server/actions/financial-account-actions'
import { ACCOUNT_ERROR_KEYS } from '@/lib/ui/action-error-messages'
import { formatMoney } from '@/lib/ui/format-money'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import { AccountEditForm } from '@/components/accounts/account-edit-form'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Dialog } from '@/components/common/dialog'
import { EmptyState } from '@/components/common/empty-state'
import { FinancialListRow } from '@/components/common/financial-list-row'
import { InlineAlert } from '@/components/common/inline-alert'
import { MoneyText } from '@/components/common/money-text'
import { RowActionsMenu } from '@/components/common/row-actions-menu'

type AccountType = { id: string; name: string }

/**
 * One row of `/accounts` (spec §6.4): a name, its type and currency, the
 * derived current balance, and whether it may still change its currency and
 * opening balance.
 */
export interface AccountRow {
  id: string
  name: string
  currency: Currency
  description: string | null
  initialBalance: number
  accountTypeId: string
  accountType: { name: string }
  /**
   * Serialised with `.toFixed(2)` on the server (`app/(app)/accounts/page.tsx`)
   * — a `Prisma.Decimal` is not a plain object a server component can pass to
   * a client component, so the balance crosses that boundary as a string and
   * is parsed back with `Number()` here for display only.
   */
  balance: string
  /**
   * Computed server-side by `accountsWithActivity` — whether the account has
   * any Transaction or Transfer against it. Drives the edit form's `locked`
   * prop; this component makes no activity decision of its own.
   */
  locked: boolean
}

export function AccountList({
  accounts,
  accountTypes,
  locale,
}: {
  accounts: AccountRow[]
  accountTypes: AccountType[]
  locale: Locale
}) {
  const router = useRouter()
  const t = useTranslations()
  const [editing, setEditing] = useState<AccountRow | null>(null)
  /** The row awaiting archive confirmation, or `null`. One dialog for the whole list. */
  const [pendingArchive, setPendingArchive] = useState<AccountRow | null>(null)
  const [errorByAccountId, setErrorByAccountId] = useState<Record<string, string>>({})
  const submit = useActionSubmit(t)

  /** Removes any stale message for one row — a fresh confirmation attempt or
   *  a dismissed dialog must never leave a PREVIOUS attempt's error behind. */
  function clearError(accountId: string) {
    setErrorByAccountId((prev) => {
      if (!(accountId in prev)) return prev
      const next = { ...prev }
      delete next[accountId]
      return next
    })
  }

  /** Opens the archive confirmation for a row, clearing any error a previous
   *  attempt on the SAME row left behind — a retry starts clean. */
  function openArchiveConfirm(account: AccountRow) {
    clearError(account.id)
    setPendingArchive(account)
  }

  /** The `ConfirmDialog`'s own `onOpenChange`: fires only when the user backs
   *  out (Cancel, the close button, Escape, the overlay) — never when this
   *  component closes the dialog itself (`confirmArchive` sets `pendingArchive`
   *  to `null` directly on both outcomes). Backing out also clears a stale
   *  error, for the same reason `openArchiveConfirm` does. */
  function handleArchiveDialogOpenChange(open: boolean) {
    if (open) return
    if (pendingArchive) clearError(pendingArchive.id)
    setPendingArchive(null)
  }

  async function confirmArchive(account: AccountRow) {
    await submit.run({
      tag: 'AccountList: archive failed',
      action: () => archiveFinancialAccountAction(account.id),
      errorKeys: ACCOUNT_ERROR_KEYS,
      // The row's own sink, so two rows cannot overwrite each other's message.
      onError: (failure) =>
        failure === null
          ? clearError(account.id)
          : setErrorByAccountId((prev) => ({ ...prev, [account.id]: failure.message })),
      // The dialog closes on BOTH outcomes (spec §10): left open, its scrim
      // hides the very `InlineAlert` below that explains why the archive was
      // refused — the user would see a dialog that appears to have done nothing.
      onSettled: () => setPendingArchive(null),
      onSuccess: () => router.refresh(),
    })
  }

  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        size="page"
        title={t('accounts.emptyTitle')}
        description={t('accounts.emptyBody')}
      />
    )
  }

  return (
    <>
      <div className="card-hover-effect overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
        <ul className="divide-y divide-border">
          {accounts.map((account) => {
            const isNegative = account.balance.startsWith('-')
            return (
              <FinancialListRow
                key={account.id}
                title={account.name}
                meta={`${account.accountType.name} · ${account.currency}`}
                wrapMeta
                amount={
                  <MoneyText
                    value={formatMoney(account.balance, account.currency, locale)}
                    currency={account.currency}
                    tone={isNegative ? 'negative' : 'default'}
                  />
                }
                actions={
                  <RowActionsMenu
                    label={t('common.rowActions', { name: account.name })}
                    actions={[
                      {
                        id: 'edit',
                        label: t('accounts.editAction'),
                        onSelect: () => setEditing(account),
                      },
                      {
                        id: 'archive',
                        label: t('accounts.archiveAction'),
                        tone: 'negative',
                        onSelect: () => openArchiveConfirm(account),
                      },
                    ]}
                  />
                }
              />
            )
          })}
        </ul>
      </div>

      {/* Row-level failures, below the card: an error inside a fixed-height
          row would either clip or shift the figures beside it. */}
      {Object.entries(errorByAccountId).map(([id, message]) => (
        <InlineAlert key={id} tone="negative" className="mt-2">
          {message}
        </InlineAlert>
      ))}

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing ? t('accounts.editTitle', { name: editing.name }) : ''}
        closeLabel={t('common.close')}
      >
        {/* Mounted only while `editing` is set — this is what removes the
            form's SSR-defaults problem (spec §9): with no server render to
            disagree with, there is nothing for the hydration gate to guard. */}
        {editing && (
          <AccountEditForm
            accountId={editing.id}
            accountTypes={accountTypes}
            locked={editing.locked}
            initialValues={{
              name: editing.name,
              accountTypeId: editing.accountTypeId,
              description: editing.description,
              currency: editing.currency,
              initialBalance: editing.initialBalance,
            }}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={pendingArchive !== null}
        onOpenChange={handleArchiveDialogOpenChange}
        title={
          pendingArchive ? t('accounts.archiveConfirmTitle', { name: pendingArchive.name }) : ''
        }
        description={t('accounts.archiveConfirmBody')}
        confirmLabel={t('accounts.archiveAction')}
        cancelLabel={t('common.cancel')}
        pendingLabel={t('accounts.archivePending')}
        onConfirm={() => (pendingArchive ? confirmArchive(pendingArchive) : undefined)}
      />
    </>
  )
}
