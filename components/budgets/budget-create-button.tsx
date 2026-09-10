'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { BudgetForm } from '@/components/budgets/budget-form'
import { Sheet } from '@/components/common/sheet'
import { Button } from '@/components/ui/button'

type Category = { id: string; name: string }

/**
 * The header's "Thêm ngân sách" action (spec §6.5): creation is secondary to
 * the month's own rows, so it opens a right sheet rather than sitting inline
 * on the page (as `BudgetForm` used to, under an "Add budget" `h2`).
 *
 * `key` (set by the caller, `app/(app)/budgets/page.tsx`) stays on THIS
 * component, not on `BudgetForm` alone: it is what rebuilds every per-month
 * default — the scope `overallExists` picks, a category already chosen — when
 * the selected month changes, exactly as it did when the form sat inline.
 */
export function BudgetCreateButton({
  year,
  month,
  categories,
  overallExists,
}: {
  year: number
  month: number
  categories: Category[]
  overallExists: boolean
}) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t('budgets.openCreate')}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('budgets.createTitle')}
        closeLabel={t('common.close')}
      >
        <BudgetForm
          year={year}
          month={month}
          categories={categories}
          overallExists={overallExists}
          onCreated={() => setOpen(false)}
        />
      </Sheet>
    </>
  )
}
