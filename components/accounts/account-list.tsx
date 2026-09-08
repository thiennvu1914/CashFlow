'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Wallet } from 'lucide-react'
import type { Currency } from '@prisma/client'
import type { Locale } from '@/lib/i18n/locale'
import { archiveFinancialAccountAction } from '@/lib/server/actions/financial-account-actions'
import { ACCOUNT_ERROR_KEYS, GENERIC_ERROR_KEY } from '@/lib/ui/action-error-messages'
import { formatMoney } from '@/lib/ui/format-money'
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

  async function confirmArchive(account: AccountRow) {
    setErrorByAccountId((prev) => {
      const next = { ...prev }
      delete next[account.id]
      return next
    })
    try {
      const result = await archiveFinancialAccountAction(account.id)
      if (!result.ok) {
        setErrorByAccountId((prev) => ({
          ...prev,
          [account.id]: t(ACCOUNT_ERROR_KEYS[result.error]),
        }))
        return
      }
      setPendingArchive(null)
      router.refresh()
    } catch {
      console.error('AccountList: archive failed')
      setErrorByAccountId((prev) => ({ ...prev, [account.id]: t(GENERIC_ERROR_KEY) }))
    }
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
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <ul className="divide-y divide-border">
          {accounts.map((account) => {
            const isNegative = account.balance.startsWith('-')
            return (
              <FinancialListRow
                key={account.id}
                title={account.name}
                meta={`${account.accountType.name} · ${account.currency}`}
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
                        onSelect: () => setPendingArchive(account),
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
        onOpenChange={(open) => !open && setPendingArchive(null)}
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
