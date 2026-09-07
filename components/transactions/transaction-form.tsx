'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type { Currency } from '@prisma/client'
import {
  createTransactionFormSchema,
  type CreateTransactionFormInput,
  type CreateTransactionInput,
} from '@/lib/validation/transaction'
import { createTransactionAction } from '@/lib/server/actions/transaction-actions'
import { GENERIC_ERROR_MESSAGE, TRANSACTION_ERROR_MESSAGES } from '@/lib/ui/action-error-messages'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { nowInZone } from '@/lib/datetime/local-date-time'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type TransactionType = CreateTransactionInput['type']

/**
 * The form validates and submits `createTransactionFormSchema`, whose `date`
 * is the raw `yyyy-MM-ddTHH:mm` string the `<input type="datetime-local">`
 * produced — input and output types are the same here, so no `Date` ever
 * exists client-side.
 *
 * That is deliberate: a local date and time only becomes an instant once a
 * timezone is chosen, and the browser's zone is not necessarily the user's
 * configured zone. `createTransactionAction` does the conversion in the
 * session user's IANA zone; see `lib/datetime/local-date-time.ts`.
 */
type FormInput = CreateTransactionFormInput

type Account = { id: string; name: string; currency: Currency }
type Category = { id: string; name: string; type: 'INCOME' | 'EXPENSE' }

/**
 * The two types that hit the P&L and therefore need a matching category
 * (mirrors `CATEGORY_REQUIRED_TYPES` in `lib/validation/transaction.ts`).
 *
 * This decides only whether the Category `<select>` is *rendered*. Clearing
 * the chosen category is deliberately not conditioned on it: the type's own
 * `onChange` clears on every change, so INCOME→EXPENSE — both category-
 * requiring, so this set never changes across it — cannot leave an INCOME
 * category attached to an EXPENSE transaction.
 */
const CATEGORY_REQUIRED_TYPES = new Set<TransactionType>(['INCOME', 'EXPENSE'])

const DEFAULT_TYPE: TransactionType = 'EXPENSE'

function defaultValues(accounts: Account[], timezone: string): FormInput {
  return {
    accountId: accounts[0]?.id ?? '',
    categoryId: undefined,
    type: DEFAULT_TYPE,
    date: nowInZone(timezone),
    amount: 0,
    note: undefined,
  }
}

export function TransactionForm({
  accounts,
  categories,
  timezone,
}: {
  accounts: Account[]
  categories: Category[]
  /**
   * The session user's IANA timezone (`resolveProfileDefaults(user).timezone`
   * from the page) — the pre-filled date and time must be *their* now, not
   * whatever the clock happens to read in UTC at the moment they open the
   * form.
   */
  timezone: string
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  /** See the `<fieldset>` below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormInput>({
    resolver: zodResolver(createTransactionFormSchema),
    defaultValues: defaultValues(accounts, timezone),
  })

  const type = useWatch({ control, name: 'type' })
  const accountId = useWatch({ control, name: 'accountId' })
  const needsCategory = CATEGORY_REQUIRED_TYPES.has(type)
  const relevantCategories = categories.filter((c) => c.type === type)
  const selectedAccount = accounts.find((a) => a.id === accountId)

  async function onSubmit(values: FormInput) {
    setError(null)
    try {
      const result = await createTransactionAction(values)
      if (!result.ok) {
        setError(TRANSACTION_ERROR_MESSAGES[result.error])
        return
      }
      reset(defaultValues(accounts, timezone))
      router.refresh()
    } catch {
      console.error('TransactionForm: create failed')
      setError(GENERIC_ERROR_MESSAGE)
    }
  }

  /**
   * With no account there is nothing to add a transaction *to*, so the form is
   * replaced rather than shown half-usable: an Account `<select>` with no
   * options looks operable, and submitting it only produced a validation error
   * under a field the user could never fill.
   *
   * This lives in the component, not only in the page, on purpose. Any caller
   * that hands over an empty `accounts` list must get a usable screen — the
   * page cannot be the only place that knows this, or the next caller
   * reintroduces the empty selector. The page's job stays what it already is:
   * passing `listActiveFinancialAccounts`, so an archived account never counts
   * as one the user could pick.
   *
   * Placed after every hook above, deliberately: an early return before them
   * would call a different number of hooks depending on the prop.
   */
  if (accounts.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-md border border-border bg-surface p-4">
        <p className="text-sm text-muted-foreground">
          You need an account before you can add a transaction.
        </p>
        <Link href="/accounts" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          Go to Accounts
        </Link>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* The hydration gate. Until `useHydrated()` flips, every control here is
          natively disabled, so there is no window in which the form accepts
          input it is about to throw away — see `lib/ui/use-hydrated.ts` for the
          react-hook-form/React interaction that made early input vanish, and
          for why this can never re-enable before RHF's refs have attached.

          A `<fieldset disabled>` rather than a per-control `disabled` prop: it
          is the one native mechanism that disables *everything* inside it,
          submit button included, and `:disabled` matches those descendants, so
          the existing `disabled:` styles on `Input`/`Button` apply with no new
          CSS, no spinner and no extra text. The form's own layout classes moved
          here because the fieldset is now the flex container; `min-w-0`
          neutralises a fieldset's default `min-inline-size: min-content`, and
          Tailwind's preflight already zeroes its margin/padding/border — so
          nothing shifts when the gate lifts. */}
      <fieldset
        disabled={!hydrated}
        aria-busy={hydrated ? undefined : true}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="sr-only">Transaction details</legend>
        <div>
          {/* `defaultValue` (never `value` — that would make this controlled)
              so the SERVER renders `selected` on the option the client is about
              to own. Without it `register()` emits no default at all and the
              browser shows the first option, Income, while the form state and
              the Category list below are already EXPENSE. */}
          <select
            {...register('type', {
              // Runs after react-hook-form has stored the new type
              // (`index.esm.mjs:2768` sets `_formValues`, then `:2776-2778`
              // calls this), so the category is cleared on EVERY type change —
              // INCOME→EXPENSE included, which the previous
              // `needsCategory`-watching effect missed, leaving an INCOME
              // category in form state under an EXPENSE transaction until the
              // server rejected it. `undefined` (not `''`) is what lets the
              // schema's friendly refine message fire; the `<select>` falls
              // back to its placeholder either way.
              onChange: () => setValue('categoryId', undefined),
            })}
            defaultValue={DEFAULT_TYPE}
            aria-label="Transaction type"
            className="rounded-md border p-2"
          >
            <option value="INCOME">Income</option>
            <option value="EXPENSE">Expense</option>
            <option value="CASH_IN">Cash In (other)</option>
            <option value="CASH_OUT">Cash Out (other)</option>
            <option value="ADJUSTMENT_INCREASE">Balance Adjustment — increase</option>
            <option value="ADJUSTMENT_DECREASE">Balance Adjustment — decrease</option>
          </select>
          {errors.type && <p className="text-sm text-negative">{errors.type.message}</p>}
        </div>
        <div>
          {/* Exactly the `accounts` prop — the page passes
              `listActiveFinancialAccounts`, so this list is the user's own
              ACTIVE accounts and nothing else; the component filters nothing
              itself. No `defaultValue` is needed: the form default is
              `accounts[0]`, which is already the first option the browser
              selects on its own. */}
          <select {...register('accountId')} aria-label="Account" className="rounded-md border p-2">
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {/* Rendered verbatim from the schema (`lib/validation/transaction.ts`),
              which is why no message is hard-coded here: one place owns the
              wording, and the server re-parses the same schema. */}
          {errors.accountId && <p className="text-sm text-negative">{errors.accountId.message}</p>}
        </div>
        {needsCategory && (
          <div>
            <select
              {...register('categoryId', {
                // An emptied/untouched select's DOM value is `""` (the
                // placeholder option) — converting that to `undefined` here is
                // what lets the schema's friendly "Category is required for
                // income and expense transactions" refine message fire,
                // instead of the generic "at least 1 character" message a
                // stray `""` would otherwise trigger.
                setValueAs: (v: string) => (v === '' ? undefined : v),
              })}
              aria-label="Category"
              defaultValue=""
              className="rounded-md border p-2"
            >
              <option value="">Select a category</option>
              {relevantCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {errors.categoryId && (
              <p className="text-sm text-negative">{errors.categoryId.message}</p>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Input
            type="number"
            step="0.01"
            aria-label="Amount"
            placeholder="Amount"
            {...register('amount', { valueAsNumber: true })}
          />
          {/* Read-only: currency always follows the selected account, so the
             client never sends it — this is display only. */}
          <span className="text-sm text-foreground/60">{selectedAccount?.currency ?? ''}</span>
        </div>
        {errors.amount && <p className="text-sm text-negative">{errors.amount.message}</p>}
        <div>
          <Input type="datetime-local" aria-label="Date & time" {...register('date')} />
          {errors.date && <p className="text-sm text-negative">{errors.date.message}</p>}
        </div>
        <div>
          <Input placeholder="Note (optional)" aria-label="Note" {...register('note')} />
          {errors.note && <p className="text-sm text-negative">{errors.note.message}</p>}
        </div>
        <Button type="submit" disabled={isSubmitting}>
          Add transaction
        </Button>
        {error && (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}
      </fieldset>
    </form>
  )
}
