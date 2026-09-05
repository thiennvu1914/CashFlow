'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Currency } from '@prisma/client'
import {
  archiveFinancialAccountAction,
  type FinancialAccountActionError,
} from '@/lib/server/actions/financial-account-actions'
import { AccountEditForm } from '@/components/accounts/account-edit-form'
import { Button } from '@/components/ui/button'

type AccountType = { id: string; name: string }

type AccountWithBalance = {
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

const ARCHIVE_ERROR_MESSAGES: Record<FinancialAccountActionError, string> = {
  NON_ZERO_BALANCE:
    'This account must have a zero balance before it can be archived. Transfer or adjust the balance first.',
  ACCOUNT_LOCKED: 'Currency and opening balance cannot be changed once the account has activity.',
  INVALID_ACCOUNT_TYPE: 'Choose a valid account type.',
  INVALID_INPUT: 'Check the highlighted fields.',
  NOT_FOUND: 'That account no longer exists.',
}
const ARCHIVE_GENERIC_ERROR = 'Something went wrong. Please try again.'

function formatBalance(balance: string, currency: Currency): string {
  // `Number()` here is for DISPLAY ONLY — the value driving this string
  // already came out of `Prisma.Decimal` arithmetic in the balance service;
  // nothing here re-derives or stores a balance.
  return new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: currency === 'USD' ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(Number(balance))
}

export function AccountList({
  accounts,
  accountTypes,
}: {
  accounts: AccountWithBalance[]
  accountTypes: AccountType[]
}) {
  const router = useRouter()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [errorByAccountId, setErrorByAccountId] = useState<Record<string, string>>({})

  async function handleArchive(accountId: string) {
    if (!window.confirm('Archive this account?')) return
    setErrorByAccountId((prev) => {
      const next = { ...prev }
      delete next[accountId]
      return next
    })
    try {
      const result = await archiveFinancialAccountAction(accountId)
      if (!result.ok) {
        setErrorByAccountId((prev) => ({
          ...prev,
          [accountId]: ARCHIVE_ERROR_MESSAGES[result.error],
        }))
        return
      }
      router.refresh()
    } catch {
      console.error('AccountList: archive failed')
      setErrorByAccountId((prev) => ({ ...prev, [accountId]: ARCHIVE_GENERIC_ERROR }))
    }
  }

  if (accounts.length === 0) {
    return <p className="text-sm text-foreground/60">No accounts yet — add one below.</p>
  }

  return (
    <ul className="flex flex-col gap-2">
      {accounts.map((account) => {
        const isNegative = account.balance.startsWith('-')
        const isEditing = editingId === account.id
        return (
          <li key={account.id} className="rounded-md border p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{account.name}</p>
                <p className="text-sm text-foreground/60">
                  {account.accountType.name} · {account.currency}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`tabular-nums ${isNegative ? 'text-negative' : ''}`}>
                  {formatBalance(account.balance, account.currency)} {account.currency}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setEditingId(isEditing ? null : account.id)}
                >
                  {isEditing ? 'Close' : 'Edit'}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => handleArchive(account.id)}
                >
                  Archive
                </Button>
              </div>
            </div>
            {errorByAccountId[account.id] && (
              <p className="mt-2 text-sm text-negative">{errorByAccountId[account.id]}</p>
            )}
            {isEditing && (
              <div className="mt-3 border-t pt-3">
                <AccountEditForm
                  accountId={account.id}
                  accountTypes={accountTypes}
                  locked={account.locked}
                  initialValues={{
                    name: account.name,
                    accountTypeId: account.accountTypeId,
                    description: account.description,
                    currency: account.currency,
                    initialBalance: account.initialBalance,
                  }}
                  onDone={() => setEditingId(null)}
                />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
