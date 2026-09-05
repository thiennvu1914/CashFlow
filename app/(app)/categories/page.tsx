import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { listAccountTypes } from '@/lib/server/services/account-type'
import { listCategories } from '@/lib/server/services/category'
import {
  createAccountTypeAction,
  archiveAccountTypeAction,
} from '@/lib/server/actions/account-type-actions'
import { createCategoryAction, archiveCategoryAction } from '@/lib/server/actions/category-actions'
import { NamedListManager } from '@/components/categories/named-list-manager'

export default async function CategoriesPage() {
  // A layout is not an auth boundary (see the note in `app/(app)/settings/page.tsx`),
  // so this page redirects on its own rather than relying on `requireUser`.
  const user = await requireUserOrRedirect()
  const [accountTypes, expenseCategories, incomeCategories] = await Promise.all([
    listAccountTypes(user.id),
    listCategories(user.id, 'EXPENSE'),
    listCategories(user.id, 'INCOME'),
  ])

  return (
    <div className="mx-auto grid max-w-3xl gap-8 p-6 md:grid-cols-2">
      <NamedListManager
        title="Account Types"
        items={accountTypes}
        onCreate={async (name) => {
          'use server'
          await createAccountTypeAction({ name })
        }}
        onArchive={async (id) => {
          'use server'
          await archiveAccountTypeAction(id)
        }}
      />
      <NamedListManager
        title="Expense Categories"
        items={expenseCategories}
        onCreate={async (name) => {
          'use server'
          await createCategoryAction({ name, type: 'EXPENSE' })
        }}
        onArchive={async (id) => {
          'use server'
          await archiveCategoryAction(id)
        }}
      />
      <NamedListManager
        title="Income Categories"
        items={incomeCategories}
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
  )
}
