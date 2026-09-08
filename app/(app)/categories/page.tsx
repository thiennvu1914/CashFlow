import { getTranslations } from 'next-intl/server'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { listAccountTypes } from '@/lib/server/services/account-type'
import { listCategories } from '@/lib/server/services/category'
import {
  createAccountTypeAction,
  archiveAccountTypeAction,
} from '@/lib/server/actions/account-type-actions'
import { createCategoryAction, archiveCategoryAction } from '@/lib/server/actions/category-actions'
import { CategoryChipList } from '@/components/categories/category-chip-list'
import { PageHeader } from '@/components/common/page-header'

export default async function CategoriesPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own rather than relying on `requireUser`.
  const user = await requireUserOrRedirect()
  const t = await getTranslations()
  const [accountTypes, expenseCategories, incomeCategories] = await Promise.all([
    listAccountTypes(user.id),
    listCategories(user.id, 'EXPENSE'),
    listCategories(user.id, 'INCOME'),
  ])

  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader title={t('categories.title')} description={t('categories.description')} />

      {/* One column, not the two-column grid this page had: the three sections
          have wildly different lengths (three account types beside twenty
          expense categories), and a grid put a short list next to a long one
          with a ragged gap between them. */}
      <div className="flex flex-col gap-8">
        <CategoryChipList
          title={t('categories.accountTypes')}
          items={accountTypes}
          addLabel={t('categories.addLabel', { section: t('categories.accountTypes') })}
          addPlaceholder={t('categories.addPlaceholder')}
          archiveLabel={t('categories.archiveAction')}
          onCreate={async (name) => {
            'use server'
            await createAccountTypeAction({ name })
          }}
          onArchive={async (id) => {
            'use server'
            await archiveAccountTypeAction(id)
          }}
        />
        <CategoryChipList
          title={t('categories.expenseCategories')}
          items={expenseCategories}
          addLabel={t('categories.addLabel', { section: t('categories.expenseCategories') })}
          addPlaceholder={t('categories.addPlaceholder')}
          archiveLabel={t('categories.archiveAction')}
          onCreate={async (name) => {
            'use server'
            await createCategoryAction({ name, type: 'EXPENSE' })
          }}
          onArchive={async (id) => {
            'use server'
            await archiveCategoryAction(id)
          }}
        />
        <CategoryChipList
          title={t('categories.incomeCategories')}
          items={incomeCategories}
          addLabel={t('categories.addLabel', { section: t('categories.incomeCategories') })}
          addPlaceholder={t('categories.addPlaceholder')}
          archiveLabel={t('categories.archiveAction')}
          onCreate={async (name) => {
            'use server'
            await createCategoryAction({ name, type: 'INCOME' })
          }}
          onArchive={async (id) => {
            'use server'
            await archiveCategoryAction(id)
          }}
        />
      </div>
    </div>
  )
}
