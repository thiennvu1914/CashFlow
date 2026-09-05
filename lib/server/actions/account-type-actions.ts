'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import * as accountTypeService from '@/lib/server/services/account-type'
import type { CreateAccountTypeInput } from '@/lib/validation/account-type'

export async function createAccountTypeAction(input: CreateAccountTypeInput) {
  const user = await requireUser()
  await accountTypeService.createAccountType(user.id, input)
  revalidatePath('/categories')
}

export async function archiveAccountTypeAction(accountTypeId: string) {
  const user = await requireUser()
  await accountTypeService.archiveAccountType(user.id, accountTypeId)
  revalidatePath('/categories')
}
