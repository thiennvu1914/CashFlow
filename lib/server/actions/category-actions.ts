'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import * as categoryService from '@/lib/server/services/category'
import type { CreateCategoryInput } from '@/lib/validation/category'

export async function createCategoryAction(input: CreateCategoryInput) {
  const user = await requireUser()
  await categoryService.createCategory(user.id, input)
  revalidatePath('/categories')
}

export async function archiveCategoryAction(categoryId: string) {
  const user = await requireUser()
  await categoryService.archiveCategory(user.id, categoryId)
  revalidatePath('/categories')
}
