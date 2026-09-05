import { prisma } from '@/lib/prisma'
import { createAccountTypeSchema, type CreateAccountTypeInput } from '@/lib/validation/account-type'

export async function listAccountTypes(userId: string) {
  return prisma.accountType.findMany({
    where: { userId, status: 'ACTIVE' },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  })
}

export async function createAccountType(userId: string, input: CreateAccountTypeInput) {
  const parsed = createAccountTypeSchema.parse(input)
  return prisma.accountType.create({
    data: { userId, name: parsed.name, icon: parsed.icon, isDefault: false },
  })
}

export async function archiveAccountType(userId: string, accountTypeId: string) {
  return prisma.accountType.update({
    where: { userId_id: { userId, id: accountTypeId } },
    data: { status: 'ARCHIVED' },
  })
}
