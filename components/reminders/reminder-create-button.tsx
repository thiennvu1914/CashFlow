'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Locale } from '@/lib/i18n/locale'
import { ReminderForm } from '@/components/reminders/reminder-form'
import { Sheet } from '@/components/common/sheet'
import { Button } from '@/components/ui/button'

type Category = { id: string; name: string }
type Account = { id: string; name: string }

/**
 * The header's "Thêm nhắc nhở" action (spec §6.7): creation is secondary to
 * the reminders already on screen, so it opens a right sheet rather than
 * sitting inline on the page — the same treatment `DebtCreateButton` and
 * `GoalCreateButton` already give their own forms.
 */
export function ReminderCreateButton({
  today,
  locale,
  expenseCategories,
  incomeCategories,
  accounts,
}: {
  today: string
  locale: Locale
  expenseCategories: Category[]
  incomeCategories: Category[]
  accounts: Account[]
}) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t('reminders.openCreate')}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('reminders.createTitle')}
        description={t('reminders.description')}
        closeLabel={t('common.close')}
      >
        <ReminderForm
          today={today}
          locale={locale}
          expenseCategories={expenseCategories}
          incomeCategories={incomeCategories}
          accounts={accounts}
          onCreated={() => setOpen(false)}
        />
      </Sheet>
    </>
  )
}
