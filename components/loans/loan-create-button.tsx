'use client'

import { useState } from 'react'
import type { Currency } from '@prisma/client'
import { useTranslations } from 'next-intl'
import type { DebtAccountOption } from '@/lib/ui/debt-accounts'
import { LoanForm } from '@/components/loans/loan-form'
import { Sheet } from '@/components/common/sheet'
import { Button } from '@/components/ui/button'

/**
 * The header's "Thêm khoản vay" action (spec §6.6): creation is secondary to
 * the loans already on screen, so it opens a right sheet rather than sitting
 * inline on the page.
 *
 * `today` is the page's own `todayCalendarDateInZone` reading, threaded
 * through to `LoanForm` for the start-date default (the next due date is
 * counted from it) — never `new Date()` in the browser, whose zone is not the
 * profile's. The account list and the default account are the page's too.
 */
export function LoanCreateButton({
  accounts,
  defaultAccountId,
  baseCurrency,
  today,
}: {
  accounts: ReadonlyArray<DebtAccountOption>
  /** The most recently used active account, or null. */
  defaultAccountId: string | null
  baseCurrency: Currency
  today: string
}) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t('loans.openCreate')}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('loans.createTitle')}
        description={t('loans.description')}
        closeLabel={t('common.close')}
      >
        <LoanForm
          accounts={accounts}
          defaultAccountId={defaultAccountId}
          baseCurrency={baseCurrency}
          today={today}
          onCreated={() => setOpen(false)}
        />
      </Sheet>
    </>
  )
}
