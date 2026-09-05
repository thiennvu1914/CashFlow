'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import * as accountService from '@/lib/server/services/financial-account'
import type {
  CreateFinancialAccountInput,
  UpdateFinancialAccountInput,
} from '@/lib/validation/financial-account'

export async function createFinancialAccountAction(input: CreateFinancialAccountInput) {
  const user = await requireUser()
  await accountService.createFinancialAccount(user.id, input)
  revalidatePath('/accounts')
}

export async function updateFinancialAccountAction(
  accountId: string,
  input: UpdateFinancialAccountInput,
) {
  const user = await requireUser()
  await accountService.updateFinancialAccount(user.id, accountId, input)
  revalidatePath('/accounts')
}
